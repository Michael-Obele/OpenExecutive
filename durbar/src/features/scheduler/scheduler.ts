/**
 * The scheduler — what makes this proactive rather than a question-answering box.
 *
 * Port of `scheduler/runner.py` + the `scheduled_actions` store. Four semantics
 * carry the weight, and each is easy to get subtly wrong:
 *
 *   1. **Claim is atomic and increments `attempts`.** `UPDATE ... RETURNING`
 *      flips rows to 'running' in one statement, so a second tick cannot
 *      re-claim them. The increment happens *at claim time*, which is what makes
 *      the backoff map in (3) line up with its keys.
 *
 *   2. **A deferral is not a failure.** If an action cannot run yet — no
 *      principal configured, say — it is rescheduled and the claim's increment
 *      is *undone*. Without that, repeated deferrals would exhaust the attempt
 *      budget before the action ever dispatched, so it would fail permanently on
 *      its first real attempt.
 *
 *   3. **Failure backs off, then gives up.** 30s, then 5m, then 'failed' at
 *      `maxAttempts`. A permanently broken action must not retry forever.
 *
 *   4. **Recurrence is chaining, not cron.** A daily brief delivers, then
 *      enqueues its own next occurrence. There is no cron expression anywhere,
 *      which means the schedule is data rather than code and a missed day cannot
 *      drift the series.
 *
 * Crash recovery is the fifth: a row left in 'running' by a killed process is
 * swept back to 'pending' at startup, or it would be stuck forever.
 */

import type { Db } from '../../db.ts';
import type { Provider } from '../../providers.ts';
import { runMorningBrief } from '../briefings/morning-brief.ts';
import { runEndOfDayDigest } from '../briefings/end-of-day-digest.ts';
import { runExecutiveReflection } from '../workflows/executive-reflection.ts';
import { runExecutiveResearch } from '../workflows/executive-research.ts';

export interface ScheduledAction {
  readonly id: number;
  readonly created_at: string;
  readonly run_at: string;
  readonly channel: string;
  readonly channel_ref: string;
  readonly intent_text: string;
  readonly originating_session_id: string | null;
  readonly status: string;
  readonly attempts: number;
  readonly last_error: string;
  readonly department: string;
  readonly session_id: string;
  readonly kind: string;
  readonly assigned_to_person_id: number | null;
  readonly awaiting_response_since: string | null;
  readonly scope_key: string | null;
  readonly required_scope: string | null;
}

export interface NewAction {
  readonly runAt: string;
  readonly kind: string;
  readonly intentText: string;
  readonly channel?: string;
  readonly channelRef?: string;
  readonly originatingSessionId?: string;
  readonly scopeKey?: string;
}

/** Backoff between attempts, keyed by the attempt count *after* claiming. */
export const BACKOFF_SECONDS: Readonly<Record<number, number>> = {
  1: 30,
  2: 300,
};

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_BATCH_SIZE = 10;

/** Longest an error is stored for; a traceback should not bloat the row. */
const MAX_ERROR_CHARS = 500;

export type RetryOutcome = 'pending' | 'failed' | 'missing';

// ── store ────────────────────────────────────────────────────────────────────

/**
 * Returns rows left in 'running' by a process that died mid-dispatch.
 *
 * Called once at startup. Without it a crash during dispatch strands the row in
 * 'running' permanently, since only 'pending' rows are ever claimed.
 */
export function sweepStale(db: Db): number {
  const result = db.run(
    `UPDATE scheduled_actions SET status = 'pending' WHERE status = 'running'`,
  );
  return result.changes;
}

/**
 * Atomically claims up to `limit` due actions, oldest first.
 *
 * `attempts` is incremented here rather than on failure — see the module note.
 */
export function claimDue(db: Db, now: Date, limit = DEFAULT_BATCH_SIZE): ScheduledAction[] {
  const claimed = db
    .query<ScheduledAction, [string, number]>(
      `UPDATE scheduled_actions
          SET status = 'running', attempts = attempts + 1
        WHERE id IN (
          SELECT id FROM scheduled_actions
           WHERE status = 'pending' AND run_at <= ?
           ORDER BY run_at
           LIMIT ?
        )
        RETURNING *`,
    )
    .all(now.toISOString(), limit);

  // Sorted in code, not relied on from SQL: `RETURNING` does not promise to
  // preserve the subquery's ORDER BY, so the batch order is unspecified
  // otherwise. Oldest-first is what makes a backlog drain predictably.
  return claimed.sort((a, b) => a.run_at.localeCompare(b.run_at));
}

export function markDone(db: Db, id: number): void {
  db.run(`UPDATE scheduled_actions SET status = 'done' WHERE id = ?`, [id]);
}

/**
 * Defer an action to a new time **without** spending an attempt.
 *
 * The `MAX(0, attempts - 1)` undoes the increment `claimDue` applied, floored so
 * a double-deferral cannot drive the counter negative.
 */
export function reschedule(db: Db, id: number, runAt: Date): boolean {
  const result = db.run(
    `UPDATE scheduled_actions
        SET status = 'pending', run_at = ?, attempts = MAX(0, attempts - 1)
      WHERE id = ? AND status = 'running'`,
    [runAt.toISOString(), id],
  );
  return result.changes > 0;
}

/** Reschedule with backoff, or give up once attempts are exhausted. */
export function markFailedOrRetry(
  db: Db,
  id: number,
  error: string,
  maxAttempts = DEFAULT_MAX_ATTEMPTS,
  now: Date = new Date(),
): RetryOutcome {
  const row = db
    .query<{ attempts: number }, [number]>(
      'SELECT attempts FROM scheduled_actions WHERE id = ?',
    )
    .get(id);
  if (row === null) return 'missing';

  const message = error.slice(0, MAX_ERROR_CHARS);

  if (row.attempts >= maxAttempts) {
    db.run(
      `UPDATE scheduled_actions SET status = 'failed', last_error = ? WHERE id = ?`,
      [message, id],
    );
    return 'failed';
  }

  // Unknown attempt counts fall back to the longest backoff: retrying too
  // slowly is recoverable, retrying too fast hammers a failing dependency.
  const backoff = BACKOFF_SECONDS[row.attempts] ?? 1800;
  const nextRun = new Date(now.getTime() + backoff * 1000);

  db.run(
    `UPDATE scheduled_actions
        SET status = 'pending', run_at = ?, last_error = ?
      WHERE id = ?`,
    [nextRun.toISOString(), message, id],
  );
  return 'pending';
}

export function scheduleAction(db: Db, action: NewAction, now = new Date()): number {
  const result = db.run(
    `INSERT INTO scheduled_actions
       (created_at, run_at, channel, channel_ref, intent_text,
        originating_session_id, kind, scope_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      now.toISOString(),
      action.runAt,
      action.channel ?? '__internal__',
      action.channelRef ?? '',
      action.intentText,
      action.originatingSessionId ?? null,
      action.kind,
      action.scopeKey ?? null,
    ],
  );
  return Number(result.lastInsertRowid);
}

export function pendingActions(db: Db, kind?: string): ScheduledAction[] {
  if (kind === undefined) {
    return db
      .query<ScheduledAction, []>(
        `SELECT * FROM scheduled_actions WHERE status IN ('pending', 'running')
          ORDER BY run_at`,
      )
      .all();
  }
  return db
    .query<ScheduledAction, [string]>(
      `SELECT * FROM scheduled_actions WHERE status IN ('pending', 'running') AND kind = ?
        ORDER BY run_at`,
    )
    .all(kind);
}

// ── daily recurrence ─────────────────────────────────────────────────────────

/** Parses 'HH:MM', falling back when absent or malformed. */
export function parseHhmm(spec: string | undefined, fallback: string): [number, number] {
  const match = (spec ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return parseHhmm(fallback, '00:00');

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return parseHhmm(fallback, '00:00');
  return [hours, minutes];
}

/**
 * The next occurrence of `hh:mm` **strictly after** `now`.
 *
 * Strictly, not "at or after": firing exactly on the boundary would re-fire the
 * same moment repeatedly, and a brief delivered twice reads as a bug.
 */
export function nextOccurrence(now: Date, hh: number, mm: number): Date {
  const candidate = new Date(now);
  candidate.setUTCHours(hh, mm, 0, 0);
  if (candidate.getTime() <= now.getTime()) {
    candidate.setUTCDate(candidate.getUTCDate() + 1);
  }
  return candidate;
}

/**
 * Seeds a daily action if one is not already outstanding.
 *
 * The dedupe is the point: seeding runs at every startup, and without a
 * "is one already pending" check a restart would stack a second brief for the
 * same morning.
 */
export function seedDaily(
  db: Db,
  kind: string,
  hhmm: string,
  now = new Date(),
): number | null {
  if (pendingActions(db, kind).length > 0) return null;

  const [hh, mm] = parseHhmm(hhmm, '08:00');
  return scheduleAction(
    db,
    {
      runAt: nextOccurrence(now, hh, mm).toISOString(),
      kind,
      intentText: `Daily ${kind.replace(/_/g, ' ')}`,
    },
    now,
  );
}

/** Enqueues the next day's occurrence. This is how recurrence happens. */
export function chainDaily(db: Db, kind: string, after: Date, hhmm: string): number {
  const [hh, mm] = parseHhmm(hhmm, '08:00');
  return scheduleAction(db, {
    runAt: nextOccurrence(after, hh, mm).toISOString(),
    kind,
    intentText: `Daily ${kind.replace(/_/g, ' ')}`,
  });
}

// ── dispatch ─────────────────────────────────────────────────────────────────

export interface SchedulerDeps {
  readonly db: Db;
  readonly provider: Provider;
  readonly morningTime?: string;
  readonly eodTime?: string;
  readonly reflectionTime?: string;
  readonly maxAttempts?: number;
  readonly batchSize?: number;
  readonly now?: () => Date;
}

export const PRINCIPAL_BRIEF_MORNING = 'principal_brief_morning';
export const PRINCIPAL_BRIEF_EOD = 'principal_brief_eod';
export const EXECUTIVE_REFLECTION = 'executive_reflection';
export const WATCHLIST_RESEARCH = 'watchlist_research_scan';

export const DEFAULT_MORNING_TIME = '08:00';
export const DEFAULT_EOD_TIME = '18:00';
export const DEFAULT_REFLECTION_TIME = '07:30';

export type ActionHandler = (
  action: ScheduledAction,
  deps: SchedulerDeps,
) => Promise<{ status: string }>;

/** True when a non-archived principal exists to deliver to. */
function hasPrincipal(db: Db): boolean {
  const row = db
    .query<{ n: number }, []>(
      'SELECT COUNT(*) AS n FROM people WHERE is_principal = 1 AND archived = 0',
    )
    .get();
  return (row?.n ?? 0) > 0;
}

/**
 * Handlers, keyed by `kind`.
 *
 * The brief handlers defer rather than failing when there is no principal: a
 * fresh install has no roster yet, and that is a "not yet", not an error. The
 * deferral is an hour rather than a day so the first brief after onboarding
 * arrives promptly instead of waiting for tomorrow.
 */
export const HANDLERS: Readonly<Record<string, ActionHandler>> = {
  [PRINCIPAL_BRIEF_MORNING]: async (action, deps) => {
    if (!hasPrincipal(deps.db)) {
      reschedule(deps.db, action.id, new Date(Date.now() + 60 * 60 * 1000));
      return { status: 'deferred' };
    }

    const result = await runMorningBrief(
      {},
      { db: deps.db, provider: deps.provider, now: deps.now ?? (() => new Date()) },
    );

    // Chain the next occurrence only after a successful delivery, so a failed
    // day does not silently skip tomorrow's brief.
    chainDaily(
      deps.db,
      action.kind,
      deps.now?.() ?? new Date(),
      deps.morningTime ?? DEFAULT_MORNING_TIME,
    );

    return { status: result.suppressed ? 'suppressed' : 'sent' };
  },

  [PRINCIPAL_BRIEF_EOD]: async (action, deps) => {
    if (!hasPrincipal(deps.db)) {
      reschedule(deps.db, action.id, new Date(Date.now() + 60 * 60 * 1000));
      return { status: 'deferred' };
    }

    const result = await runEndOfDayDigest(
      {},
      { db: deps.db, provider: deps.provider, now: deps.now ?? (() => new Date()) },
    );

    chainDaily(
      deps.db,
      action.kind,
      deps.now?.() ?? new Date(),
      deps.eodTime ?? DEFAULT_EOD_TIME,
    );

    return { status: result.suppressed ? 'suppressed' : 'sent' };
  },

  [EXECUTIVE_REFLECTION]: async (action, deps) => {
    const result = await runExecutiveReflection(
      {},
      { db: deps.db, provider: deps.provider, now: deps.now ?? (() => new Date()) },
    );

    chainDaily(
      deps.db,
      action.kind,
      deps.now?.() ?? new Date(),
      DEFAULT_REFLECTION_TIME,
    );

    // Reflection always produces an artifact — never suppressed.
    void result;
    return { status: 'sent' };
  },

  [WATCHLIST_RESEARCH]: async (action, deps) => {
    const result = await runExecutiveResearch(
      {},
      { db: deps.db, provider: deps.provider, now: deps.now ?? (() => new Date()) },
    );

    // Research is periodic, not daily — chain at the same interval.
    // For Durbar, treat it as daily chaining (the interval is not yet
    // configurable; the scheduler's daily chain is the simplest correct
    // recurrence for now).
    chainDaily(
      deps.db,
      action.kind,
      deps.now?.() ?? new Date(),
      DEFAULT_MORNING_TIME,
    );

    void result;
    return { status: 'sent' };
  },
};

/**
 * Claims and dispatches everything due. Returns how many ran.
 *
 * Handler errors are contained: one broken action must not stop the batch.
 */
export async function runDue(deps: SchedulerDeps): Promise<number> {
  const now = deps.now?.() ?? new Date();
  const claimed = claimDue(deps.db, now, deps.batchSize ?? DEFAULT_BATCH_SIZE);

  let ran = 0;
  for (const action of claimed) {
    const handler = HANDLERS[action.kind];

    if (handler === undefined) {
      // An unknown kind is a bug, not a transient condition — but it still goes
      // through the retry path so it cannot silently vanish.
      markFailedOrRetry(
        deps.db,
        action.id,
        `no handler registered for kind "${action.kind}"`,
        deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        now,
      );
      continue;
    }

    try {
      const result = await handler(action, deps);
      if (result.status === 'deferred') {
        // The handler already moved the row back to 'pending'. Marking it done
        // here would lose the action, and counting it as dispatched would
        // misreport a tick that did nothing.
        continue;
      }
      markDone(deps.db, action.id);
      ran += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const outcome = markFailedOrRetry(
        deps.db,
        action.id,
        message,
        deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS,
        now,
      );
      console.error(`scheduled action ${action.id} (${action.kind}) → ${outcome}: ${message}`);
    }
  }

  return ran;
}

export interface SchedulerHandle {
  stop(): void;
  /** Exposed so a test or a manual trigger can run one tick. */
  tick(): Promise<number>;
}

/**
 * Runs `runDue` on an interval.
 *
 * A tick that outlives its interval must not overlap the next one — two
 * concurrent ticks could both claim and dispatch, which for a brief means
 * sending it twice. The `busy` guard makes ticks serial.
 */
export function startScheduler(
  deps: SchedulerDeps,
  intervalMs = 60_000,
): SchedulerHandle {
  sweepStale(deps.db);

  let busy = false;
  const tick = async (): Promise<number> => {
    if (busy) return 0;
    busy = true;
    try {
      return await runDue(deps);
    } finally {
      busy = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Do not hold the process open just for the scheduler.
  timer.unref?.();

  return { stop: () => clearInterval(timer), tick };
}

/**
 * Spec for `morning_brief`.
 *
 * Ported from the behaviour of `tests/` + `workflows/morning_brief.py`. The
 * cases that matter are the ones a rewrite drops without noticing: the
 * delivered-brief watermark, and the exclusion of monitoring noise.
 */

import { describe, expect, test } from 'bun:test';
import { openDb, type Db } from '../../db.ts';
import type { ChatMessage, ChatOptions, Provider } from '../../providers.ts';
import {
  BRIEF_KIND,
  gatherContext,
  isQuiet,
  renderContext,
  runMorningBrief,
  sinceFor,
} from './morning-brief.ts';

/** Records what it was asked, so tests can assert on the prompt. */
function fakeProvider(reply = 'A brief.'): Provider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: 'fake',
    defaultModel: 'fake-model',
    calls,
    async chat(messages: readonly ChatMessage[], _options?: ChatOptions) {
      calls.push([...messages]);
      return reply;
    },
  };
}

function seedDepartment(db: Db, slug: string, title: string): void {
  db.run(
    `INSERT INTO departments (slug, title, updated_at) VALUES (?, ?, ?)`,
    [slug, title, new Date().toISOString()],
  );
}

function seedGoal(
  db: Db,
  slug: string,
  keyResult: string,
  status = 'at_risk',
  current = '',
): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO department_goals
       (department_slug, period_value, key_result, target, current, status, created_at, updated_at)
     VALUES (?, 'Q1', ?, 'a target', ?, ?, ?, ?)`,
    [slug, keyResult, current, status, now, now],
  );
}

function seedAlert(db: Db, source: string, headline: string): void {
  db.run(
    `INSERT INTO alerts (source, severity, headline, body, status, created_at)
     VALUES (?, 'high', ?, 'body', 'unread', ?)`,
    [source, headline, new Date().toISOString()],
  );
}

function seedActivity(db: Db, summary: string, ts: string): void {
  db.run(
    `INSERT INTO audit_log (ts, event_type, summary) VALUES (?, 'tool_invocation', ?)`,
    [ts, summary],
  );
}

describe('sinceFor', () => {
  test('falls back to a 24h window on a cold store', () => {
    const db = openDb();
    const now = new Date('2026-09-20T08:00:00.000Z');
    expect(sinceFor(db, BRIEF_KIND, now)).toBe('2026-09-19T08:00:00.000Z');
  });

  test('uses the last delivered brief, not a fixed window', () => {
    const db = openDb();
    db.run(
      `INSERT INTO briefing_narrative (scope, input_hash, narrative_text, generated_at)
       VALUES (?, '0', 'previous', '2026-09-20T07:30:00.000Z')`,
      [BRIEF_KIND],
    );
    // A `now` 6 days later must not widen the window — the brief was delivered.
    const now = new Date('2026-09-26T08:00:00.000Z');
    expect(sinceFor(db, BRIEF_KIND, now)).toBe('2026-09-20T07:30:00.000Z');
  });
});

describe('gatherContext', () => {
  test('collects at-risk goals with their department title', () => {
    const db = openDb();
    seedDepartment(db, 'marketing', 'Marketing');
    seedGoal(db, 'marketing', 'Post on three platforms', 'at_risk', 'Bluesky only');

    const context = gatherContext(db, '1970-01-01T00:00:00.000Z');
    expect(context.atRiskGoals).toHaveLength(1);
    expect(context.atRiskGoals[0]?.department).toBe('Marketing');
    expect(context.atRiskGoals[0]?.current).toBe('Bluesky only');
  });

  test('excludes monitoring and watchlist findings from proposals', () => {
    const db = openDb();
    seedAlert(db, 'monitoring', 'Competitor shipped a feature');
    seedAlert(db, 'watchlist', 'New signal on Acme');
    seedAlert(db, 'goal_review', 'Marketing goal slipped');

    const context = gatherContext(db, '1970-01-01T00:00:00.000Z');
    expect(context.proposals).toHaveLength(1);
    expect(context.proposals[0]?.headline).toBe('Marketing goal slipped');
  });

  test('only reports activity inside the window', () => {
    const db = openDb();
    seedActivity(db, 'old', '2026-09-01T00:00:00.000Z');
    seedActivity(db, 'new', '2026-09-20T00:00:00.000Z');

    const context = gatherContext(db, '2026-09-19T00:00:00.000Z');
    expect(context.activity.map((a) => a.summary)).toEqual(['new']);
  });

  test('ignores alerts that have been read', () => {
    const db = openDb();
    seedAlert(db, 'goal_review', 'Already handled');
    db.run(`UPDATE alerts SET status = 'read'`);

    expect(gatherContext(db, '1970-01-01T00:00:00.000Z').proposals).toHaveLength(0);
  });
});

describe('renderContext', () => {
  test('states "none" rather than emitting an empty section', () => {
    const db = openDb();
    const rendered = renderContext(gatherContext(db, '1970-01-01T00:00:00.000Z'), '2026-09-20');
    expect(rendered).toContain('AT-RISK GOALS (0)');
    expect(rendered).toContain('- none');
  });
});

describe('runMorningBrief', () => {
  test('sends the gathered context to the model and returns its narrative', async () => {
    const db = openDb();
    seedDepartment(db, 'finance', 'Finance');
    seedGoal(db, 'finance', 'Close the books', 'off_track');
    const provider = fakeProvider('Finance is off track.');

    const result = await runMorningBrief(
      { periodLabel: '2026-09-20' },
      { db, provider, now: () => new Date('2026-09-20T08:00:00.000Z') },
    );

    expect(result.narrative).toBe('Finance is off track.');
    expect(result.suppressed).toBe(false);
    expect(provider.calls).toHaveLength(1);

    const [system, user] = provider.calls[0] ?? [];
    expect(system?.role).toBe('system');
    expect(user?.content).toContain('Close the books');
    // The machinery must never be exposed to the reader.
    expect(system?.content).toContain('Never mention tools');
  });

  test('suppresses to one line when nothing changed', async () => {
    const db = openDb();
    const provider = fakeProvider('should not be called');

    const result = await runMorningBrief({}, { db, provider });

    expect(result.suppressed).toBe(true);
    expect(result.narrative).toBe('Nothing new since the last brief.');
    expect(provider.calls).toHaveLength(0);
  });

  test('forceFull renders the brief even when nothing changed', async () => {
    const db = openDb();
    const provider = fakeProvider('Full brief.');

    const result = await runMorningBrief({ forceFull: true }, { db, provider });

    expect(result.suppressed).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  test('persists the run and advances the watermark', async () => {
    const db = openDb();
    seedDepartment(db, 'legal', 'Legal');
    seedGoal(db, 'legal', 'Review the contract');
    const at = new Date('2026-09-20T08:00:00.000Z');

    const result = await runMorningBrief(
      {},
      { db, provider: fakeProvider('Legal needs you.'), now: () => at },
    );

    const run = db
      .query<{ workflow_name: string; status: string; artifact: string }, [string]>(
        'SELECT workflow_name, status, artifact FROM workflow_runs WHERE run_id = ?',
      )
      .get(result.runId);
    expect(run?.workflow_name).toBe('morning_brief');
    expect(run?.status).toBe('succeeded');
    expect(run?.artifact).toBe('Legal needs you.');

    // The next run must see this delivery as its window start.
    expect(sinceFor(db, BRIEF_KIND)).toBe(at.toISOString());
  });

  test('does not repeat activity that predates the last delivered brief', async () => {
    const db = openDb();
    seedDepartment(db, 'hr', 'People');
    seedGoal(db, 'hr', 'Hire a designer');
    seedActivity(db, 'sent a nudge', '2026-09-20T07:00:00.000Z');

    const first = await runMorningBrief(
      {},
      { db, provider: fakeProvider('First.'), now: () => new Date('2026-09-20T08:00:00.000Z') },
    );
    expect(first.suppressed).toBe(false);

    // Nothing new was written, and the window now starts at the first brief.
    const second = await runMorningBrief(
      {},
      { db, provider: fakeProvider('Second.'), now: () => new Date('2026-09-20T09:00:00.000Z') },
    );
    // The goal is still at risk, so the brief is NOT quiet — the point is that
    // the activity from before the watermark must not be re-reported.
    expect(second.suppressed).toBe(false);
    expect(gatherContext(db, sinceFor(db, BRIEF_KIND)).activity).toHaveLength(0);
  });

  test('surfaces a provider failure instead of writing a run', async () => {
    const db = openDb();
    seedDepartment(db, 'ops', 'Operations');
    seedGoal(db, 'ops', 'Fix the pipeline');
    const failing: Provider = {
      name: 'failing',
      defaultModel: 'x',
      async chat() {
        throw new Error('deepseek 402 Payment Required');
      },
    };

    await expect(runMorningBrief({}, { db, provider: failing })).rejects.toThrow(
      'deepseek 402',
    );
    const runs = db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM workflow_runs').get();
    expect(runs?.n).toBe(0);
  });
});

describe('isQuiet', () => {
  test('is quiet only when all three sources are empty', () => {
    const db = openDb();
    expect(isQuiet(gatherContext(db, '1970-01-01T00:00:00.000Z'))).toBe(true);

    seedActivity(db, 'did a thing', new Date().toISOString());
    expect(isQuiet(gatherContext(db, '1970-01-01T00:00:00.000Z'))).toBe(false);
  });
});

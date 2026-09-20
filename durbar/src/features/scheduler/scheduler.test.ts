/**
 * Spec for the scheduler.
 *
 * Every case here is a silent failure if the behaviour is wrong: a deferral that
 * burns an attempt fails permanently on its first real run; a non-atomic claim
 * sends the same brief twice; an unswept 'running' row is stranded forever.
 */

import { describe, expect, test } from "bun:test";
import { openDb, type Db } from "../../db.ts";
import type { ChatMessage, ChatOptions, Provider } from "../../providers.ts";
import {
  chainDaily,
  claimDue,
  HANDLERS,
  markFailedOrRetry,
  nextOccurrence,
  parseHhmm,
  pendingActions,
  PRINCIPAL_BRIEF_MORNING,
  reschedule,
  runDue,
  seedDaily,
  sweepStale,
  type SchedulerDeps,
} from "./scheduler.ts";

function fakeProvider(reply = "A brief."): Provider {
  return {
    name: "fake",
    defaultModel: "fake-model",
    async chat(_messages: readonly ChatMessage[], _options?: ChatOptions) {
      return reply;
    },
  };
}

function seedPrincipal(db: Db): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO people (full_name, is_principal, created_at, updated_at)
     VALUES ('Michael', 1, ?, ?)`,
    [now, now],
  );
}

/**
 * Gives the brief something to report.
 *
 * Without it `isQuiet()` is true, the brief short-circuits to a one-liner and
 * the provider is never called — so any test asserting on a provider failure
 * would silently exercise the suppression path instead.
 */
function seedAtRiskGoal(db: Db): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO departments (slug, title, updated_at) VALUES ('finance', 'Finance', ?)`,
    [now],
  );
  db.run(
    `INSERT INTO department_goals
       (department_slug, period_value, key_result, target, status, created_at, updated_at)
     VALUES ('finance', 'Q1', 'Close the books', 'a target', 'at_risk', ?, ?)`,
    [now, now],
  );
}

function deps(db: Db, overrides: Partial<SchedulerDeps> = {}): SchedulerDeps {
  return { db, provider: fakeProvider(), ...overrides };
}

/** Inserts an action directly so tests control status/attempts precisely. */
function insert(
  db: Db,
  runAt: string,
  kind = "ad_hoc",
  status = "pending",
  attempts = 0,
): number {
  const result = db.run(
    `INSERT INTO scheduled_actions
       (created_at, run_at, channel, channel_ref, intent_text, status, attempts, kind)
     VALUES (?, ?, '__internal__', '', 'test', ?, ?, ?)`,
    [new Date().toISOString(), runAt, status, attempts, kind],
  );
  return Number(result.lastInsertRowid);
}

const PAST = "2020-01-01T00:00:00.000Z";
const FUTURE = "2999-01-01T00:00:00.000Z";

describe("nextOccurrence", () => {
  test("returns today when the time is still ahead", () => {
    const now = new Date("2026-09-20T06:00:00.000Z");
    expect(nextOccurrence(now, 8, 0).toISOString()).toBe("2026-09-20T08:00:00.000Z");
  });

  test("rolls to tomorrow when the time has passed", () => {
    const now = new Date("2026-09-20T09:00:00.000Z");
    expect(nextOccurrence(now, 8, 0).toISOString()).toBe("2026-09-21T08:00:00.000Z");
  });

  test("is strictly after, so an exact boundary does not re-fire", () => {
    // At-or-after would re-fire the same instant on every tick.
    const now = new Date("2026-09-20T08:00:00.000Z");
    expect(nextOccurrence(now, 8, 0).toISOString()).toBe("2026-09-21T08:00:00.000Z");
  });

  test("crosses a month boundary correctly", () => {
    const now = new Date("2026-09-30T09:00:00.000Z");
    expect(nextOccurrence(now, 8, 0).toISOString()).toBe("2026-10-01T08:00:00.000Z");
  });
});

describe("parseHhmm", () => {
  test("parses a valid time", () => {
    expect(parseHhmm("06:30", "08:00")).toEqual([6, 30]);
  });

  test("falls back when absent or malformed", () => {
    expect(parseHhmm(undefined, "08:00")).toEqual([8, 0]);
    expect(parseHhmm("nonsense", "08:00")).toEqual([8, 0]);
    expect(parseHhmm("25:00", "08:00")).toEqual([8, 0]);
    expect(parseHhmm("08:99", "08:00")).toEqual([8, 0]);
  });
});

describe("claiming", () => {
  test("claims only due actions", () => {
    const db = openDb();
    insert(db, PAST);
    insert(db, FUTURE);

    const claimed = claimDue(db, new Date("2026-09-20T00:00:00.000Z"));
    expect(claimed).toHaveLength(1);
  });

  test("claims oldest first", () => {
    const db = openDb();
    insert(db, "2020-01-02T00:00:00.000Z");
    insert(db, "2020-01-01T00:00:00.000Z");

    const claimed = claimDue(db, new Date());
    expect(claimed[0]?.run_at).toBe("2020-01-01T00:00:00.000Z");
  });

  test("increments attempts at claim time, not on failure", () => {
    // The backoff map is keyed by the post-claim count; incrementing later
    // would shift every backoff by one step.
    const db = openDb();
    insert(db, PAST);

    expect(claimDue(db, new Date())[0]?.attempts).toBe(1);
  });

  test("a second claim gets nothing — the row cannot be double-dispatched", () => {
    const db = openDb();
    insert(db, PAST);
    claimDue(db, new Date());
    expect(claimDue(db, new Date())).toHaveLength(0);
  });

  test("respects the batch limit", () => {
    const db = openDb();
    for (let i = 0; i < 5; i += 1) insert(db, PAST);
    expect(claimDue(db, new Date(), 2)).toHaveLength(2);
  });
});

describe("sweepStale", () => {
  test("returns rows stranded in running by a crash back to pending", () => {
    // Only 'pending' rows are ever claimed, so without this a crash mid-dispatch
    // strands the action forever.
    const db = openDb();
    insert(db, PAST, "ad_hoc", "running");
    expect(sweepStale(db)).toBe(1);
    expect(pendingActions(db)).toHaveLength(1);
    expect(claimDue(db, new Date())).toHaveLength(1);
  });

  test("leaves done and failed rows alone", () => {
    const db = openDb();
    insert(db, PAST, "ad_hoc", "done");
    insert(db, PAST, "ad_hoc", "failed");
    expect(sweepStale(db)).toBe(0);
  });
});

describe("reschedule — a deferral must not burn an attempt", () => {
  test("undoes the claim's increment", () => {
    const db = openDb();
    const id = insert(db, PAST);
    const claimed = claimDue(db, new Date())[0];
    expect(claimed?.attempts).toBe(1);

    reschedule(db, id, new Date("2026-09-21T00:00:00.000Z"));

    const after = pendingActions(db)[0];
    expect(after?.attempts).toBe(0);
    expect(after?.status).toBe("pending");
  });

  test("repeated deferrals never exhaust the attempt budget", () => {
    // This is the bug the decrement exists to prevent: without it, an action
    // deferred three times fails permanently before it ever really ran.
    const db = openDb();
    const id = insert(db, PAST);

    for (let i = 0; i < 10; i += 1) {
      claimDue(db, new Date());
      reschedule(db, id, new Date());
    }

    const action = pendingActions(db)[0];
    expect(action?.attempts).toBe(0);
    expect(action?.status).toBe("pending");
  });

  test("only affects a running row", () => {
    const db = openDb();
    const id = insert(db, PAST, "ad_hoc", "done");
    expect(reschedule(db, id, new Date())).toBe(false);
  });
});

describe("markFailedOrRetry", () => {
  test("backs off 30s after the first failure", () => {
    const db = openDb();
    const id = insert(db, PAST);
    claimDue(db, new Date()); // attempts -> 1

    const now = new Date("2026-09-20T08:00:00.000Z");
    expect(markFailedOrRetry(db, id, "boom", 3, now)).toBe("pending");
    expect(pendingActions(db)[0]?.run_at).toBe("2026-09-20T08:00:30.000Z");
  });

  test("backs off 5m after the second", () => {
    const db = openDb();
    const id = insert(db, PAST, "ad_hoc", "pending", 1);
    claimDue(db, new Date()); // -> 2

    const now = new Date("2026-09-20T08:00:00.000Z");
    markFailedOrRetry(db, id, "boom", 3, now);
    expect(pendingActions(db)[0]?.run_at).toBe("2026-09-20T08:05:00.000Z");
  });

  test("gives up at maxAttempts rather than retrying forever", () => {
    const db = openDb();
    const id = insert(db, PAST, "ad_hoc", "pending", 2);
    claimDue(db, new Date()); // -> 3

    expect(markFailedOrRetry(db, id, "boom", 3)).toBe("failed");
    expect(pendingActions(db)).toHaveLength(0);
    const row = db
      .query<{ status: string; last_error: string }, [number]>(
        "SELECT status, last_error FROM scheduled_actions WHERE id = ?",
      )
      .get(id);
    expect(row?.status).toBe("failed");
    expect(row?.last_error).toBe("boom");
  });

  test("truncates a huge error so a traceback cannot bloat the row", () => {
    const db = openDb();
    const id = insert(db, PAST);
    claimDue(db, new Date());
    markFailedOrRetry(db, id, "x".repeat(5000), 3);

    const row = db
      .query<{ last_error: string }, [number]>(
        "SELECT last_error FROM scheduled_actions WHERE id = ?",
      )
      .get(id);
    expect(row?.last_error.length).toBe(500);
  });

  test("reports a missing row rather than throwing", () => {
    expect(markFailedOrRetry(openDb(), 999, "boom")).toBe("missing");
  });
});

describe("daily seeding and chaining", () => {
  test("seeds at the next occurrence", () => {
    const db = openDb();
    const now = new Date("2026-09-20T06:00:00.000Z");
    expect(seedDaily(db, PRINCIPAL_BRIEF_MORNING, "08:00", now)).not.toBeNull();
    expect(pendingActions(db)[0]?.run_at).toBe("2026-09-20T08:00:00.000Z");
  });

  test("does not stack a second brief when one is outstanding", () => {
    // Seeding runs at every startup; without the dedupe a restart adds a brief.
    const db = openDb();
    const now = new Date("2026-09-20T06:00:00.000Z");
    expect(seedDaily(db, PRINCIPAL_BRIEF_MORNING, "08:00", now)).not.toBeNull();
    expect(seedDaily(db, PRINCIPAL_BRIEF_MORNING, "08:00", now)).toBeNull();
    expect(pendingActions(db, PRINCIPAL_BRIEF_MORNING)).toHaveLength(1);
  });

  test("seeds again once the previous one is done", () => {
    const db = openDb();
    const now = new Date("2026-09-20T06:00:00.000Z");
    seedDaily(db, PRINCIPAL_BRIEF_MORNING, "08:00", now);
    const id = pendingActions(db)[0]?.id ?? 0;
    db.run("UPDATE scheduled_actions SET status = 'done' WHERE id = ?", [id]);

    expect(seedDaily(db, PRINCIPAL_BRIEF_MORNING, "08:00", now)).not.toBeNull();
  });

  test("chaining schedules the following day, not the same one", () => {
    const db = openDb();
    const after = new Date("2026-09-20T08:00:01.000Z");
    chainDaily(db, PRINCIPAL_BRIEF_MORNING, after, "08:00");
    expect(pendingActions(db)[0]?.run_at).toBe("2026-09-21T08:00:00.000Z");
  });
});

describe("runDue", () => {
  test("dispatches a due brief and marks it done", async () => {
    const db = openDb();
    seedPrincipal(db);
    const id = insert(db, PAST, PRINCIPAL_BRIEF_MORNING);

    const ran = await runDue(deps(db));

    expect(ran).toBe(1);
    const row = db
      .query<{ status: string }, [number]>(
        "SELECT status FROM scheduled_actions WHERE id = ?",
      )
      .get(id);
    expect(row?.status).toBe("done");
  });

  test("chains the next occurrence after a successful delivery", async () => {
    const db = openDb();
    seedPrincipal(db);
    insert(db, PAST, PRINCIPAL_BRIEF_MORNING);

    const now = new Date("2026-09-20T08:00:00.000Z");
    await runDue(deps(db, { now: () => now, morningTime: "08:00" }));

    const next = pendingActions(db, PRINCIPAL_BRIEF_MORNING);
    expect(next).toHaveLength(1);
    expect(next[0]?.run_at).toBe("2026-09-21T08:00:00.000Z");
  });

  test("defers — not fails — when there is no principal to deliver to", async () => {
    // A fresh install has no roster. That is a "not yet", not an error, so it
    // must not spend the action's attempt budget.
    const db = openDb();
    const id = insert(db, PAST, PRINCIPAL_BRIEF_MORNING);

    const ran = await runDue(deps(db));

    expect(ran).toBe(0);
    const action = pendingActions(db)[0];
    expect(action?.id).toBe(id);
    expect(action?.status).toBe("pending");
    expect(action?.attempts).toBe(0);
  });

  test("a handler error retries rather than dropping the action", async () => {
    const db = openDb();
    seedPrincipal(db);
    // Something to report, or the brief suppresses and never calls the provider.
    seedAtRiskGoal(db);
    insert(db, PAST, PRINCIPAL_BRIEF_MORNING);
    const failing: Provider = {
      name: "failing",
      defaultModel: "x",
      async chat() {
        throw new Error("deepseek 429");
      },
    };

    const ran = await runDue({ db, provider: failing });

    expect(ran).toBe(0);
    const action = pendingActions(db)[0];
    expect(action?.status).toBe("pending");
    expect(action?.attempts).toBe(1);
    expect(action?.last_error).toContain("429");
  });

  test("an unknown kind fails loudly instead of vanishing", async () => {
    const db = openDb();
    const id = insert(db, PAST, "not_a_real_kind");

    // Each failure schedules a backoff, so the row is not due on the next tick
    // — the test has to make it due again to exhaust the attempts.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await runDue(deps(db));
      db.run("UPDATE scheduled_actions SET run_at = ? WHERE id = ?", [PAST, id]);
    }

    const row = db
      .query<{ status: string; last_error: string }, [number]>(
        "SELECT status, last_error FROM scheduled_actions WHERE id = ?",
      )
      .get(id);
    expect(row?.status).toBe("failed");
    expect(row?.last_error).toContain("no handler");
  });

  test("one failing action does not stop the batch", async () => {
    const db = openDb();
    seedPrincipal(db);
    insert(db, PAST, "not_a_real_kind");
    insert(db, PAST, PRINCIPAL_BRIEF_MORNING);

    const ran = await runDue(deps(db));
    expect(ran).toBe(1);
  });

  test("does nothing when nothing is due", async () => {
    const db = openDb();
    insert(db, FUTURE);
    expect(await runDue(deps(db))).toBe(0);
  });
});

describe("the handler registry", () => {
  test("registers the morning brief", () => {
    expect(Object.keys(HANDLERS)).toContain(PRINCIPAL_BRIEF_MORNING);
  });
});

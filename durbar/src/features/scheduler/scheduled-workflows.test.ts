/**
 * Spec for scheduler chaining of the three scheduled workflows.
 *
 * Each scheduled workflow should enqueue its next occurrence after delivery
 * (chaining, not cron). The scheduler already handles daily chaining for
 * morning_brief — this verifies it extends to the three new kinds.
 */

import { describe, expect, test } from "bun:test";
import { openDb, type Db } from "../../db.ts";
import type { ChatMessage, ChatOptions, Provider } from "../../providers.ts";
import {
  chainDaily,
  EXECUTIVE_REFLECTION,
  HANDLERS,
  pendingActions,
  PRINCIPAL_BRIEF_EOD,
  PRINCIPAL_BRIEF_MORNING,
  runDue,
  seedDaily,
  WATCHLIST_RESEARCH,
  type SchedulerDeps,
} from "./scheduler.ts";

function fakeProvider(reply = "A narrative."): Provider {
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
     VALUES ('Principal', 1, ?, ?)`,
    [now, now],
  );
}

function seedAtRiskGoal(db: Db): void {
  const now = new Date().toISOString();
  db.run(`INSERT INTO departments (slug, title, updated_at) VALUES ('finance', 'Finance', ?)`, [now]);
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

function insert(db: Db, runAt: string, kind: string, status = "pending", attempts = 0): number {
  const result = db.run(
    `INSERT INTO scheduled_actions
       (created_at, run_at, channel, channel_ref, intent_text, status, attempts, kind)
     VALUES (?, ?, '__internal__', '', 'test', ?, ?, ?)`,
    [new Date().toISOString(), runAt, status, attempts, kind],
  );
  return Number(result.lastInsertRowid);
}

const PAST = "2020-01-01T00:00:00.000Z";

describe("scheduler chaining for scheduled workflows", () => {
  test("end_of_day_digest chains after delivery", async () => {
    const db = openDb();
    seedPrincipal(db);
    seedAtRiskGoal(db);
    insert(db, PAST, PRINCIPAL_BRIEF_EOD);

    const now = new Date("2026-09-20T18:00:00.000Z");
    const ran = await runDue(deps(db, { now: () => now, eodTime: "18:00" }));

    expect(ran).toBe(1);
    const next = pendingActions(db, PRINCIPAL_BRIEF_EOD);
    expect(next).toHaveLength(1);
    expect(next[0]?.run_at).toBe("2026-09-21T18:00:00.000Z");
  });

  test("executive_reflection chains after delivery", async () => {
    const db = openDb();
    insert(db, PAST, EXECUTIVE_REFLECTION);

    const now = new Date("2026-09-20T07:30:00.000Z");
    const ran = await runDue(deps(db, { now: () => now }));

    expect(ran).toBe(1);
    const next = pendingActions(db, EXECUTIVE_REFLECTION);
    expect(next).toHaveLength(1);
    expect(next[0]?.run_at).toBe("2026-09-21T07:30:00.000Z");
  });

  test("executive_reflection does not require a principal", async () => {
    const db = openDb();
    insert(db, PAST, EXECUTIVE_REFLECTION);

    // No principal seeded — should still run (reflection is not a DM).
    const ran = await runDue(deps(db));
    expect(ran).toBe(1);
  });

  test("watchlist_research_scan chains after delivery", async () => {
    const db = openDb();
    insert(db, PAST, WATCHLIST_RESEARCH);

    const now = new Date("2026-09-20T08:00:00.000Z");
    const ran = await runDue(deps(db, { now: () => now }));

    expect(ran).toBe(1);
    const next = pendingActions(db, WATCHLIST_RESEARCH);
    expect(next).toHaveLength(1);
  });

  test("seedDaily is idempotent for each kind", () => {
    const db = openDb();
    const now = new Date("2026-09-20T06:00:00.000Z");
    expect(seedDaily(db, PRINCIPAL_BRIEF_EOD, "18:00", now)).not.toBeNull();
    expect(seedDaily(db, PRINCIPAL_BRIEF_EOD, "18:00", now)).toBeNull();
    expect(seedDaily(db, EXECUTIVE_REFLECTION, "07:30", now)).not.toBeNull();
    expect(seedDaily(db, EXECUTIVE_REFLECTION, "07:30", now)).toBeNull();
  });

  test("chainDaily schedules the next day", () => {
    const db = openDb();
    const after = new Date("2026-09-20T18:00:01.000Z");
    chainDaily(db, PRINCIPAL_BRIEF_EOD, after, "18:00");
    expect(pendingActions(db)[0]?.run_at).toBe("2026-09-21T18:00:00.000Z");
  });

  test("all four kinds are registered in HANDLERS", () => {
    expect(Object.keys(HANDLERS)).toContain(PRINCIPAL_BRIEF_MORNING);
    expect(Object.keys(HANDLERS)).toContain(PRINCIPAL_BRIEF_EOD);
    expect(Object.keys(HANDLERS)).toContain(EXECUTIVE_REFLECTION);
    expect(Object.keys(HANDLERS)).toContain(WATCHLIST_RESEARCH);
  });
});

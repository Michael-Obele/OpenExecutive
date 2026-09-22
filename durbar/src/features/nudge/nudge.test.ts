import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import {
  bootstrapNudgeScan,
  enqueueNextScan,
  runNudgeScan,
  SCOPE_PREFIX_COMMITMENT,
  SCOPE_PREFIX_INITIATIVE,
  SCOPE_PREFIX_STALLED,
} from "./nudge.ts";

function seedPerson(
  db: ReturnType<typeof openDb>,
  overrides: Record<string, unknown> = {},
) {
  const now = new Date().toISOString();
  db.run(
    "INSERT INTO people (full_name, role, is_principal, email, preferred_channel, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    [
      (overrides["full_name"] as string) ?? "Alice",
      (overrides["role"] as string) ?? "Engineer",
      0,
      (overrides["email"] as string) ?? "alice@example.com",
      (overrides["preferred_channel"] as string) ?? "email",
      now,
      now,
    ],
  );
  return Number(
    (
      db.query("SELECT last_insert_rowid() as id").get() as Record<
        string,
        unknown
      >
    )["id"] as number,
  );
}

describe("nudge engine", () => {
  test("runNudgeScan returns 0 when nothing to nudge", () => {
    const db = openDb();
    const n = runNudgeScan(db, new Date());
    expect(n).toBe(0);
  });

  test("stalled workflow candidate is nudged", () => {
    const db = openDb();
    const personId = seedPerson(db);
    const now = new Date();
    const awaitingUntil = new Date(
      now.getTime() + 2 * 3600 * 1000,
    ).toISOString(); // 2h from now
    const updatedAt = new Date(now.getTime() - 5 * 3600 * 1000).toISOString(); // 5h ago (past minQuiet)
    db.run(
      "INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, created_at, updated_at, awaiting_person_id, awaiting_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "run-1",
        "offer_approval",
        "Offer for Bob",
        "awaiting_human",
        "{}",
        now.toISOString(),
        updatedAt,
        personId,
        awaitingUntil,
      ],
    );
    const n = runNudgeScan(db, now);
    expect(n).toBe(1);
    const nudges = db
      .query<
        Record<string, unknown>,
        []
      >("SELECT scope_key, kind FROM scheduled_actions WHERE kind = 'proactive_nudge'")
      .all();
    expect(nudges).toHaveLength(1);
    expect(nudges[0]!["scope_key"]).toBe(`${SCOPE_PREFIX_STALLED}:run-1`);
  });

  test("stalled workflow not nudged if deadline already passed", () => {
    const db = openDb();
    const personId = seedPerson(db);
    const now = new Date();
    const awaitingUntil = new Date(now.getTime() - 1000).toISOString(); // already timed out
    db.run(
      "INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, created_at, updated_at, awaiting_person_id, awaiting_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "run-1",
        "offer_approval",
        "Offer",
        "awaiting_human",
        "{}",
        now.toISOString(),
        now.toISOString(),
        personId,
        awaitingUntil,
      ],
    );
    const n = runNudgeScan(db, now);
    expect(n).toBe(0);
  });

  test("stalled workflow not nudged if recently updated (minQuiet)", () => {
    const db = openDb();
    const personId = seedPerson(db);
    const now = new Date();
    const awaitingUntil = new Date(
      now.getTime() + 2 * 3600 * 1000,
    ).toISOString();
    // updated just now — within minQuietHours
    db.run(
      "INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, created_at, updated_at, awaiting_person_id, awaiting_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "run-1",
        "offer_approval",
        "Offer",
        "awaiting_human",
        "{}",
        now.toISOString(),
        now.toISOString(),
        personId,
        awaitingUntil,
      ],
    );
    const n = runNudgeScan(db, now);
    expect(n).toBe(0);
  });

  test("stale commitment candidate is nudged", () => {
    const db = openDb();
    const personId = seedPerson(db);
    const now = new Date();
    const awaitingSince = new Date(
      now.getTime() - 5 * 24 * 3600 * 1000,
    ).toISOString(); // 5 days ago
    db.run(
      "INSERT INTO scheduled_actions (created_at, run_at, channel, channel_ref, intent_text, status, attempts, kind, awaiting_response_since, assigned_to_person_id) VALUES (?, ?, ?, ?, ?, 'pending', 0, 'ad_hoc', ?, ?)",
      [
        now.toISOString(),
        now.toISOString(),
        "email",
        "alice@example.com",
        "Please review",
        awaitingSince,
        personId,
      ],
    );
    const n = runNudgeScan(db, now);
    expect(n).toBe(1);
    const nudges = db
      .query<
        Record<string, unknown>,
        []
      >("SELECT scope_key FROM scheduled_actions WHERE kind = 'proactive_nudge'")
      .all();
    expect(
      (nudges[0]!["scope_key"] as string).startsWith(SCOPE_PREFIX_COMMITMENT),
    ).toBe(true);
  });

  test("idle initiative candidate is nudged", () => {
    const db = openDb();
    const personId = seedPerson(db);
    db.run(
      "INSERT INTO departments (slug, title, head_person_id, updated_at) VALUES (?, ?, ?, ?)",
      ["eng", "Engineering", personId, new Date().toISOString()],
    );
    const now = new Date();
    const updatedAt = new Date(
      now.getTime() - 10 * 24 * 3600 * 1000,
    ).toISOString(); // 10 days ago
    db.run(
      "INSERT INTO initiatives (title, status, created_at, updated_at, department) VALUES (?, ?, ?, ?, ?)",
      ["Launch v2", "active", updatedAt, updatedAt, "eng"],
    );
    const n = runNudgeScan(db, now);
    expect(n).toBe(1);
    const nudges = db
      .query<
        Record<string, unknown>,
        []
      >("SELECT scope_key FROM scheduled_actions WHERE kind = 'proactive_nudge'")
      .all();
    expect(
      (nudges[0]!["scope_key"] as string).startsWith(SCOPE_PREFIX_INITIATIVE),
    ).toBe(true);
  });

  test("dedup: second scan does not re-nudge same scope within cooldown", () => {
    const db = openDb();
    const personId = seedPerson(db);
    const now = new Date();
    const awaitingUntil = new Date(
      now.getTime() + 2 * 3600 * 1000,
    ).toISOString();
    const updatedAt = new Date(now.getTime() - 5 * 3600 * 1000).toISOString();
    db.run(
      "INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, created_at, updated_at, awaiting_person_id, awaiting_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "run-1",
        "offer_approval",
        "Offer",
        "awaiting_human",
        "{}",
        now.toISOString(),
        updatedAt,
        personId,
        awaitingUntil,
      ],
    );
    expect(runNudgeScan(db, now)).toBe(1);
    expect(runNudgeScan(db, now)).toBe(0);
  });

  test("per-scope cap stops re-nudging after max", () => {
    const db = openDb();
    const personId = seedPerson(db);
    const now = new Date();
    const awaitingUntil = new Date(
      now.getTime() + 2 * 3600 * 1000,
    ).toISOString();
    const updatedAt = new Date(now.getTime() - 5 * 3600 * 1000).toISOString();
    db.run(
      "INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, created_at, updated_at, awaiting_person_id, awaiting_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "run-1",
        "offer_approval",
        "Offer",
        "awaiting_human",
        "{}",
        now.toISOString(),
        updatedAt,
        personId,
        awaitingUntil,
      ],
    );
    // Insert 3 prior nudges for same scope to hit cap
    for (let i = 0; i < 3; i++) {
      db.run(
        "INSERT INTO scheduled_actions (created_at, run_at, channel, channel_ref, intent_text, status, attempts, kind, scope_key) VALUES (?, ?, ?, ?, ?, 'done', 0, 'proactive_nudge', ?)",
        [
          new Date(now.getTime() - (i + 10) * 24 * 3600 * 1000).toISOString(),
          now.toISOString(),
          "email",
          "a@b.com",
          "nudge",
          `${SCOPE_PREFIX_STALLED}:run-1`,
        ],
      );
    }
    const n = runNudgeScan(db, now, { maxPerScope: 3 });
    expect(n).toBe(0);
  });

  test("bootstrapNudgeScan inserts heartbeat", () => {
    const db = openDb();
    const id = bootstrapNudgeScan(db);
    expect(id).not.toBeNull();
    const rows = db
      .query<
        Record<string, unknown>,
        []
      >("SELECT kind FROM scheduled_actions WHERE kind = 'nudge_scan'")
      .all();
    expect(rows).toHaveLength(1);
  });

  test("bootstrapNudgeScan is idempotent", () => {
    const db = openDb();
    bootstrapNudgeScan(db);
    const second = bootstrapNudgeScan(db);
    expect(second).toBeNull();
    const rows = db
      .query<
        Record<string, unknown>,
        []
      >("SELECT kind FROM scheduled_actions WHERE kind = 'nudge_scan'")
      .all();
    expect(rows).toHaveLength(1);
  });

  test("enqueueNextScan inserts next heartbeat", () => {
    const db = openDb();
    const id = enqueueNextScan(db, new Date());
    expect(id).not.toBeNull();
  });

  test("caps: maxPerScan limits emitted nudges", () => {
    const db = openDb();
    const now = new Date();
    const awaitingUntil = new Date(
      now.getTime() + 2 * 3600 * 1000,
    ).toISOString();
    const updatedAt = new Date(now.getTime() - 5 * 3600 * 1000).toISOString();
    for (let i = 0; i < 5; i++) {
      const pid = seedPerson(db, {
        full_name: `Person ${i}`,
        email: `p${i}@example.com`,
      });
      db.run(
        "INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, created_at, updated_at, awaiting_person_id, awaiting_until) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          `run-${i}`,
          "offer_approval",
          `Offer ${i}`,
          "awaiting_human",
          "{}",
          now.toISOString(),
          updatedAt,
          pid,
          awaitingUntil,
        ],
      );
    }
    const n = runNudgeScan(db, now, { maxPerScan: 2 });
    expect(n).toBe(2);
  });
});

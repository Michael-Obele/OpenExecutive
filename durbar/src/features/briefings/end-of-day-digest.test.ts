/**
 * Spec for `end_of_day_digest`.
 *
 * Ported from `workflows/end_of_day_digest.py` + `tests/unit/test_principal_briefs.py`.
 * The cases that matter are the ones a rewrite drops without noticing: the
 * delivered-digest watermark, exclusion of monitoring noise, suppression when
 * quiet, and provider failure handling.
 */

import { describe, expect, test } from "bun:test";
import { openDb, type Db } from "../../db.ts";
import type { ChatMessage, ChatOptions, Provider } from "../../providers.ts";
import {
  EOD_BRIEF_KIND,
  gatherEodContext,
  isEodQuiet,
  renderEodContext,
  runEndOfDayDigest,
  sinceForEod,
} from "./end-of-day-digest.ts";

function fakeProvider(reply = "An EoD digest."): Provider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: "fake",
    defaultModel: "fake-model",
    calls,
    async chat(messages: readonly ChatMessage[], _options?: ChatOptions) {
      calls.push([...messages]);
      return reply;
    },
  };
}

function seedDepartment(db: Db, slug: string, title: string): void {
  db.run(`INSERT INTO departments (slug, title, updated_at) VALUES (?, ?, ?)`, [
    slug,
    title,
    new Date().toISOString(),
  ]);
}

function seedGoal(db: Db, slug: string, keyResult: string, status = "at_risk", current = ""): void {
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
  db.run(`INSERT INTO audit_log (ts, event_type, summary) VALUES (?, 'tool_invocation', ?)`, [
    ts,
    summary,
  ]);
}

describe("sinceForEod", () => {
  test("falls back to a 24h window on a cold store", () => {
    const db = openDb();
    const now = new Date("2026-09-20T18:00:00.000Z");
    expect(sinceForEod(db, EOD_BRIEF_KIND, now)).toBe("2026-09-19T18:00:00.000Z");
  });

  test("uses the last delivered digest, not a fixed window", () => {
    const db = openDb();
    db.run(
      `INSERT INTO briefing_narrative (scope, input_hash, narrative_text, generated_at)
       VALUES (?, '0', 'previous', '2026-09-20T17:30:00.000Z')`,
      [EOD_BRIEF_KIND],
    );
    const now = new Date("2026-09-26T18:00:00.000Z");
    expect(sinceForEod(db, EOD_BRIEF_KIND, now)).toBe("2026-09-20T17:30:00.000Z");
  });
});

describe("gatherEodContext", () => {
  test("collects at-risk goals with their department title", () => {
    const db = openDb();
    seedDepartment(db, "marketing", "Marketing");
    seedGoal(db, "marketing", "Post on three platforms", "at_risk", "Bluesky only");

    const context = gatherEodContext(db, "1970-01-01T00:00:00.000Z");
    expect(context.atRiskGoals).toHaveLength(1);
    expect(context.atRiskGoals[0]?.department).toBe("Marketing");
  });

  test("excludes monitoring and watchlist findings from proposals", () => {
    const db = openDb();
    seedAlert(db, "monitoring", "Competitor shipped a feature");
    seedAlert(db, "watchlist", "New signal on Acme");
    seedAlert(db, "goal_review", "Marketing goal slipped");

    const context = gatherEodContext(db, "1970-01-01T00:00:00.000Z");
    expect(context.proposals).toHaveLength(1);
    expect(context.proposals[0]?.headline).toBe("Marketing goal slipped");
  });

  test("only reports activity inside the window", () => {
    const db = openDb();
    seedActivity(db, "old", "2026-09-01T00:00:00.000Z");
    seedActivity(db, "new", "2026-09-20T00:00:00.000Z");

    const context = gatherEodContext(db, "2026-09-19T00:00:00.000Z");
    expect(context.activity.map((a) => a.summary)).toEqual(["new"]);
  });
});

describe("renderEodContext", () => {
  test("states counts for each section", () => {
    const db = openDb();
    const rendered = renderEodContext(gatherEodContext(db, "1970-01-01T00:00:00.000Z"), "2026-09-20");
    expect(rendered).toContain("WHAT I DID TODAY");
    expect(rendered).toContain("STILL PENDING");
    expect(rendered).toContain("AT RISK TOMORROW");
  });
});

describe("runEndOfDayDigest", () => {
  test("sends the gathered context to the model and returns its narrative", async () => {
    const db = openDb();
    seedDepartment(db, "finance", "Finance");
    seedGoal(db, "finance", "Close the books", "off_track");
    const provider = fakeProvider("Finance is off track tomorrow.");

    const result = await runEndOfDayDigest(
      { periodLabel: "2026-09-20" },
      { db, provider, now: () => new Date("2026-09-20T18:00:00.000Z") },
    );

    expect(result.narrative).toBe("Finance is off track tomorrow.");
    expect(result.suppressed).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  test("suppresses to one line when nothing changed", async () => {
    const db = openDb();
    const provider = fakeProvider("should not be called");

    const result = await runEndOfDayDigest({}, { db, provider });

    expect(result.suppressed).toBe(true);
    expect(result.narrative).toBe("Quiet day — nothing carrying forward.");
    expect(provider.calls).toHaveLength(0);
  });

  test("forceFull renders the digest even when nothing changed", async () => {
    const db = openDb();
    const provider = fakeProvider("Full digest.");

    const result = await runEndOfDayDigest({ forceFull: true }, { db, provider });

    expect(result.suppressed).toBe(false);
    expect(provider.calls).toHaveLength(1);
  });

  test("persists the run and advances the watermark", async () => {
    const db = openDb();
    seedDepartment(db, "legal", "Legal");
    seedGoal(db, "legal", "Review the contract");
    const at = new Date("2026-09-20T18:00:00.000Z");

    const result = await runEndOfDayDigest(
      {},
      { db, provider: fakeProvider("Legal needs you tomorrow."), now: () => at },
    );

    const run = db
      .query<{ workflow_name: string; status: string; artifact: string }, [string]>(
        "SELECT workflow_name, status, artifact FROM workflow_runs WHERE run_id = ?",
      )
      .get(result.runId);
    expect(run?.workflow_name).toBe("end_of_day_digest");
    expect(run?.status).toBe("succeeded");
    expect(run?.artifact).toBe("Legal needs you tomorrow.");
    expect(sinceForEod(db, EOD_BRIEF_KIND)).toBe(at.toISOString());
  });

  test("surfaces a provider failure instead of writing a run", async () => {
    const db = openDb();
    seedDepartment(db, "ops", "Operations");
    seedGoal(db, "ops", "Fix the pipeline");
    const failing: Provider = {
      name: "failing",
      defaultModel: "x",
      async chat() {
        throw new Error("deepseek 402 Payment Required");
      },
    };

    await expect(runEndOfDayDigest({}, { db, provider: failing })).rejects.toThrow(
      "deepseek 402",
    );
    const runs = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM workflow_runs").get();
    expect(runs?.n).toBe(0);
  });
});

describe("isEodQuiet", () => {
  test("is quiet only when all three sources are empty", () => {
    const db = openDb();
    expect(isEodQuiet(gatherEodContext(db, "1970-01-01T00:00:00.000Z"))).toBe(true);

    seedActivity(db, "did a thing", new Date().toISOString());
    expect(isEodQuiet(gatherEodContext(db, "1970-01-01T00:00:00.000Z"))).toBe(false);
  });
});

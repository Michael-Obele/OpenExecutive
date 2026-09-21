/**
 * Spec for `executive_reflection`.
 *
 * Ported from `workflows/executive_reflection.py` + `tests/unit/test_executive_reflection.py`.
 * The cases that matter: context assembly, prompt is sent, artifact persisted,
 * provider failure surfaces, and the workflow always produces an artifact.
 */

import { describe, expect, test } from "bun:test";
import { openDb, type Db } from "../../db.ts";
import type { ChatMessage, ChatOptions, Provider } from "../../providers.ts";
import {
  gatherReflectionContext,
  renderReflectionContext,
  runExecutiveReflection,
} from "./executive-reflection.ts";

function fakeProvider(reply = "Reflection narrative."): Provider & { calls: ChatMessage[][] } {
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

function seedGoal(db: Db, slug: string, keyResult: string, status = "at_risk"): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO department_goals
       (department_slug, period_value, key_result, target, status, created_at, updated_at)
     VALUES (?, 'Q1', ?, 'a target', ?, ?, ?)`,
    [slug, keyResult, status, now, now],
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

describe("gatherReflectionContext", () => {
  test("collects at-risk goals", () => {
    const db = openDb();
    seedDepartment(db, "finance", "Finance");
    seedGoal(db, "finance", "Close the books", "off_track");

    const context = gatherReflectionContext(db);
    expect(context.atRiskGoals).toHaveLength(1);
    expect(context.atRiskGoals[0]?.department).toBe("Finance");
  });

  test("excludes monitoring and watchlist from proposals", () => {
    const db = openDb();
    seedAlert(db, "monitoring", "Competitor shipped");
    seedAlert(db, "watchlist", "New signal");
    seedAlert(db, "goal_review", "Goal slipped");

    const context = gatherReflectionContext(db);
    expect(context.proposals).toHaveLength(1);
    expect(context.proposals[0]?.headline).toBe("Goal slipped");
  });

  test("collects recent activity", () => {
    const db = openDb();
    seedActivity(db, "sent a nudge", new Date().toISOString());

    const context = gatherReflectionContext(db);
    expect(context.activity).toHaveLength(1);
  });
});

describe("renderReflectionContext", () => {
  test("renders all signal sections", () => {
    const db = openDb();
    const rendered = renderReflectionContext(gatherReflectionContext(db), "2026-09-20");
    expect(rendered).toContain("DEPARTMENTS WITH RISK");
    expect(rendered).toContain("PROPOSALS AWAITING DECISION");
    expect(rendered).toContain("RECENT ACTIVITY");
  });

  test("notes when no signals", () => {
    const db = openDb();
    const rendered = renderReflectionContext(gatherReflectionContext(db), "2026-09-20");
    expect(rendered).toContain("No signals worth acting on");
  });
});

describe("runExecutiveReflection", () => {
  test("sends context to the model and returns its narrative", async () => {
    const db = openDb();
    seedDepartment(db, "ops", "Operations");
    seedGoal(db, "ops", "Fix the pipeline");
    const provider = fakeProvider("**Acted on:** Fixed it.");

    const result = await runExecutiveReflection(
      { periodLabel: "2026-09-20" },
      { db, provider, now: () => new Date("2026-09-20T07:30:00.000Z") },
    );

    expect(result.narrative).toBe("**Acted on:** Fixed it.");
    expect(result.period).toBe("2026-09-20");
    expect(provider.calls).toHaveLength(1);
  });

  test("always produces an artifact even when quiet", async () => {
    const db = openDb();
    const provider = fakeProvider("**Quiet:** Nothing else worth acting on.");

    const result = await runExecutiveReflection({}, { db, provider });

    expect(result.narrative).toContain("Quiet");
    expect(provider.calls).toHaveLength(1);
  });

  test("persists the run", async () => {
    const db = openDb();
    const at = new Date("2026-09-20T07:30:00.000Z");

    const result = await runExecutiveReflection(
      {},
      { db, provider: fakeProvider("Reflection done."), now: () => at },
    );

    const run = db
      .query<{ workflow_name: string; status: string; artifact: string }, [string]>(
        "SELECT workflow_name, status, artifact FROM workflow_runs WHERE run_id = ?",
      )
      .get(result.runId);
    expect(run?.workflow_name).toBe("executive_reflection");
    expect(run?.status).toBe("succeeded");
    expect(run?.artifact).toBe("Reflection done.");
  });

  test("surfaces a provider failure", async () => {
    const db = openDb();
    const failing: Provider = {
      name: "failing",
      defaultModel: "x",
      async chat() {
        throw new Error("deepseek 429 rate limited");
      },
    };

    await expect(runExecutiveReflection({}, { db, provider: failing })).rejects.toThrow(
      "429",
    );
    const runs = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM workflow_runs").get();
    expect(runs?.n).toBe(0);
  });

  test("provider is called with the reflection system prompt", async () => {
    const db = openDb();
    const provider = fakeProvider("ok");

    await runExecutiveReflection({}, { db, provider });

    const [system] = provider.calls[0] ?? [];
    expect(system?.role).toBe("system");
    expect(system?.content).toContain("solo standup");
  });
});

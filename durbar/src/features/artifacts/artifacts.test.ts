/**
 * Spec for artifacts.
 *
 * Ported from `api/routes/artifacts.py`: unified list over alert-backed and
 * run-backed artifacts, get by composite id, archive/restore, delete,
 * malformed id handling, and 404s. Uses the HTTP layer end-to-end.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp, type AppContext } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
import { insertAlert } from "../alerts/alerts.ts";

function fakeProvider(): Provider {
  return {
    name: "fake",
    defaultModel: "fake-model",
    async chat() {
      return "ok";
    },
  };
}

function fakeSettings(): Settings {
  return {
    dbPath: ":memory:",
    port: 8787,
    publicServerUrl: "",
    allowedOrigins: [],
    morningBriefTime: "08:00",
    scheduledAdminToken: "",
    provider: {
      name: "deepseek",
      baseUrl: "https://api.deepseek.com",
      apiKey: "test",
      model: "deepseek-chat",
      reasoningModel: "deepseek-reasoner",
      routingModel: "deepseek-chat",
      headers: {},
    },
  };
}

function appWith(db: ReturnType<typeof openDb>) {
  const context: AppContext = {
    settings: fakeSettings(),
    db,
    provider: fakeProvider(),
  };
  return createApp(context);
}

async function req(
  app: ReturnType<typeof createApp>,
  path: string,
  init?: RequestInit,
) {
  const res = await app(new Request(`http://localhost${path}`, init));
  const body: unknown = await res.json().catch(() => null);
  return { res, body };
}

function insertArtifactAlert(db: ReturnType<typeof openDb>, headline = "Artifact One"): number {
  const id = insertAlert(db, {
    source: "artifact",
    external_id: `ext-${headline}`,
    severity: "medium",
    headline,
    body: "# Title\n\nBody of the artifact.",
    suggested_action: "Rationale here",
  });
  if (id === null) throw new Error("insertAlert returned null");
  return id;
}

function insertRun(db: ReturnType<typeof openDb>, runId = "run-abc123", title = "Run Artifact"): void {
  const now = new Date().toISOString();
  db.run(
    `INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, artifact, created_at, updated_at)
     VALUES (?, ?, ?, 'done', '{}', ?, ?, ?)`,
    [runId, "test_workflow", title, "# Run Body\n\nContent", now, now],
  );
}

// ── GET /artifacts ─────────────────────────────────────────────────────

describe("GET /artifacts", () => {
  test("empty when no artifacts", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/artifacts");
    expect(res.status).toBe(200);
    expect((body as { artifacts: unknown[] }).artifacts).toEqual([]);
  });

  test("lists alert-backed artifacts", async () => {
    const db = openDb();
    const app = appWith(db);
    insertArtifactAlert(db, "My Artifact");
    const { body } = await req(app, "/artifacts");
    const arts = (body as { artifacts: Array<{ id: string; kind: string; title: string }> }).artifacts;
    expect(arts).toHaveLength(1);
    expect(arts[0]!.kind).toBe("draft");
    expect(arts[0]!.title).toBe("My Artifact");
    expect(arts[0]!.id).toMatch(/^alert:/);
  });

  test("lists run-backed artifacts", async () => {
    const db = openDb();
    const app = appWith(db);
    insertRun(db, "run-xyz", "Run Title");
    const { body } = await req(app, "/artifacts");
    const arts = (body as { artifacts: Array<{ id: string; kind: string }> }).artifacts;
    expect(arts).toHaveLength(1);
    expect(arts[0]!.kind).toBe("workflow");
    expect(arts[0]!.id).toBe("run:run-xyz");
  });

  test("unified list sorted newest first", async () => {
    const db = openDb();
    const app = appWith(db);
    insertArtifactAlert(db, "Older");
    // Make it older.
    const olderId = db.query<{ id: number }, []>("SELECT id FROM alerts ORDER BY id ASC LIMIT 1").get()!.id;
    db.run("UPDATE alerts SET created_at = ? WHERE id = ?", ["2020-01-01T00:00:00.000Z", olderId]);
    insertRun(db, "run-new", "Newer");
    const { body } = await req(app, "/artifacts");
    const arts = (body as { artifacts: Array<{ id: string }> }).artifacts;
    expect(arts).toHaveLength(2);
    // Newer run should be first.
    expect(arts[0]!.id).toBe("run:run-new");
  });

  test("archived=true returns only archived", async () => {
    const db = openDb();
    const app = appWith(db);
    insertArtifactAlert(db, "Active");
    const id2 = insertArtifactAlert(db, "Archived");
    await req(app, `/artifacts/alert:${id2}/archive`, { method: "POST" });

    const { body: active } = await req(app, "/artifacts");
    expect((active as { artifacts: unknown[] }).artifacts.length).toBe(1);

    const { body: archived } = await req(app, "/artifacts?archived=true");
    expect((archived as { artifacts: unknown[] }).artifacts.length).toBe(1);
    expect((archived as { artifacts: Array<{ title: string }> }).artifacts[0]!.title).toBe("Archived");
  });

  test("does not include non-artifact alerts", async () => {
    const db = openDb();
    const app = appWith(db);
    insertAlert(db, { source: "triage", external_id: "ext-x", severity: "medium", headline: "Not artifact", body: "b" });
    const { body } = await req(app, "/artifacts");
    expect((body as { artifacts: unknown[] }).artifacts).toEqual([]);
  });

  test("does not include runs without artifact", async () => {
    const db = openDb();
    const app = appWith(db);
    const now = new Date().toISOString();
    db.run(
      `INSERT INTO workflow_runs (run_id, workflow_name, title, status, inputs, created_at, updated_at)
       VALUES ('run-empty', 'wf', 'Empty', 'done', '{}', ?, ?)`,
      [now, now],
    );
    const { body } = await req(app, "/artifacts");
    expect((body as { artifacts: unknown[] }).artifacts).toEqual([]);
  });
});

// ── GET /artifacts/{id} ────────────────────────────────────────────────

describe("GET /artifacts/{id}", () => {
  test("gets an alert-backed artifact with body", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertArtifactAlert(db, "Detail Test");
    const { res, body } = await req(app, `/artifacts/alert:${id}`);
    expect(res.status).toBe(200);
    const art = body as { id: string; body: string; rationale: string };
    expect(art.id).toBe(`alert:${id}`);
    expect(art.body).toContain("Body of the artifact");
    expect(art.rationale).toBe("Rationale here");
  });

  test("gets a run-backed artifact", async () => {
    const db = openDb();
    const app = appWith(db);
    insertRun(db, "run-detail", "Run Detail");
    const { res, body } = await req(app, "/artifacts/run:run-detail");
    expect(res.status).toBe(200);
    expect((body as { id: string }).id).toBe("run:run-detail");
    expect((body as { body: string }).body).toContain("Run Body");
  });

  test("400 for malformed id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/artifacts/bad-id");
    expect(res.status).toBe(400);
  });

  test("400 for unknown kind prefix", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/artifacts/unknown:123");
    expect(res.status).toBe(400);
  });

  test("404 for non-artifact alert id", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertAlert(db, { source: "triage", external_id: "ext-x", severity: "medium", headline: "Not artifact", body: "b" })!;
    const { res } = await req(app, `/artifacts/alert:${id}`);
    expect(res.status).toBe(404);
  });

  test("404 for unknown run id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/artifacts/run:does-not-exist");
    expect(res.status).toBe(404);
  });

  test("404 for non-integer alert id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/artifacts/alert:abc");
    expect(res.status).toBe(404);
  });
});

// ── POST /artifacts/{id}/archive ───────────────────────────────────────

describe("POST /artifacts/{id}/archive", () => {
  test("archives an alert-backed artifact", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertArtifactAlert(db, "To Archive");
    const { res, body } = await req(app, `/artifacts/alert:${id}/archive`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((body as { status: string }).status).toBe("archived");
    // Should not appear in default list.
    const { body: list } = await req(app, "/artifacts");
    expect((list as { artifacts: unknown[] }).artifacts).toEqual([]);
  });

  test("archives a run-backed artifact", async () => {
    const db = openDb();
    const app = appWith(db);
    insertRun(db, "run-arch", "Run Arch");
    const { res } = await req(app, "/artifacts/run:run-arch/archive", { method: "POST" });
    expect(res.status).toBe(200);
  });

  test("400 for malformed id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/artifacts/bad/archive", { method: "POST" });
    expect(res.status).toBe(400);
  });

  test("404 for non-artifact alert", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertAlert(db, { source: "triage", external_id: "ext-x", severity: "medium", headline: "Not artifact", body: "b" })!;
    const { res } = await req(app, `/artifacts/alert:${id}/archive`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ── POST /artifacts/{id}/restore ───────────────────────────────────────

describe("POST /artifacts/{id}/restore", () => {
  test("restores an archived artifact", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertArtifactAlert(db, "Restore Me");
    await req(app, `/artifacts/alert:${id}/archive`, { method: "POST" });
    const { res, body } = await req(app, `/artifacts/alert:${id}/restore`, { method: "POST" });
    expect(res.status).toBe(200);
    expect((body as { status: string }).status).toBe("restored");
    const { body: list } = await req(app, "/artifacts");
    expect((list as { artifacts: unknown[] }).artifacts.length).toBe(1);
  });

  test("404 for non-existent artifact", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/artifacts/alert:9999/restore", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ── DELETE /artifacts/{id} ─────────────────────────────────────────────

describe("DELETE /artifacts/{id}", () => {
  test("deletes an alert-backed artifact", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertArtifactAlert(db, "Delete Me");
    const { res, body } = await req(app, `/artifacts/alert:${id}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    expect((body as { status: string }).status).toBe("deleted");
    const { res: getRes } = await req(app, `/artifacts/alert:${id}`);
    expect(getRes.status).toBe(404);
  });

  test("deletes a run-backed artifact", async () => {
    const db = openDb();
    const app = appWith(db);
    insertRun(db, "run-del", "Run Del");
    const { res } = await req(app, "/artifacts/run:run-del", { method: "DELETE" });
    expect(res.status).toBe(200);
  });

  test("400 for malformed id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/artifacts/bad", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  test("404 for non-artifact alert", async () => {
    const db = openDb();
    const app = appWith(db);
    const id = insertAlert(db, { source: "triage", external_id: "ext-x", severity: "medium", headline: "Not artifact", body: "b" })!;
    const { res } = await req(app, `/artifacts/alert:${id}`, { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

/**
 * Spec for workflows — catalog, runs, and dynamic (custom) workflows.
 *
 * Ported from `api/routes/workflows.py` contract: list/get, run CRUD,
 * custom CRUD, validation, and SSE run creation. Every test verifies what its
 * name claims — no silent fallbacks.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";

function fakeProvider(): Provider {
  return { name: "fake", defaultModel: "fake-model", async chat() { return "ok"; } };
}

function fakeSettings(): Settings {
  return {
    dbPath: ":memory:",
    port: 8787,
    publicServerUrl: "",
    allowedOrigins: [],
    morningBriefTime: "08:00",
    eodDigestTime: "18:00",
    reflectionTime: "07:30",
    scheduledAdminToken: "",
    provider: { name: "deepseek", baseUrl: "https://api.deepseek.com", apiKey: "test", model: "deepseek-chat", reasoningModel: "deepseek-reasoner", routingModel: "deepseek-chat", headers: {} },
  };
}

function appWith(db: ReturnType<typeof openDb>) {
  return createApp({ settings: fakeSettings(), db, provider: fakeProvider() });
}

async function req(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app(new Request(`http://localhost${path}`, init));
  const body: unknown = await res.json().catch(() => null);
  const text = body === null ? await res.text().catch(() => "") : null;
  return { res, body, text };
}

async function sseReq(app: ReturnType<typeof createApp>, path: string, init?: RequestInit) {
  const res = await app(new Request(`http://localhost${path}`, init));
  const text = await res.text();
  return { res, text };
}

describe("GET /workflows", () => {
  test("lists built-in workflows", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/workflows");
    expect(res.status).toBe(200);
    const b = body as { workflows: unknown[] };
    expect(b.workflows.length).toBeGreaterThan(10);
  });

  test("includes custom workflows when present", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/workflows/custom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "my_custom_flow", title: "My Flow", description: "test" }),
    });
    const { body } = await req(app, "/workflows");
    const b = body as { workflows: Array<{ name: string }> };
    expect(b.workflows.some((w) => w.name === "my_custom_flow")).toBe(true);
  });
});

describe("GET /workflows/{name}", () => {
  test("returns a built-in workflow", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/workflows/board_prep");
    expect(res.status).toBe(200);
    expect((body as { name: string }).name).toBe("board_prep");
  });

  test("404 for unknown workflow", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/workflows/does_not_exist");
    expect(res.status).toBe(404);
  });
});

describe("GET /workflows/runs", () => {
  test("empty when no runs", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/workflows/runs");
    expect(res.status).toBe(200);
    expect((body as { runs: unknown[] }).runs).toHaveLength(0);
  });

  test("lists runs after creation", async () => {
    const db = openDb();
    const app = appWith(db);
    await sseReq(app, "/workflows/board_prep/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "Q1 review" }),
    });
    const { body } = await req(app, "/workflows/runs");
    expect((body as { runs: unknown[] }).runs).toHaveLength(1);
  });

  test("filters by workflow name", async () => {
    const db = openDb();
    const app = appWith(db);
    await sseReq(app, "/workflows/board_prep/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    await sseReq(app, "/workflows/annual_plan/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const { body } = await req(app, "/workflows/runs?workflow=board_prep");
    const runs = (body as { runs: Array<{ workflow_name: string }> }).runs;
    expect(runs.every((r) => r.workflow_name === "board_prep")).toBe(true);
  });
});

describe("GET /workflows/runs/{run_id}", () => {
  test("returns a run by id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { text } = await sseReq(app, "/workflows/board_prep/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    // Extract run_id from SSE
    const match = text.match(/"run_id"\s*:\s*"([^"]+)"/);
    expect(match).not.toBeNull();
    const runId = match?.[1] as string;
    const { res, body } = await req(app, `/workflows/runs/${runId}`);
    expect(res.status).toBe(200);
    expect((body as { run_id: string }).run_id).toBe(runId);
  });

  test("404 for unknown run", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/workflows/runs/doesnotexist");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /workflows/runs/{run_id}", () => {
  test("deletes a run", async () => {
    const db = openDb();
    const app = appWith(db);
    const { text } = await sseReq(app, "/workflows/board_prep/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const runId = text.match(/"run_id"\s*:\s*"([^"]+)"/)?.[1] as string;
    const { res } = await req(app, `/workflows/runs/${runId}`, { method: "DELETE" });
    expect(res.status).toBe(200);
    const { res: res2 } = await req(app, `/workflows/runs/${runId}`);
    expect(res2.status).toBe(404);
  });

  test("404 for unknown run", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/workflows/runs/unknown", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

describe("POST /workflows/{name}/runs", () => {
  test("creates a run and streams SSE", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, text } = await sseReq(app, "/workflows/board_prep/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ topic: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(text).toContain("run_created");
    expect(text).toContain("done");
  });

  test("404 for unknown workflow", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await sseReq(app, "/workflows/unknown/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(404);
  });

  test("400 for invalid JSON body", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await sseReq(app, "/workflows/board_prep/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json",
    });
    expect(res.status).toBe(400);
  });
});

describe("custom workflows CRUD", () => {
  test("POST /workflows/custom creates a definition", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/workflows/custom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "my_flow", title: "My Flow" }),
    });
    expect(res.status).toBe(201);
    expect((body as { name: string }).name).toBe("my_flow");
  });

  test("409 on duplicate name", async () => {
    const db = openDb();
    const app = appWith(db);
    const payload = JSON.stringify({ name: "dup_flow", title: "Dup" });
    await req(app, "/workflows/custom", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    const { res } = await req(app, "/workflows/custom", { method: "POST", headers: { "content-type": "application/json" }, body: payload });
    expect(res.status).toBe(409);
  });

  test("422 on invalid name", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/workflows/custom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Bad-Name", title: "Bad" }),
    });
    expect(res.status).toBe(422);
  });

  test("422 on built-in collision", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/workflows/custom", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "board_prep", title: "Collision" }),
    });
    expect(res.status).toBe(422);
  });

  test("GET /workflows/custom/{name} returns the definition", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/workflows/custom", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "get_flow", title: "Get Flow" }) });
    const { res, body } = await req(app, "/workflows/custom/get_flow");
    expect(res.status).toBe(200);
    expect((body as { name: string }).name).toBe("get_flow");
  });

  test("GET /workflows/custom/{name} 404 for unknown", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/workflows/custom/unknown_flow");
    expect(res.status).toBe(404);
  });

  test("PUT /workflows/custom/{name} updates", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/workflows/custom", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "upd_flow", title: "Orig" }) });
    const { res, body } = await req(app, "/workflows/custom/upd_flow", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "upd_flow", title: "Updated" }),
    });
    expect(res.status).toBe(200);
    expect((body as { title: string }).title).toBe("Updated");
  });

  test("PUT 422 when path name mismatches body name", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/workflows/custom", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "mismatch_flow", title: "Orig" }) });
    const { res } = await req(app, "/workflows/custom/mismatch_flow", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "other_name", title: "Other" }),
    });
    expect(res.status).toBe(422);
  });

  test("DELETE /workflows/custom/{name} deletes", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/workflows/custom", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "del_flow", title: "Del" }) });
    const { res } = await req(app, "/workflows/custom/del_flow", { method: "DELETE" });
    expect(res.status).toBe(200);
    const { res: res2 } = await req(app, "/workflows/custom/del_flow");
    expect(res2.status).toBe(404);
  });

  test("POST /workflows/custom/{name}/activate toggles active", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/workflows/custom", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "act_flow", title: "Act" }) });
    const { res, body } = await req(app, "/workflows/custom/act_flow/activate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_active: false }),
    });
    expect(res.status).toBe(200);
    expect((body as { is_active: boolean }).is_active).toBe(false);
  });

  test("GET /workflows/custom lists all definitions", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/workflows/custom", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "list_flow_a", title: "A" }) });
    await req(app, "/workflows/custom", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "list_flow_b", title: "B" }) });
    const { body } = await req(app, "/workflows/custom");
    const defs = (body as { definitions: unknown[] }).definitions;
    expect(defs.length).toBeGreaterThanOrEqual(2);
  });
});

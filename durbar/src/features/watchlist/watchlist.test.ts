import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp } from "../../index.ts";
import type { Settings } from "../../config.ts";
import type { Provider } from "../../providers.ts";
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
    eodDigestTime: "18:00",
    reflectionTime: "07:30",
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
  return createApp({ settings: fakeSettings(), db, provider: fakeProvider() });
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

describe("watchlist", () => {
  test("create and get", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "vendor-aws",
        signal_type: "vendor_status",
        target: "aws",
      }),
    });
    expect(res.status).toBe(201);
    expect((body as { slug: string }).slug).toBe("vendor-aws");
    const { body: fetched } = await req(app, "/watchlist/vendor-aws");
    expect((fetched as { slug: string }).slug).toBe("vendor-aws");
  });
  test("409 on duplicate slug", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "dup",
        signal_type: "rss",
        target: "https://example.com/feed",
      }),
    });
    const { res } = await req(app, "/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "dup",
        signal_type: "rss",
        target: "https://example.com/feed2",
      }),
    });
    expect(res.status).toBe(409);
  });
  test("400 on invalid slug", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "Bad_Slug!",
        signal_type: "rss",
        target: "https://example.com",
      }),
    });
    expect(res.status).toBe(400);
  });
  test("404 for unknown slug", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/watchlist/does-not-exist");
    expect(res.status).toBe(404);
  });
  test("patch watchlist", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "to-patch",
        signal_type: "rss",
        target: "https://example.com/feed",
      }),
    });
    const { body } = await req(app, "/watchlist/to-patch", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });
    expect((body as { enabled: boolean }).enabled).toBe(false);
  });
  test("delete watchlist", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "to-delete",
        signal_type: "rss",
        target: "https://example.com/feed",
      }),
    });
    const { res } = await req(app, "/watchlist/to-delete", {
      method: "DELETE",
    });
    expect(res.status).toBe(204);
    const { res: r2 } = await req(app, "/watchlist/to-delete");
    expect(r2.status).toBe(404);
  });
  test("signals empty", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "sig-test",
        signal_type: "rss",
        target: "https://example.com/feed",
      }),
    });
    const { body } = await req(app, "/watchlist/sig-test/signals");
    expect(Array.isArray(body)).toBe(true);
  });
  test("approve and decline", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "to-approve",
        signal_type: "rss",
        target: "https://example.com/feed",
      }),
    });
    const { res: ar } = await req(app, "/watchlist/to-approve/approve", {
      method: "POST",
    });
    expect(ar.status).toBe(200);
    await req(app, "/watchlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        slug: "to-decline",
        signal_type: "rss",
        target: "https://example.com/feed2",
      }),
    });
    const { body: declined } = await req(app, "/watchlist/to-decline/decline", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason: "not_relevant" }),
    });
    expect((declined as { result: string }).result).toBe("removed");
  });
});

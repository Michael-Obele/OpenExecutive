/**
 * Spec for company profile.
 *
 * Mirrors `api/routes/company_profile.py` + `memory/company_profile.py`:
 * GET returns 404 when empty, PATCH merges and persists, validation rejects
 * bad shapes, and the merge is idempotent.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import { createApp, type AppContext } from "../../index.ts";
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

async function json(path: string, app: ReturnType<typeof createApp>, init?: RequestInit) {
  const res = await app(new Request(`http://localhost${path}`, init));
  const body: unknown = await res.json().catch(() => null);
  return { res, body };
}

describe("GET /company-profile", () => {
  test("returns 404 when no profile exists", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await json("/company-profile", app);
    expect(res.status).toBe(404);
    expect((body as { error: string }).error).toMatch(/No company profile/);
  });

  test("returns the profile after a PATCH", async () => {
    const db = openDb();
    const app = appWith(db);

    // Seed via PATCH — first PATCH 404s when empty, so insert directly then verify GET.
    const { patchCompanyProfile } = await import("./company.ts");
    patchCompanyProfile(db, { name: "Acme", industry: "SaaS" });

    const { res, body } = await json("/company-profile", app);
    expect(res.status).toBe(200);
    expect((body as { name: string }).name).toBe("Acme");
    expect((body as { industry: string }).industry).toBe("SaaS");
  });
});

describe("PATCH /company-profile", () => {
  test("returns 404 when no profile exists yet", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await json("/company-profile", app, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Acme" }),
    });
    expect(res.status).toBe(404);
  });

  test("upserts with validation — happy path", async () => {
    const db = openDb();
    const { patchCompanyProfile } = await import("./company.ts");
    patchCompanyProfile(db, { name: "Acme" });
    const app = appWith(db);

    const { res, body } = await json("/company-profile", app, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ industry: "Fintech", headcount: 12 }),
    });
    expect(res.status).toBe(200);
    expect((body as { industry: string }).industry).toBe("Fintech");
    expect((body as { headcount: number }).headcount).toBe(12);
    // Existing name preserved.
    expect((body as { name: string }).name).toBe("Acme");
  });

  test("merges nested objects wholesale", async () => {
    const db = openDb();
    const { patchCompanyProfile } = await import("./company.ts");
    patchCompanyProfile(db, { name: "Acme" });
    const app = appWith(db);

    await json("/company-profile", app, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ target_customer: { profile: "SMBs", pain_points: ["churn"] } }),
    });
    const { body } = await json("/company-profile", app);
    expect((body as { target_customer: { profile: string } }).target_customer.profile).toBe("SMBs");
  });

  test("422 on invalid shape", async () => {
    const db = openDb();
    const { patchCompanyProfile } = await import("./company.ts");
    patchCompanyProfile(db, { name: "Acme" });
    const app = appWith(db);

    const { res } = await json("/company-profile", app, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ headcount: "twelve" }),
    });
    expect(res.status).toBe(422);
  });

  test("422 on non-object body", async () => {
    const db = openDb();
    const { patchCompanyProfile } = await import("./company.ts");
    patchCompanyProfile(db, { name: "Acme" });
    const app = appWith(db);

    const { res } = await json("/company-profile", app, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("not an object"),
    });
    expect(res.status).toBe(422);
  });

  test("idempotent — patching the same value twice yields the same profile", async () => {
    const db = openDb();
    const { patchCompanyProfile } = await import("./company.ts");
    patchCompanyProfile(db, { name: "Acme" });
    const app = appWith(db);

    const payload = JSON.stringify({ industry: "SaaS" });
    const first = await json("/company-profile", app, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    const second = await json("/company-profile", app, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    expect(first.body).toEqual(second.body);
  });

  test("vendors and tickers round-trip", async () => {
    const db = openDb();
    const { patchCompanyProfile } = await import("./company.ts");
    patchCompanyProfile(db, { name: "Acme" });
    const app = appWith(db);

    const { body } = await json("/company-profile", app, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vendors: ["Stripe", "AWS"], tickers: ["ACME"] }),
    });
    expect((body as { vendors: string[] }).vendors).toEqual(["Stripe", "AWS"]);
    expect((body as { tickers: string[] }).tickers).toEqual(["ACME"]);
  });
});

/**
 * Spec for people.
 *
 * Ported from `tests/unit/test_people_route.py` + `test_people_store.py`:
 * CRUD, archive (with principal protection), by-scope lookup, validation,
 * and filtering. Uses the HTTP layer so the contract is exercised end-to-end.
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

// ── list + get ───────────────────────────────────────────────────────────

describe("GET /people", () => {
  test("empty list", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/people");
    expect(res.status).toBe(200);
    expect(body).toEqual([]);
  });

  test("lists created people", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alice" }),
    });
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Bob" }),
    });
    const { body } = await req(app, "/people");
    expect((body as unknown[]).length).toBe(2);
  });

  test("principal sorts first", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Staff A" }),
    });
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "The Principal", is_principal: true }),
    });
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Staff B" }),
    });
    const { body } = await req(app, "/people");
    const list = body as Array<{ is_principal: boolean; full_name: string }>;
    expect(list[0]!.is_principal).toBe(true);
    expect(list[0]!.full_name).toBe("The Principal");
  });

  test("excludes archived by default", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Active" }),
    });
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "ToArchive" }),
    });
    const pid = (created as { id: number }).id;
    await req(app, `/people/${pid}/archive`, { method: "POST" });

    const { body } = await req(app, "/people");
    const names = (body as Array<{ full_name: string }>).map((p) => p.full_name);
    expect(names).toContain("Active");
    expect(names).not.toContain("ToArchive");
  });

  test("include_archived=true includes archived", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Active" }),
    });
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Archived" }),
    });
    const pid = (created as { id: number }).id;
    await req(app, `/people/${pid}/archive`, { method: "POST" });

    const { body } = await req(app, "/people?include_archived=true");
    const names = (body as Array<{ full_name: string }>).map((p) => p.full_name);
    expect(names).toContain("Active");
    expect(names).toContain("Archived");
  });
});

describe("GET /people/{id}", () => {
  test("returns a known person", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alex Rivera", role: "CEO", is_principal: true }),
    });
    const pid = (created as { id: number }).id;
    const { res, body } = await req(app, `/people/${pid}`);
    expect(res.status).toBe(200);
    expect((body as { full_name: string }).full_name).toBe("Alex Rivera");
    expect((body as { role: string }).role).toBe("CEO");
    expect((body as { is_principal: boolean }).is_principal).toBe(true);
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people/9999");
    expect(res.status).toBe(404);
  });

  test("archived person is still fetchable by id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Jamie" }),
    });
    const pid = (created as { id: number }).id;
    await req(app, `/people/${pid}/archive`, { method: "POST" });
    const { res, body } = await req(app, `/people/${pid}`);
    expect(res.status).toBe(200);
    expect((body as { archived: boolean }).archived).toBe(true);
  });
});

// ── create ───────────────────────────────────────────────────────────────

describe("POST /people", () => {
  test("creates with minimal fields", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alex Rivera" }),
    });
    expect(res.status).toBe(201);
    const data = body as { full_name: string; role: string; archived: boolean; id: number };
    expect(data.full_name).toBe("Alex Rivera");
    expect(data.role).toBe("");
    expect(data.archived).toBe(false);
    expect(data.id).toBeGreaterThan(0);
  });

  test("creates with all fields", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res, body } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        full_name: "Alex Rivera",
        role: "CEO",
        is_principal: true,
        email: "alex@example.com",
        preferred_channel: "email",
        authority_scope: ["wildcard"],
        response_sla_hours: 4,
        department_slugs: ["finance"],
        on_leave_until: "2026-08-01",
        availability: [{ weekdays: [1], start_local: "09:00", end_local: "13:00", timezone: "America/Los_Angeles" }],
      }),
    });
    expect(res.status).toBe(201);
    const data = body as {
      full_name: string;
      is_principal: boolean;
      email: string;
      authority_scope: string[];
      response_sla_hours: number;
      on_leave_until: string;
      availability: Array<{ weekdays: number[]; start_local: string }>;
    };
    expect(data.full_name).toBe("Alex Rivera");
    expect(data.is_principal).toBe(true);
    expect(data.email).toBe("alex@example.com");
    expect(data.authority_scope).toContain("wildcard");
    expect(data.response_sla_hours).toBe(4);
    expect(data.on_leave_until).toBe("2026-08-01");
    expect(data.availability).toHaveLength(1);
    expect(data.availability[0]!.weekdays).toEqual([1]);
  });

  test("422 on blank full_name", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "" }),
    });
    expect(res.status).toBe(422);
  });

  test("422 on missing full_name", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(422);
  });

  test("422 on invalid authority_scope token", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alex", authority_scope: ["spend_lt_1m"] }),
    });
    expect(res.status).toBe(422);
  });

  test("422 on invalid preferred_channel", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alex", preferred_channel: "pigeon" }),
    });
    expect(res.status).toBe(422);
  });

  test("422 on invalid response_sla_hours", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alex", response_sla_hours: 0 }),
    });
    expect(res.status).toBe(422);
  });

  test("422 on invalid on_leave_until", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alex", on_leave_until: "next tuesday" }),
    });
    expect(res.status).toBe(422);
  });

  test("422 on invalid availability", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        full_name: "Alex",
        availability: [{ weekdays: [1], start_local: "9am", end_local: "13:00" }],
      }),
    });
    expect(res.status).toBe(422);
  });

  test("reports_to_person_id round-trips", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: manager } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Manager" }),
    });
    const managerId = (manager as { id: number }).id;
    const { body } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Report", reports_to_person_id: managerId }),
    });
    expect((body as { reports_to_person_id: number }).reports_to_person_id).toBe(managerId);
  });
});

// ── patch ────────────────────────────────────────────────────────────────

describe("PATCH /people/{id}", () => {
  test("updates fields", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Old Name", role: "CFO" }),
    });
    const pid = (created as { id: number }).id;
    const { res, body } = await req(app, `/people/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Sarah Chen", email: "s@co.com" }),
    });
    expect(res.status).toBe(200);
    expect((body as { full_name: string }).full_name).toBe("Sarah Chen");
    expect((body as { email: string }).email).toBe("s@co.com");
    expect((body as { role: string }).role).toBe("CFO");
  });

  test("replaces authority_scope", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Sarah", authority_scope: ["spend_gt_10k"] }),
    });
    const pid = (created as { id: number }).id;
    const { body } = await req(app, `/people/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authority_scope: ["legal_sign"] }),
    });
    expect((body as { authority_scope: string[] }).authority_scope).toEqual(["legal_sign"]);
  });

  test("clears authority_scope with empty array", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Sarah", authority_scope: ["spend_gt_10k"] }),
    });
    const pid = (created as { id: number }).id;
    const { body } = await req(app, `/people/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authority_scope: [] }),
    });
    expect((body as { authority_scope: string[] }).authority_scope).toEqual([]);
  });

  test("replaces availability", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Sarah" }),
    });
    const pid = (created as { id: number }).id;
    const { body } = await req(app, `/people/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        availability: [{ weekdays: [2], start_local: "10:00", end_local: "14:00", timezone: "UTC" }],
      }),
    });
    expect((body as { availability: unknown[] }).availability).toHaveLength(1);
  });

  test("clear_on_leave clears on_leave_until", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alex", on_leave_until: "2026-08-01" }),
    });
    const pid = (created as { id: number }).id;
    const { body } = await req(app, `/people/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ clear_on_leave: true }),
    });
    expect((body as { on_leave_until: string | null }).on_leave_until).toBeNull();
  });

  test("empty body is a no-op", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alex" }),
    });
    const pid = (created as { id: number }).id;
    const { res, body } = await req(app, `/people/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(200);
    expect((body as { full_name: string }).full_name).toBe("Alex");
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people/9999", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "X" }),
    });
    expect(res.status).toBe(404);
  });

  test("422 on invalid authority_scope", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alex" }),
    });
    const pid = (created as { id: number }).id;
    const { res } = await req(app, `/people/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ authority_scope: ["bogus"] }),
    });
    expect(res.status).toBe(422);
  });

  test("422 on blank full_name", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alex" }),
    });
    const pid = (created as { id: number }).id;
    const { res } = await req(app, `/people/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "" }),
    });
    expect(res.status).toBe(422);
  });
});

// ── archive ──────────────────────────────────────────────────────────────

describe("POST /people/{id}/archive", () => {
  test("archives and returns 204", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Jamie" }),
    });
    const pid = (created as { id: number }).id;
    const { res } = await req(app, `/people/${pid}/archive`, { method: "POST" });
    expect(res.status).toBe(204);

    const { body } = await req(app, `/people/${pid}`);
    expect((body as { archived: boolean }).archived).toBe(true);
  });

  test("archived person excluded from default listing", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Jamie" }),
    });
    const pid = (created as { id: number }).id;
    await req(app, `/people/${pid}/archive`, { method: "POST" });
    const { body } = await req(app, "/people");
    expect((body as Array<{ id: number }>).some((p) => p.id === pid)).toBe(false);
  });

  test("404 for unknown id", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people/9999/archive", { method: "POST" });
    expect(res.status).toBe(404);
  });

  test("principal protection — cannot archive the last principal", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "The Boss", is_principal: true }),
    });
    const pid = (created as { id: number }).id;
    const { res, body } = await req(app, `/people/${pid}/archive`, { method: "POST" });
    expect(res.status).toBe(409);
    expect((body as { error: string }).error).toMatch(/Cannot archive the last principal/);

    // Still not archived.
    const { body: fetched } = await req(app, `/people/${pid}`);
    expect((fetched as { archived: boolean }).archived).toBe(false);
  });

  test("principal can be archived when a replacement exists", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: p1 } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Boss One", is_principal: true }),
    });
    const { body: p2 } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Boss Two", is_principal: true }),
    });
    const pid1 = (p1 as { id: number }).id;
    const pid2 = (p2 as { id: number }).id;

    const { res } = await req(app, `/people/${pid1}/archive`, { method: "POST" });
    expect(res.status).toBe(204);

    // Second principal still there.
    const { body: fetched } = await req(app, `/people/${pid2}`);
    expect((fetched as { archived: boolean }).archived).toBe(false);
  });

  test("non-principal can always be archived", async () => {
    const db = openDb();
    const app = appWith(db);
    // Create a principal so the roster is not empty.
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Boss", is_principal: true }),
    });
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Staff" }),
    });
    const pid = (created as { id: number }).id;
    const { res } = await req(app, `/people/${pid}/archive`, { method: "POST" });
    expect(res.status).toBe(204);
  });
});

// ── by-scope ─────────────────────────────────────────────────────────────

describe("GET /people/by-scope/{token}", () => {
  test("returns matching scope", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Sarah", authority_scope: ["spend_gt_10k"] }),
    });
    const { res, body } = await req(app, "/people/by-scope/spend_gt_10k");
    expect(res.status).toBe(200);
    expect((body as unknown[]).length).toBe(1);
    expect((body as Array<{ full_name: string }>)[0]!.full_name).toBe("Sarah");
  });

  test("wildcard matches any token", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Founder", is_principal: true, authority_scope: ["wildcard"] }),
    });
    const { res, body } = await req(app, "/people/by-scope/legal_sign");
    expect(res.status).toBe(200);
    const names = (body as Array<{ full_name: string }>).map((p) => p.full_name);
    expect(names).toContain("Founder");
  });

  test("excludes archived", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Ex-CFO", authority_scope: ["spend_gt_10k"] }),
    });
    const pid = (created as { id: number }).id;
    await req(app, `/people/${pid}/archive`, { method: "POST" });
    const { body } = await req(app, "/people/by-scope/spend_gt_10k");
    expect((body as unknown[]).length).toBe(0);
  });

  test("non-principals sort before principal", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Founder", is_principal: true, authority_scope: ["wildcard"] }),
    });
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Sarah CFO", authority_scope: ["spend_gt_10k"], response_sla_hours: 4 }),
    });
    const { body } = await req(app, "/people/by-scope/spend_gt_10k");
    const list = body as Array<{ is_principal: boolean; full_name: string }>;
    expect(list).toHaveLength(2);
    expect(list[0]!.is_principal).toBe(false);
    expect(list[0]!.full_name).toBe("Sarah CFO");
    expect(list[1]!.is_principal).toBe(true);
  });

  test("SLA sort within non-principals", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Slow", authority_scope: ["hiring_signoff"], response_sla_hours: 48 }),
    });
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Fast", authority_scope: ["hiring_signoff"], response_sla_hours: 4 }),
    });
    const { body } = await req(app, "/people/by-scope/hiring_signoff");
    const list = body as Array<{ full_name: string }>;
    expect(list[0]!.full_name).toBe("Fast");
    expect(list[1]!.full_name).toBe("Slow");
  });

  test("returns empty when none match", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "No Scope Person" }),
    });
    const { body } = await req(app, "/people/by-scope/legal_sign");
    expect(body).toEqual([]);
  });

  test("400 for unknown token", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people/by-scope/do_whatever");
    expect(res.status).toBe(400);
  });

  test("400 error message lists valid tokens", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body } = await req(app, "/people/by-scope/bogus");
    expect((body as { error: string }).error).toMatch(/Valid tokens/);
  });
});

// ── findings fixes: principal demotion, archive idempotency, null handling, FK ──

describe("PATCH principal protection via is_principal", () => {
  test("demoting last principal → 409", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Solo Principal", is_principal: true }),
    });
    const pid = (created as { id: number }).id;
    const { res, body } = await req(app, `/people/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_principal: false }),
    });
    expect(res.status).toBe(409);
    expect((body as { error: string }).error).toMatch(/Cannot demote the last principal/);
    const { body: fetched } = await req(app, `/people/${pid}`);
    expect((fetched as { is_principal: boolean }).is_principal).toBe(true);
  });

  test("demoting when replacement exists → 200", async () => {
    const db = openDb();
    const app = appWith(db);
    await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Principal A", is_principal: true }),
    });
    const { body: p2 } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Principal B", is_principal: true }),
    });
    const pid2 = (p2 as { id: number }).id;
    const { res, body } = await req(app, `/people/${pid2}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ is_principal: false }),
    });
    expect(res.status).toBe(200);
    expect((body as { is_principal: boolean }).is_principal).toBe(false);
  });
});

describe("POST /people/{id}/archive idempotency", () => {
  test("archiving already archived → 204 (not 404)", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "ToArchive" }),
    });
    const pid = (created as { id: number }).id;
    const first = await req(app, `/people/${pid}/archive`, { method: "POST" });
    expect(first.res.status).toBe(204);
    const second = await req(app, `/people/${pid}/archive`, { method: "POST" });
    expect(second.res.status).toBe(204);
  });
});

describe("PATCH null handling for department_slugs", () => {
  test("department_slugs:null clears to []", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Dept Person", department_slugs: ["finance"] }),
    });
    const pid = (created as { id: number }).id;
    const { res, body } = await req(app, `/people/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ department_slugs: null }),
    });
    expect(res.status).toBe(200);
    expect((body as { department_slugs: string[] }).department_slugs).toEqual([]);
  });
});

describe("reports_to_person_id FK validation", () => {
  test("POST with non-existent reports_to_person_id → 422", async () => {
    const db = openDb();
    const app = appWith(db);
    const { res } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Orphan", reports_to_person_id: 9999 }),
    });
    expect(res.status).toBe(422);
  });

  test("PATCH with non-existent reports_to_person_id → 422", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: created } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Alice" }),
    });
    const pid = (created as { id: number }).id;
    const { res } = await req(app, `/people/${pid}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reports_to_person_id: 9999 }),
    });
    expect(res.status).toBe(422);
  });

  test("reports_to archived person → 422", async () => {
    const db = openDb();
    const app = appWith(db);
    const { body: target } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Target" }),
    });
    const targetId = (target as { id: number }).id;
    await req(app, `/people/${targetId}/archive`, { method: "POST" });
    const { res } = await req(app, "/people", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ full_name: "Reporter", reports_to_person_id: targetId }),
    });
    expect(res.status).toBe(422);
  });
});

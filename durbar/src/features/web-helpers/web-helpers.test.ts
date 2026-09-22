/**
 * Tests for web helpers — durbar client URL handling + remote Valibot schemas.
 * Hermetic: no network, validates URL construction and schema validation directly.
 */
import { describe, test, expect } from "bun:test";
import * as v from "valibot";

// ── URL helpers (mirrors durbar.ts baseUrl + path join) ──────────────────
function baseUrl(raw: string | undefined): string {
  const trimmed = raw?.trim();
  if (trimmed && trimmed.length > 0) return trimmed.replace(/\/$/, "");
  return "http://localhost:8787";
}

function buildUrl(
  base: string,
  path: string,
  query?: Record<string, string>,
): URL {
  const url = new URL(`${base}/${path.replace(/^\//, "")}`);
  if (query)
    for (const [k, vv] of Object.entries(query)) url.searchParams.set(k, vv);
  return url;
}

describe("baseUrl trimming", () => {
  test("trims trailing slash", () => {
    expect(baseUrl("https://example.com/")).toBe("https://example.com");
  });
  test("trims whitespace", () => {
    expect(baseUrl("  https://example.com/  ")).toBe("https://example.com");
  });
  test("falls back when empty", () => {
    expect(baseUrl(undefined)).toBe("http://localhost:8787");
    expect(baseUrl("")).toBe("http://localhost:8787");
    expect(baseUrl("   ")).toBe("http://localhost:8787");
  });
  test("preserves path without trailing slash", () => {
    expect(baseUrl("https://example.com/api")).toBe("https://example.com/api");
  });
});

describe("buildUrl query/header merging", () => {
  test("joins base and path", () => {
    expect(buildUrl("https://example.com", "/test/path").toString()).toBe(
      "https://example.com/test/path",
    );
  });
  test("merges query params", () => {
    const url = buildUrl("https://example.com", "/search", {
      q: "hello world",
      limit: "10",
    });
    expect(url.searchParams.get("q")).toBe("hello world");
    expect(url.searchParams.get("limit")).toBe("10");
  });
  test("handles path without leading slash", () => {
    expect(buildUrl("https://example.com", "test").toString()).toBe(
      "https://example.com/test",
    );
  });
});

describe("204 handling — empty body returns undefined", () => {
  test("empty text returns undefined (simulates 204)", () => {
    const text = "";
    const result = text ? JSON.parse(text) : undefined;
    expect(result).toBeUndefined();
  });
  test("non-empty text parses JSON", () => {
    const text = JSON.stringify({ hello: "world" });
    const result = text ? JSON.parse(text) : undefined;
    expect((result as { hello: string }).hello).toBe("world");
  });
});

// ── Valibot schemas (mirrors remote modules) ─────────────────────────────

describe("departments validation", () => {
  const schema = v.object({
    title: v.pipe(v.string(), v.minLength(1, "Title is required")),
    mission: v.optional(v.string()),
  });
  test("rejects empty title", () =>
    expect(v.safeParse(schema, { title: "" }).success).toBe(false));
  test("accepts valid title", () =>
    expect(v.safeParse(schema, { title: "Engineering" }).success).toBe(true));
  test("rejects missing title", () =>
    expect(v.safeParse(schema, {}).success).toBe(false));
});

describe("people validation", () => {
  const schema = v.object({
    full_name: v.pipe(v.string(), v.minLength(1, "Name is required")),
    role: v.optional(v.string()),
    is_principal: v.optional(v.boolean()),
  });
  test("rejects empty full_name", () =>
    expect(v.safeParse(schema, { full_name: "" }).success).toBe(false));
  test("accepts valid full_name", () =>
    expect(v.safeParse(schema, { full_name: "Alice" }).success).toBe(true));
});

describe("workflows validation", () => {
  const schema = v.object({
    workflowName: v.pipe(v.string(), v.minLength(1)),
    inputs: v.optional(v.record(v.string(), v.unknown()), {}),
  });
  test("rejects empty workflowName", () =>
    expect(v.safeParse(schema, { workflowName: "" }).success).toBe(false));
  test("accepts valid workflowName", () =>
    expect(v.safeParse(schema, { workflowName: "annual_plan" }).success).toBe(
      true,
    ));
});

describe("chat getSessionMessages — v.string() id", () => {
  test("accepts string id", () =>
    expect(v.safeParse(v.string(), "abc-123").success).toBe(true));
  test("rejects non-string", () =>
    expect(v.safeParse(v.string(), 123).success).toBe(false));
  test("encodes id in path", () => {
    const id = "a/b c";
    expect(`/sessions/${encodeURIComponent(id)}/messages`).toBe(
      "/sessions/a%2Fb%20c/messages",
    );
  });
});

describe("knowledge search validation", () => {
  const schema = v.object({
    query: v.pipe(v.string(), v.minLength(1, "Query is required")),
  });
  test("rejects empty query", () =>
    expect(v.safeParse(schema, { query: "" }).success).toBe(false));
  test("accepts non-empty query", () =>
    expect(v.safeParse(schema, { query: "pricing" }).success).toBe(true));
});

describe("audit validation", () => {
  const schema = v.object({
    event_type: v.optional(v.string()),
    limit: v.optional(v.number()),
  });
  test("accepts empty filter", () =>
    expect(v.safeParse(schema, {}).success).toBe(true));
  test("accepts event_type filter", () =>
    expect(v.safeParse(schema, { event_type: "chat_turn" }).success).toBe(
      true,
    ));
});

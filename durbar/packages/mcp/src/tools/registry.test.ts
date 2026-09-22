/**
 * Regression guard for the tool surface.
 *
 * Pins tool names and action counts — a silent change here silently
 * invalidates docs. Hermetic: `fetch` is replaced with a recorder, so tests
 * assert the real method/path/body the generic handler produced without
 * needing a running Durbar server.
 *
 * Run: `bun test`
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { HttpTransport } from "@tmcp/transport-http";
import { createServer } from "../server.ts";

interface Call {
  path: string;
  method: string;
  body: unknown;
  headers: Record<string, string>;
  redirect: RequestInit["redirect"];
}

const calls: Call[] = [];
let responder: (url: URL) => { status: number; body?: unknown } = () => ({
  status: 200,
  body: {},
});
let streamOverride: ((url: URL) => Response | null) | null = null;

const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(String(input));
  calls.push({
    path: url.pathname + (url.search || ""),
    method: init.method ?? "GET",
    body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
    headers: (init.headers ?? {}) as Record<string, string>,
    redirect: init.redirect,
  });
  const { status, body } = responder(url);
  const overridden = streamOverride?.(url);
  if (overridden) return overridden;
  return new Response(body === undefined ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

const transport = new HttpTransport(createServer(), { path: "/mcp" });

async function rpc(method: string, params: unknown, id = 1): Promise<Record<string, unknown>> {
  const response = await transport.respond(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    }),
  );
  const text = await response!.text();
  for (const frame of text.split("\n\n").filter(Boolean)) {
    const dataLine = frame.split("\n").find((line) => line.startsWith("data:"));
    const payload = dataLine ? dataLine.slice(5).trim() : frame.trim();
    if (!payload.startsWith("{")) continue;
    const message = JSON.parse(payload) as Record<string, unknown>;
    if ((message as { id?: unknown }).id === id) return message as Record<string, unknown>;
  }
  throw new Error(`no response frame for ${method}: ${text.slice(0, 300)}`);
}

async function call(name: string, args: Record<string, unknown>, id = 2): Promise<{ text: string; isError: boolean }> {
  const message = await rpc("tools/call", { name, arguments: args }, id);
  const err = (message as { error?: { message?: string } }).error;
  if (err) {
    return { text: String(err.message ?? ""), isError: true };
  }
  const result = (message as { result?: { content?: Array<{ text?: string }>; isError?: boolean } }).result;
  return {
    text: (result?.content?.[0]?.text ?? "") as string,
    isError: Boolean(result?.isError),
  };
}

beforeEach(() => {
  calls.length = 0;
  responder = () => ({ status: 200, body: {} });
  streamOverride = null;
});

describe("tool surface", () => {
  test("exposes 8 domain tools with the documented action counts", async () => {
    const msg = await rpc("tools/list", {});
    type CountTool = { name: string; inputSchema: { oneOf?: unknown[] } };
    const result = (msg as unknown as { result: { tools: CountTool[] } }).result;
    const tools = result.tools;
    const counts = Object.fromEntries(tools.map((tool) => [tool.name, (tool.inputSchema.oneOf ?? []).length]));

    expect(counts).toEqual({
      oe_company: 16,
      oe_people: 6,
      oe_departments: 8,
      oe_knowledge: 17,
      oe_artifacts: 5,
      oe_talent: 21,
      oe_watchlist: 8,
      oe_operations: 20,
    });
    expect(Object.values(counts).reduce((a, b) => a + b, 0)).toBe(101);
  });

  test("every action variant carries an action literal and clients see a typed object", async () => {
    const msg = await rpc("tools/list", {});
    type ToolEntry = { name: string; inputSchema: { type?: string; oneOf?: Array<{ properties?: { action?: { const?: string } } }> } };
    const result = (msg as unknown as { result: { tools: ToolEntry[] } }).result;
    for (const tool of result.tools) {
      expect(tool.inputSchema.type).toBe("object");
      for (const variant of tool.inputSchema.oneOf ?? []) {
        expect(typeof variant.properties?.action?.const).toBe("string");
      }
    }
  });

  test("rejects an unknown action instead of silently doing nothing", async () => {
    const result = await call("oe_people", { action: "nope" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Invalid arguments/);
  });

  test("rejects a missing path parameter", async () => {
    const result = await call("oe_people", { action: "get", person_id: "" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/is required/);
  });

  test("rejects a mistyped field instead of silently dropping it", async () => {
    const result = await call("oe_departments", {
      action: "update",
      slug: "finance",
      tittle: "Money",
    });
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("generic handler", () => {
  test("patch_profile sends the profile as the body itself, not wrapped", async () => {
    responder = () => ({ status: 200, body: { mission: "X" } });
    await call("oe_company", { action: "patch_profile", profile: { mission: "X" } });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.path).toBe("/company-profile");
    expect(calls[0]!.body).toEqual({ mission: "X" });
  });

  test("keeps an explicit null on a field the backend clears", async () => {
    await call("oe_departments", { action: "update", slug: "finance", head_person_id: null });
    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.path).toBe("/departments/finance");
    expect(calls[0]!.body).toEqual({ head_person_id: null });
  });

  test("rejects null on a field the backend cannot clear", async () => {
    const result = await call("oe_departments", { action: "update", slug: "finance", headcount: null }, 9);
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("omits undefined optional fields rather than sending null", async () => {
    await call("oe_departments", { action: "update", slug: "finance", title: "Money" });
    expect(calls[0]!.body).toEqual({ title: "Money" });
  });

  test("forwards false and 0 as query values", async () => {
    await call("oe_people", { action: "list", include_archived: false });
    expect(calls[0]!.path).toBe("/people?include_archived=false");

    await call("oe_operations", { action: "list_runs", limit: 0 }, 3);
    expect(calls[1]!.path).toBe("/workflows/runs?limit=0");
  });

  test("refuses an update that supplies no fields", async () => {
    const result = await call("oe_departments", { action: "update", slug: "finance" }, 4);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/at least one field/);
    expect(calls).toHaveLength(0);
  });

  test("requires charter.mission, which a replace-wholesale charter cannot omit", async () => {
    const result = await call("oe_departments", { action: "update", slug: "finance", charter: { scope: ["pricing"] } }, 5);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/mission/);
    expect(calls).toHaveLength(0);
  });

  test("keeps a partial chat reply when the stream itself fails", async () => {
    streamOverride = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"type":"chunk","content":"half an answer","session_id":"S9"}\n\n'));
            setTimeout(() => controller.error(new Error("socket reset mid-stream")), 10);
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const result = await call("oe_company", { action: "ask", message: "hi" }, 8);
    const payload = JSON.parse(result.text) as Record<string, unknown>;
    expect(payload.reply).toBe("half an answer");
    expect(payload.session_id).toBe("S9");
    expect(payload.incomplete).toBe(true);
    expect(String(payload.stream_error)).toMatch(/socket reset/);
  });

  test("refuses a dot-segment path parameter", async () => {
    const result = await call("oe_knowledge", { action: "get_document", filename: ".." });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/must not be a dot segment/);
    expect(calls).toHaveLength(0);
  });

  test("a 204 still yields a content block with text", async () => {
    responder = () => ({ status: 204 });
    const result = await rpc("tools/call", { name: "oe_people", arguments: { action: "archive", person_id: 7 } }, 5);
    const content = (result as { result: { content: Array<{ text?: string }> } }).result.content;
    expect(typeof content[0]!.text).toBe("string");
    expect(content[0]!.text!.length).toBeGreaterThan(0);
  });

  test("refuses to follow a redirect, which would replay the API key", async () => {
    responder = () => ({ status: 307 });
    const result = await call("oe_people", { action: "list" }, 6);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/refusing to replay the API key/);
    expect(calls[0]!.redirect).toBe("manual");
  });

  test("surfaces the backend's error detail", async () => {
    responder = () => ({ status: 422, body: { detail: [{ msg: "period_value required" }] } });
    const result = await call("oe_departments", { action: "add_goal", slug: "finance", period_value: "2026-Q3", key_result: "x", target: "y" }, 7);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/period_value required/);
  });

  test("surfaces error field as well as detail", async () => {
    responder = () => ({ status: 404, body: { error: "No company profile found. Complete onboarding first." } });
    const result = await call("oe_company", { action: "get_profile" }, 10);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/No company profile/);
  });
});

// Restore the real fetch so a stray test cannot leak the recorder.
process.on("exit", () => {
  globalThis.fetch = realFetch;
});

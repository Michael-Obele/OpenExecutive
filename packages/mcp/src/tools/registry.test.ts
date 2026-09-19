/**
 * Regression guard for the tool surface.
 *
 * There are no other tests in this package, and the numbers this file pins
 * (tool names, action counts) are repeated in `docs/mcp.md`, `README.md` and
 * `PLAN.md` — so a silent change here silently invalidates four documents.
 *
 * Everything is hermetic: `fetch` is replaced with a recorder, so the tests
 * assert the real method/path/body the generic handler in `registry.ts`
 * produced without needing a running backend.
 *
 * Run: `bun test`
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { HttpTransport } from "@tmcp/transport-http";
import { createServer } from "../server.js";

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
/** Set by a test that needs a non-JSON response (e.g. a broken SSE stream). */
let streamOverride: ((url: URL) => Response | null) | null = null;

const realFetch = globalThis.fetch;

globalThis.fetch = (async (
  input: RequestInfo | URL,
  init: RequestInit = {},
) => {
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

async function rpc(method: string, params: unknown, id = 1) {
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
    const message = JSON.parse(payload);
    if (message.id === id) return message;
  }
  throw new Error(`no response frame for ${method}: ${text.slice(0, 300)}`);
}

async function call(name: string, args: Record<string, unknown>, id = 2) {
  const message = await rpc("tools/call", { name, arguments: args }, id);
  // Schema failures come back as a JSON-RPC error, handler failures as a result
  // with `isError`; normalise both so tests read the same way.
  if (message.error) {
    return { text: String(message.error.message ?? ""), isError: true };
  }
  return {
    text: (message.result?.content?.[0]?.text ?? "") as string,
    isError: Boolean(message.result?.isError),
  };
}

beforeEach(() => {
  calls.length = 0;
  responder = () => ({ status: 200, body: {} });
  streamOverride = null;
});

describe("tool surface", () => {
  test("exposes 8 domain tools with the documented action counts", async () => {
    const { result } = await rpc("tools/list", {});
    const tools = result.tools as { name: string; inputSchema: any }[];
    const counts = Object.fromEntries(
      tools.map((tool) => [tool.name, (tool.inputSchema.oneOf ?? []).length]),
    );

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
    const { result } = await rpc("tools/list", {});
    for (const tool of result.tools as { name: string; inputSchema: any }[]) {
      // A union without a top-level type is rejected by strict MCP clients.
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
    // An empty string, not an absent key: an absent key fails Valibot's
    // required-field check, which would leave `execute()`'s own guard untested.
    const result = await call("oe_people", { action: "get", person_id: "" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/is required/);
  });

  test("rejects a mistyped field instead of silently dropping it", async () => {
    // `v.object` would strip `tittle`, leaving an empty body that several
    // routes answer 200 to. `v.strictObject` makes the typo loud.
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
    // Regression: wrapping it (`{profile: {...}}`) is dropped by Pydantic and
    // the route answers 200 having changed nothing.
    responder = () => ({ status: 200, body: { mission: "X" } });
    await call("oe_company", {
      action: "patch_profile",
      profile: { mission: "X" },
    });

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.path).toBe("/company-profile");
    expect(calls[0]!.body).toEqual({ mission: "X" });
  });

  test("keeps an explicit null on a field the backend clears", async () => {
    // `head_person_id` and the three channel ids are the fields where the store
    // treats an explicit null as "clear", so dropping it would make
    // un-assigning a department head impossible. `headcount: null` is *not*
    // such a field, and the schema deliberately rejects it — see the next test.
    await call("oe_departments", {
      action: "update",
      slug: "finance",
      head_person_id: null,
    });

    expect(calls[0]!.method).toBe("PATCH");
    expect(calls[0]!.path).toBe("/departments/finance");
    expect(calls[0]!.body).toEqual({ head_person_id: null });
  });

  test("rejects null on a field the backend cannot clear", async () => {
    // The store treats None as "omit" for headcount, so accepting null here
    // would report success for a call that changed nothing.
    const result = await call(
      "oe_departments",
      { action: "update", slug: "finance", headcount: null },
      9,
    );
    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("omits undefined optional fields rather than sending null", async () => {
    await call("oe_departments", {
      action: "update",
      slug: "finance",
      title: "Money",
    });

    expect(calls[0]!.body).toEqual({ title: "Money" });
  });

  test("forwards false and 0 as query values", async () => {
    await call("oe_people", { action: "list", include_archived: false });
    expect(calls[0]!.path).toBe("/people?include_archived=false");

    await call("oe_operations", { action: "list_runs", limit: 0 }, 3);
    expect(calls[1]!.path).toBe("/workflows/runs?limit=0");
  });

  test("refuses an update that supplies no fields", async () => {
    // Every PATCH route needs at least one field; some answer 400 and others
    // return 200 unchanged, so the guard makes both cases loud.
    const result = await call("oe_departments", { action: "update", slug: "finance" }, 4);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/at least one field/);
    expect(calls).toHaveLength(0);
  });

  test("requires charter.mission, which a replace-wholesale charter cannot omit", async () => {
    const result = await call(
      "oe_departments",
      { action: "update", slug: "finance", charter: { scope: ["pricing"] } },
      5,
    );
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/mission/);
    expect(calls).toHaveLength(0);
  });

  test("keeps a partial chat reply when the stream itself fails", async () => {
    // Regression: only an `{"type":"error"}` frame was intercepted, so a
    // reset/deadline threw away the assembled text and the session id.
    streamOverride = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                'data: {"type":"chunk","content":"half an answer","session_id":"S9"}\n\n',
              ),
            );
            // Error *after* the queued chunk is read: `controller.error()`
            // discards anything still queued, which would test nothing.
            setTimeout(() => controller.error(new Error("socket reset mid-stream")), 10);
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );

    const result = await call("oe_company", { action: "ask", message: "hi" }, 8);
    const payload = JSON.parse(result.text);
    expect(payload.reply).toBe("half an answer");
    expect(payload.session_id).toBe("S9");
    expect(payload.incomplete).toBe(true);
    expect(payload.stream_error).toMatch(/socket reset/);
  });

  test("refuses a dot-segment path parameter", async () => {
    const result = await call("oe_knowledge", {
      action: "get_document",
      filename: "..",
    });

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/must not be a dot segment/);
    // Nothing was sent: percent-encoding cannot help here, because `new URL()`
    // treats %2E as `.` and normalises `/documents/..` down to `/`.
    expect(calls).toHaveLength(0);
  });

  test("a 204 still yields a content block with text", async () => {
    // Regression: `JSON.stringify(undefined)` is undefined, which serialised as
    // a text block with no `text` field at all on every successful delete.
    responder = () => ({ status: 204 });
    const result = await rpc(
      "tools/call",
      { name: "oe_people", arguments: { action: "archive", person_id: 7 } },
      5,
    );

    expect(typeof result.result.content[0].text).toBe("string");
    expect(result.result.content[0].text.length).toBeGreaterThan(0);
  });

  test("refuses to follow a redirect, which would replay the API key", async () => {
    responder = () => ({ status: 307 });
    const result = await call("oe_people", { action: "list" }, 6);

    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/refusing to replay the API key/);
    // `redirect: "manual"` is what makes the 3xx observable at all; without it
    // fetch would follow the redirect and replay the header.
    expect(calls[0]!.redirect).toBe("manual");
  });

  test("surfaces the backend's error detail", async () => {
    responder = () => ({
      status: 422,
      body: { detail: [{ msg: "period_value required" }] },
    });
    const result = await call(
      "oe_departments",
      {
        action: "add_goal",
        slug: "finance",
        period_value: "2026-Q3",
        key_result: "x",
        target: "y",
      },
      7,
    );

    expect(result.isError).toBe(true);
    // 422 details are arrays; they must not be dropped as "Unprocessable Entity".
    expect(result.text).toMatch(/period_value required/);
  });
});

// Restore the real fetch so a stray test cannot leak the recorder.
process.on("exit", () => {
  globalThis.fetch = realFetch;
});

/**
 * HTTP entrypoint for the Open Executive MCP server.
 *
 * Run: `bun run src/http.ts`
 * Env: BACKEND_BASE_URL, BACKEND_SHARED_SECRET, MCP_PORT / PORT (default 8787)
 *
 * `PORT` is read as a fallback because Fly.io (and most container hosts) inject
 * it; `MCP_PORT` stays the local override so `make dev` is unaffected.
 */
import { serve } from "srvx";
import { HttpTransport } from "@tmcp/transport-http";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "./server.js";

const PORT = Number(process.env.MCP_PORT ?? process.env.PORT ?? 8787);
// `srvx` binds every interface when no hostname is given, and this transport
// authenticates nothing of its own — it forwards the shared secret to the
// backend. Loopback is therefore the default; a container sets
// MCP_HOST=0.0.0.0 because its port is published from outside the namespace.
const HOST = process.env.MCP_HOST ?? "127.0.0.1";
/**
 * Optional bearer gate. The transport authenticates nothing of its own, so
 * without this the server's safety rests entirely on network isolation
 * (loopback, or the private network). Setting MCP_AUTH_TOKEN is what makes a
 * *public* deployment safe; clients then send `Authorization: Bearer <token>`
 * (VS Code's mcp.json supports a `headers` block).
 */
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

function authorized(request: Request): boolean {
  if (!AUTH_TOKEN) return true;
  const provided = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${AUTH_TOKEN}`;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

const server = createServer();
const transport = new HttpTransport(server, {
  path: "/mcp",
  // Belt and braces: the transport rejects a genuinely cross-origin `Origin`.
  // It is NOT the whole control — its check returns early when `Origin` equals
  // the request's own origin, and a same-origin GET may omit the header
  // entirely — which is why the handler below refuses any `Origin` outright.
  allowedOrigins: [],
});

const instance = serve({
  port: PORT,
  hostname: HOST,
  async fetch(request: Request): Promise<Response> {
    // Unauthenticated liveness probe, mirroring the backend's `/health` — it
    // returns no configuration, so it is safe to leave open, and it gives
    // Docker/Fly something to check besides the JSON-RPC endpoint.
    if (new URL(request.url).pathname === "/health") {
      return Response.json({ status: "ok", server: "open-executive-mcp" });
    }
    // No MCP client is a browser, so any `Origin` header means a browser is
    // driving: refuse it. This is the load-bearing half of the rebinding
    // defence — a page on evil.example:8787 that later re-resolves to 127.0.0.1
    // is *same-origin*, sends no preflight, and may omit Origin entirely on a
    // simple GET, so the transport's own allowlist check does not see it.
    if (request.headers.get("origin")) {
      return new Response("Cross-origin requests are not accepted", { status: 403 });
    }
    if (!authorized(request)) {
      return new Response("Unauthorized", {
        status: 401,
        headers: { "www-authenticate": "Bearer" },
      });
    }
    const response = await transport.respond(request);
    if (response) return response;
    return new Response("Not Found", { status: 404 });
  },
});

/**
 * Fly.io stops a Machine with SIGTERM once `kill_timeout` expires (see
 * fly.toml). Closing the listener lets in-flight MCP requests finish instead
 * of being severed mid-response.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    Promise.resolve(instance.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}

console.log(`[mcp] HTTP listening on http://${HOST}:${PORT}/mcp`);

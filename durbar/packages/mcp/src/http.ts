/**
 * HTTP entrypoint for the Durbar MCP server.
 *
 * Run: `bun run src/http.ts`
 * Env: BACKEND_BASE_URL / DURBAR_URL, BACKEND_SHARED_SECRET / DURBAR_API_KEY, MCP_PORT / PORT (default 8788)
 */

import { serve } from "srvx";
import { HttpTransport } from "@tmcp/transport-http";
import { timingSafeEqual } from "node:crypto";
import { createServer } from "./server.ts";

const PORT = Number(process.env.MCP_PORT ?? process.env.PORT ?? 8788);
const HOST = process.env.MCP_HOST ?? "127.0.0.1";
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN ?? "";

function authorized(request: Request): boolean {
  if (!AUTH_TOKEN) return true;
  const provided = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${AUTH_TOKEN}`;
  if (provided.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

const server = createServer();
const transport = new HttpTransport(server, { path: "/mcp", allowedOrigins: [] });

const instance = serve({
  port: PORT,
  hostname: HOST,
  fetch: async (request: Request): Promise<Response> => {
    if (new URL(request.url).pathname === "/health") {
      return Response.json({ status: "ok", server: "durbar-mcp" });
    }
    if (request.headers.get("origin")) {
      return new Response("Cross-origin requests are not accepted", { status: 403 });
    }
    if (!authorized(request)) {
      return new Response("Unauthorized", { status: 401, headers: { "www-authenticate": "Bearer" } });
    }
    const response = await transport.respond(request);
    if (response) return response;
    return new Response("Not Found", { status: 404 });
  },
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    Promise.resolve(instance.close())
      .catch(() => undefined)
      .finally(() => process.exit(0));
  });
}

console.log(`[mcp] HTTP listening on http://${HOST}:${PORT}/mcp`);

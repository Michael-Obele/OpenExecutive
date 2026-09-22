#!/usr/bin/env bun
/**
 * Durbar MCP server — STDIO entrypoint.
 *
 * For HTTP, use `bun run src/http.ts` (port 8787 by default).
 * Both entrypoints share the same server from ./server.ts.
 */
import { StdioTransport } from "@tmcp/transport-stdio";
import { createServer } from "./server.ts";

const server = createServer();
const transport = new StdioTransport(server);
transport.listen();

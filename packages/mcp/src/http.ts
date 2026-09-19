/**
 * HTTP entrypoint for the Open Executive MCP server.
 *
 * Run: `bun run src/http.ts`
 * Env: BACKEND_BASE_URL, BACKEND_SHARED_SECRET, MCP_PORT (default 8787)
 */
import { serve } from 'srvx';
import { HttpTransport } from '@tmcp/transport-http';
import { createServer } from './server.js';

const PORT = Number(process.env.MCP_PORT ?? 8787);
const server = createServer();
const transport = new HttpTransport(server, { path: '/mcp' });

serve({
	port: PORT,
	async fetch(request: Request): Promise<Response> {
		const response = await transport.respond(request);
		if (response) return response;
		return new Response('Not Found', { status: 404 });
	}
});

console.log(`[mcp] HTTP listening on http://localhost:${PORT}/mcp`);

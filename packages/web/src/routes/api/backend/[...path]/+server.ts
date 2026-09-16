import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

const BACKEND_BASE = env.BACKEND_BASE_URL ?? 'http://localhost:8000';
const BACKEND_SHARED_SECRET = env.BACKEND_SHARED_SECRET ?? '';

// Streaming-aware proxy to the FastAPI backend. Ports
// `packages/ui/src/app/api/backend/[...path]/route.ts`:
// - Requires a verified Better Auth session (checked in hooks.server.ts,
//   re-checked here belt-and-suspenders so a stray client can't reach the backend).
// - Strips hop-by-hop + `x-caller-*` (re-stamped from session), stamps `x-api-key`.
// - Passes response through as a stream. Do not buffer (SSE chat).

function buildUpstream(
	request: Request,
	path: string,
	callerEmail: string | null
): {
	url: URL;
	init: RequestInit;
} {
	const url = new URL(`${BACKEND_BASE}/${path}`);
	const incoming = new URL(request.url);
	incoming.searchParams.forEach((v, k) => url.searchParams.append(k, v));

	const headers = new Headers();
	request.headers.forEach((value, key) => {
		const lower = key.toLowerCase();
		if (
			lower === 'host' ||
			lower === 'connection' ||
			lower === 'cookie' ||
			lower === 'authorization' ||
			lower === 'x-api-key' ||
			lower.startsWith('x-caller-') ||
			lower.startsWith('x-forwarded-')
		) {
			return;
		}
		headers.set(key, value);
	});

	if (BACKEND_SHARED_SECRET) headers.set('x-api-key', BACKEND_SHARED_SECRET);
	if (callerEmail) headers.set('x-caller-email', callerEmail.toLowerCase());

	const method = request.method;
	const init: RequestInit = {
		method,
		headers,
		body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
		// @ts-expect-error — `duplex` is valid in Node/Bun fetch but not in TS lib types yet.
		duplex: 'half'
	};
	return { url, init };
}

async function proxy(
	request: Request,
	restPath: string,
	callerEmail: string | null
): Promise<Response> {
	if (!callerEmail) {
		return Response.json({ error: 'unauthorized' }, { status: 401 });
	}
	const { url, init } = buildUpstream(request, restPath, callerEmail);
	const upstream = await fetch(url, init);

	const respHeaders = new Headers(upstream.headers);
	respHeaders.set('Cache-Control', 'no-cache, no-transform');
	respHeaders.set('X-Accel-Buffering', 'no');

	return new Response(upstream.body, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers: respHeaders
	});
}

function callerFromLocals(locals: App.Locals): string | null {
	return locals.user?.email?.toLowerCase() ?? null;
}

export const GET: RequestHandler = async ({ request, params, locals }) =>
	proxy(request, params.path, callerFromLocals(locals));
export const POST: RequestHandler = async ({ request, params, locals }) =>
	proxy(request, params.path, callerFromLocals(locals));
export const PATCH: RequestHandler = async ({ request, params, locals }) =>
	proxy(request, params.path, callerFromLocals(locals));
export const PUT: RequestHandler = async ({ request, params, locals }) =>
	proxy(request, params.path, callerFromLocals(locals));
export const DELETE: RequestHandler = async ({ request, params, locals }) =>
	proxy(request, params.path, callerFromLocals(locals));

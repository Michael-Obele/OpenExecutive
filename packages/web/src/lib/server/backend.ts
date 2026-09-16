// Server-side backend client — mirrors the Next.js proxy contract.
// UI stamps `x-api-key: BACKEND_SHARED_SECRET`, strips `x-caller-*`,
// re-stamps identity from the verified session. See AGENTS.md invariant 2.
import { env } from '$env/dynamic/private';

const BACKEND_BASE = env.BACKEND_BASE_URL ?? 'http://localhost:8000';
const BACKEND_SHARED_SECRET = env.BACKEND_SHARED_SECRET ?? '';

export interface BackendFetchOpts {
	method?: string;
	body?: BodyInit | null;
	contentType?: string;
	callerEmail?: string | null;
	query?: Record<string, string>;
	signal?: AbortSignal;
}

/** Server-side fetch to the FastAPI backend with identity stamping. Never buffers SSE. */
export async function backendFetch(path: string, opts: BackendFetchOpts = {}): Promise<Response> {
	const url = new URL(`${BACKEND_BASE}/${path.replace(/^\//, '')}`);
	if (opts.query) {
		for (const [k, v] of Object.entries(opts.query)) url.searchParams.append(k, v);
	}
	const headers = new Headers();
	if (opts.contentType) headers.set('content-type', opts.contentType);
	if (BACKEND_SHARED_SECRET) headers.set('x-api-key', BACKEND_SHARED_SECRET);
	if (opts.callerEmail) headers.set('x-caller-email', opts.callerEmail.toLowerCase());

	return fetch(url, {
		method: opts.method ?? 'GET',
		headers,
		body: opts.body ?? undefined,
		signal: opts.signal,
		// @ts-expect-error — `duplex` is valid in Node/Bun fetch but not in TS lib types yet.
		duplex: 'half'
	});
}

export async function backendJson<T>(path: string, opts: BackendFetchOpts = {}): Promise<T> {
	const res = await backendFetch(path, { contentType: 'application/json', ...opts });
	if (!res.ok) {
		let detail = res.statusText;
		try {
			const body = (await res.json()) as { detail?: string };
			if (body?.detail) detail = body.detail;
		} catch {
			// non-JSON body — fall through
		}
		throw new Error(`Backend ${opts.method ?? 'GET'} ${path} failed: ${detail}`);
	}
	return (await res.json()) as T;
}

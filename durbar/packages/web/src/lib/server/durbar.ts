/**
 * Server-side Durbar HTTP client.
 *
 * The dashboard never assumes same-origin — `DURBAR_PUBLIC_URL` is the only
 * difference between "everything in one container" and "frontend on Netlify,
 * backend on Fly". When unset, the local/Docker case falls back to
 * `http://localhost:8787`, which is Durbar's default `DURBAR_PORT`.
 *
 * Runs only on the server (remote functions + `+page.server.ts` load). Never
 * buffers SSE — chat and workflow streams are forwarded as-is.
 */
import { env } from '$env/dynamic/private';

function baseUrl(): string {
	const raw = env.DURBAR_PUBLIC_URL?.trim();
	if (raw && raw.length > 0) return raw.replace(/\/$/, '');
	return 'http://localhost:8787';
}

export interface DurbarFetchOpts {
	method?: string;
	body?: BodyInit | null | undefined;
	contentType?: string | undefined;
	query?: Record<string, string> | undefined;
	signal?: AbortSignal | undefined;
	headers?: Record<string, string> | undefined;
}

/** Server-side fetch to the Durbar Bun server. */
export async function durbarFetch(path: string, opts: DurbarFetchOpts = {}): Promise<Response> {
	const base = baseUrl();
	const url = new URL(`${base}/${path.replace(/^\//, '')}`);
	if (opts.query) {
		for (const [k, v] of Object.entries(opts.query)) url.searchParams.set(k, v);
	}
	const headers: Record<string, string> = { ...(opts.headers ?? {}) };
	if (opts.contentType !== undefined) headers['content-type'] = opts.contentType;

	return fetch(url, {
		method: opts.method ?? 'GET',
		headers,
		body: opts.body ?? null,
		signal: opts.signal ?? null
	});
}

export async function durbarJson<T>(path: string, opts: DurbarFetchOpts = {}): Promise<T> {
	const res = await durbarFetch(path, {
		contentType: 'application/json',
		...opts
	});
	if (!res.ok) {
		let detail = res.statusText;
		try {
			const body = (await res.json()) as { detail?: string; error?: string };
			if (body?.detail) detail = body.detail;
			else if (body?.error) detail = body.error;
		} catch {
			// non-JSON body
		}
		throw new Error(`Durbar ${opts.method ?? 'GET'} ${path} failed: ${detail} (${res.status})`);
	}
	if (res.status === 204) return undefined as T;
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

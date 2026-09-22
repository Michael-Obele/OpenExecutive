/**
 * Thin HTTP client for the Durbar backend.
 *
 * The MCP server never touches SQLite directly — it goes through the same HTTP
 * API the dashboard uses, so validation and behaviour stay identical.
 *
 * Durbar's API is unauthenticated for local use; an `x-api-key` header is
 * forwarded when `DURBAR_API_KEY` is set, mirroring the reference server's
 * shared-secret gate.
 */

const BACKEND_BASE_URL = process.env.BACKEND_BASE_URL ?? process.env.DURBAR_URL ?? "http://localhost:8787";
const BACKEND_SHARED_SECRET = process.env.BACKEND_SHARED_SECRET ?? process.env.DURBAR_API_KEY ?? "";

const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30_000);
const UPLOAD_TIMEOUT_MS = Number(process.env.MCP_UPLOAD_TIMEOUT_MS ?? 120_000);
const STREAM_TIMEOUT_MS = Number(process.env.MCP_STREAM_TIMEOUT_MS ?? 600_000);
const STREAM_MAX_BYTES = Number(process.env.MCP_STREAM_MAX_BYTES ?? 64 * 1024 * 1024);

export class BackendError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BackendError";
    this.status = status;
  }
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
}

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = {};
  if (BACKEND_SHARED_SECRET) headers["x-api-key"] = BACKEND_SHARED_SECRET;
  return headers;
}

function buildUrl(path: string, query?: Record<string, string>): URL {
  const url = new URL(`${BACKEND_BASE_URL}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.append(k, v);
  return url;
}

async function failure(res: Response, label: string): Promise<BackendError> {
  if (res.status >= 300 && res.status < 400) {
    return new BackendError(
      502,
      `Backend ${label} returned a ${res.status} redirect to ${res.headers.get("location") ?? "an unknown location"}; refusing to replay the API key to it`,
    );
  }
  let detail: string = res.statusText;
  try {
    const data = (await res.json()) as { detail?: unknown; error?: unknown };
    const raw = data?.detail ?? data?.error;
    if (raw !== undefined) {
      detail = typeof raw === "string" ? raw : JSON.stringify(raw);
    }
  } catch {
    // non-JSON error body
  }
  return new BackendError(res.status, `Backend ${label} failed (${res.status}): ${detail}`);
}

async function send(url: URL, init: RequestInit, label: string, timeoutMs: number): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new BackendError(504, `Backend ${label} did not respond within ${timeoutMs}ms`);
    }
    throw new BackendError(502, `Backend ${label} could not be reached: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw await failure(res, label);
  return res;
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function backend<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? "GET";
  const headers = authHeaders();
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await send(buildUrl(path, opts.query), { method, headers, body }, `${method} ${path}`, REQUEST_TIMEOUT_MS);
  return parse<T>(res);
}

export async function backendForm<T>(path: string, form: FormData): Promise<T> {
  const res = await send(buildUrl(path), { method: "POST", headers: authHeaders(), body: form }, `POST ${path}`, UPLOAD_TIMEOUT_MS);
  return parse<T>(res);
}

export async function backendEvents(
  path: string,
  body: unknown,
  onEvent: (event: Record<string, unknown>) => "keep-partial" | void,
): Promise<void> {
  const headers = authHeaders();
  headers["content-type"] = "application/json";
  const res = await send(buildUrl(path), { method: "POST", headers, body: JSON.stringify(body) }, `POST ${path}`, STREAM_TIMEOUT_MS);
  if (!res.body) throw new BackendError(502, `Backend POST ${path}: empty stream`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let received = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > STREAM_MAX_BYTES) {
        throw new BackendError(502, `Backend POST ${path} sent more than ${STREAM_MAX_BYTES} bytes; aborted to bound memory`);
      }
      buffer += decoder.decode(value, { stream: true });
      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);
        const payload = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!payload) continue;
        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          continue;
        }
        const keepPartial = onEvent(event);
        if (event.type === "error" && keepPartial !== "keep-partial") {
          throw new BackendError(502, `Backend POST ${path} streamed an error: ${String(event.message ?? "unknown")}`);
        }
      }
    }
  } catch (err) {
    if (err instanceof BackendError) throw err;
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new BackendError(504, `Backend POST ${path} did not finish within ${STREAM_TIMEOUT_MS}ms`);
    }
    throw new BackendError(502, `Backend POST ${path} stream failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function textResult(payload: unknown): { content: { type: "text"; text: string }[] } {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : (JSON.stringify(payload, null, 2) ?? "OK — the backend returned no content (204)."),
      },
    ],
  };
}

export function errorResult(err: unknown): { content: { type: "text"; text: string }[]; isError: true } {
  const message = err instanceof BackendError ? err.message : err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: message }], isError: true };
}

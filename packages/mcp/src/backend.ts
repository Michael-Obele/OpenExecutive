/**
 * Thin HTTP client for the Open Executive FastAPI backend.
 *
 * The TMCP server never touches SQLite/YAML directly — it goes through the
 * same API the SvelteKit UI uses, so validation, auth, and audit behaviour
 * stay identical no matter which client calls.
 *
 * Auth: the backend's shared-secret middleware gates every route except
 * /health. Pass `x-api-key: $BACKEND_SHARED_SECRET`, exactly like the UI's
 * `/api/backend/[...path]` proxy does.
 */

const BACKEND_BASE_URL =
  process.env.BACKEND_BASE_URL ?? "http://localhost:8000";
const BACKEND_SHARED_SECRET = process.env.BACKEND_SHARED_SECRET ?? "";

//
// Every request is bounded. An MCP tool call that never returns pins a request
// slot (and the agent waiting on it) forever, so nothing here is allowed to
// wait indefinitely:
// - `REQUEST` covers a normal JSON call.
// - `UPLOAD` is longer because a document upload reads, POSTs and indexes.
// - `STREAM` caps a whole SSE turn (chat turns are server-capped well below
//   this; the limit exists so a stalled socket cannot hang the tool).
// - `MAX_BYTES` stops one runaway stream from exhausting memory, which matters
//   on the 256 MB Machine `fly.toml` deploys.
const REQUEST_TIMEOUT_MS = Number(process.env.MCP_REQUEST_TIMEOUT_MS ?? 30_000);
const UPLOAD_TIMEOUT_MS = Number(process.env.MCP_UPLOAD_TIMEOUT_MS ?? 120_000);
const STREAM_TIMEOUT_MS = Number(process.env.MCP_STREAM_TIMEOUT_MS ?? 600_000);
const STREAM_MAX_BYTES = Number(
  process.env.MCP_STREAM_MAX_BYTES ?? 64 * 1024 * 1024,
);

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
  for (const [k, v] of Object.entries(query ?? {}))
    url.searchParams.append(k, v);
  return url;
}

/**
 * Turn a non-2xx response into a `BackendError`.
 *
 * FastAPI's `detail` is a string for `HTTPException` but an **array** for
 * `RequestValidationError` (e.g. a 422 from the workflow-run route), so
 * anything non-string is JSON-stringified rather than dropped — otherwise the
 * agent sees "Unprocessable Entity" and has nothing to correct.
 */
async function failure(res: Response, label: string): Promise<BackendError> {
  // `redirect: "manual"` (see `send`) means a 3xx arrives here instead of
  // being followed. Following one would replay `x-api-key` to whatever host
  // the Location header names — undici strips Authorization on a cross-origin
  // redirect but not custom headers, so refuse rather than risk it.
  if (res.status >= 300 && res.status < 400) {
    return new BackendError(
      502,
      `Backend ${label} returned a ${res.status} redirect to ${res.headers.get("location") ?? "an unknown location"}; refusing to replay the API key to it`,
    );
  }
  let detail: string = res.statusText;
  try {
    const data = (await res.json()) as { detail?: unknown };
    if (data?.detail !== undefined) {
      detail =
        typeof data.detail === "string"
          ? data.detail
          : JSON.stringify(data.detail);
    }
  } catch {
    // non-JSON error body — fall through with statusText
  }
  return new BackendError(
    res.status,
    `Backend ${label} failed (${res.status}): ${detail}`,
  );
}

/**
 * One place that sends a request, so every call site inherits the same
 * redirect refusal, timeout and transport-error wording.
 */
async function send(
  url: URL,
  init: RequestInit,
  label: string,
  timeoutMs: number,
): Promise<Response> {
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
      throw new BackendError(
        504,
        `Backend ${label} did not respond within ${timeoutMs}ms`,
      );
    }
    throw new BackendError(
      502,
      `Backend ${label} could not be reached: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) throw await failure(res, label);
  return res;
}

async function parse<T>(res: Response): Promise<T> {
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export async function backend<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const headers = authHeaders();
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await send(
    buildUrl(path, opts.query),
    { method, headers, body },
    `${method} ${path}`,
    REQUEST_TIMEOUT_MS,
  );
  return parse<T>(res);
}

/**
 * POST multipart/form-data. Two backend routes need this: the onboarding
 * interview start and the company-document upload. Both are declared as
 * `custom` actions in the domain tables.
 */
export async function backendForm<T>(path: string, form: FormData): Promise<T> {
  const res = await send(
    buildUrl(path),
    { method: "POST", headers: authHeaders(), body: form },
    `POST ${path}`,
    UPLOAD_TIMEOUT_MS,
  );
  return parse<T>(res);
}

/**
 * POST a JSON body and consume a `text/event-stream` response, calling
 * `onEvent` for every `data:` frame.
 *
 * Two backend routes stream this way: `POST /chat` (token chunks) and
 * `POST /workflows/{name}/runs` (progress + final artifact). MCP tool results
 * are plain text, so both are consumed to completion here and summarised into
 * one result rather than exposed as a stream.
 *
 * An `{"type":"error"}` frame is passed through the `onEvent` callback and
 * then rethrown as a `BackendError` — unless the callback returns
 * `"keep-partial"`, which is how `ask` and `run_workflow` return the work that
 * already succeeded instead of discarding it (a chat turn that times out has
 * still assembled usable text and a `session_id`, and the turn is persisted
 * server-side either way).
 */
export async function backendEvents(
  path: string,
  body: unknown,
  onEvent: (event: Record<string, unknown>) => "keep-partial" | void,
): Promise<void> {
  const headers = authHeaders();
  headers["content-type"] = "application/json";
  const res = await send(
    buildUrl(path),
    { method: "POST", headers, body: JSON.stringify(body) },
    `POST ${path}`,
    STREAM_TIMEOUT_MS,
  );
  if (!res.body)
    throw new BackendError(502, `Backend POST ${path}: empty stream`);

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
        throw new BackendError(
          502,
          `Backend POST ${path} sent more than ${STREAM_MAX_BYTES} bytes; aborted to bound memory`,
        );
      }

      buffer += decoder.decode(value, { stream: true });

      let separator: number;
      while ((separator = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, separator);
        buffer = buffer.slice(separator + 2);

        // Per the SSE spec, multiple `data:` lines join with a newline. The
        // backend only emits single-line JSON today, but joining with "" would
        // silently corrupt a payload that ever did wrap.
        const payload = frame
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("\n");
        if (!payload) continue; // keep-alive comment

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload) as Record<string, unknown>;
        } catch {
          // Frames are already delimited by the blank line above, so this is
          // genuinely malformed JSON rather than a partial frame. Drop it
          // rather than throwing: one bad frame should not lose the reply.
          continue;
        }

        const keepPartial = onEvent(event);
        if (event.type === "error" && keepPartial !== "keep-partial") {
          throw new BackendError(
            502,
            `Backend POST ${path} streamed an error: ${String(event.message ?? "unknown")}`,
          );
        }
      }
    }
  } catch (err) {
    if (err instanceof BackendError) throw err;
    // The deadline can fire during the body read, not only inside `send()`, so
    // translate it here too — otherwise a slow turn surfaces as a bare
    // DOMException instead of the wording every other timeout uses.
    const name = err instanceof Error ? err.name : "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new BackendError(
        504,
        `Backend POST ${path} did not finish within ${STREAM_TIMEOUT_MS}ms`,
      );
    }
    throw new BackendError(
      502,
      `Backend POST ${path} stream failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export function textResult(payload: unknown): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [
      {
        type: "text",
        // `JSON.stringify(undefined, null, 2)` returns `undefined`, not a
        // string, which serialises as a content block with **no** `text` field
        // — invalid against the MCP schema. Every 204-returning action
        // (archives, deletes, goal removal) resolves to `undefined`, so a
        // successful delete used to produce an unusable tool result.
        text:
          typeof payload === "string"
            ? payload
            : (JSON.stringify(payload, null, 2) ??
              "OK — the backend returned no content (204)."),
      },
    ],
  };
}

export function errorResult(err: unknown): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  const message = err instanceof Error ? err.message : String(err);
  // `isError` is what tells the client (and the model) that the call failed.
  // Without it the text is just an ordinary successful result that happens to
  // start with "Error:", which clients happily render as content.
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
  };
}

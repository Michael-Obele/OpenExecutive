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

export class BackendError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "BackendError";
    this.status = status;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Record<string, string>;
}

export async function backend<T>(
  path: string,
  opts: RequestOptions = {},
): Promise<T> {
  const url = new URL(`${BACKEND_BASE_URL}/${path.replace(/^\//, "")}`);
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query))
      url.searchParams.append(k, v);
  }
  const headers: Record<string, string> = {};
  if (BACKEND_SHARED_SECRET) headers["x-api-key"] = BACKEND_SHARED_SECRET;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers,
    body,
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const data = (await res.json()) as { detail?: string };
      if (data?.detail) detail = data.detail;
    } catch {
      // non-JSON error body — fall through with statusText
    }
    throw new BackendError(
      res.status,
      `Backend ${opts.method ?? "GET"} ${path} failed (${res.status}): ${detail}`,
    );
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

export function textResult(payload: unknown): {
  content: { type: "text"; text: string }[];
} {
  return {
    content: [
      {
        type: "text",
        text:
          typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

export function errorResult(err: unknown): {
  content: { type: "text"; text: string }[];
} {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text", text: `Error: ${message}` }] };
}

/**
 * HTTP server.
 *
 * Deliberately small: Bun.serve, a handful of routes, no framework. The
 * reference implementation needed FastAPI plus a separate TypeScript MCP server
 * plus a Next.js proxy layer to expose the same state; here one process owns
 * the database and serves every caller.
 *
 * Routes are namespaced by feature (`/features/<feature>/...`) so the surface
 * stays legible as features are ported, and so the dashboard's remote functions
 * have an obvious URL to call.
 */

import { loadSettings, type Settings } from "./config.ts";
import { openDb, type Db } from "./db.ts";
import { createProvider, type Provider } from "./providers.ts";
import {
  runMorningBrief,
  type MorningBriefResult,
} from "./features/briefings/morning-brief.ts";
import { convene } from "./features/council/council.ts";
import { indexCorpus, loadCorpus } from "./features/knowledge/knowledge.ts";

export interface AppContext {
  readonly settings: Settings;
  readonly db: Db;
  readonly provider: Provider;
}

// `Record<string, string>` rather than the DOM's `HeadersInit`: this project
// deliberately compiles against `lib: ESNext` + Bun's types with no DOM lib, and
// a plain record is all this helper ever needs.
function json(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

/**
 * CORS for split deployments.
 *
 * Empty `DURBAR_ALLOWED_ORIGINS` means same-origin only — the local/Docker case,
 * where the dashboard is served by this same process. Setting it is what lets a
 * dashboard hosted on Netlify or Vercel call a server hosted on Fly, without
 * forking the build.
 */
function corsHeaders(
  settings: Settings,
  origin: string | null,
): Record<string, string> {
  if (!origin) return {};
  if (settings.allowedOrigins.length === 0) return {};
  if (!settings.allowedOrigins.includes(origin)) return {};

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}

export function createApp(
  context: AppContext,
): (request: Request) => Promise<Response> {
  const { settings, db, provider } = context;

  return async function handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const cors = corsHeaders(settings, request.headers.get("origin"));

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      // ── health ────────────────────────────────────────────────────────────
      // Exempt from auth so a platform health checker can reach it, and it
      // reports which provider is live — the reference implementation's most
      // common confusion was not knowing which model was actually answering.
      if (url.pathname === "/health" && request.method === "GET") {
        return json(
          {
            status: "ok",
            provider: provider.name,
            model: provider.defaultModel,
          },
          200,
          cors,
        );
      }

      const briefPath = "/features/briefings/morning-brief";

      if (url.pathname === briefPath && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          periodLabel?: string;
          forceFull?: boolean;
        };

        const result = await runMorningBrief(
          {
            ...(body.periodLabel !== undefined
              ? { periodLabel: body.periodLabel }
              : {}),
            ...(body.forceFull !== undefined
              ? { forceFull: body.forceFull }
              : {}),
          },
          { db, provider },
        );

        return json(result satisfies MorningBriefResult, 200, cors);
      }

      if (url.pathname === briefPath && request.method === "GET") {
        const latest = db
          .query<{ artifact: string | null; created_at: string }, []>(
            `SELECT artifact, created_at FROM workflow_runs
              WHERE workflow_name = 'morning_brief'
              ORDER BY created_at DESC LIMIT 1`,
          )
          .get();

        if (!latest)
          return json({ error: "no brief has been run yet" }, 404, cors);
        return json(latest, 200, cors);
      }

      const councilPath = "/features/council/consult";

      if (url.pathname === councilPath && request.method === "POST") {
        const body = (await request.json().catch(() => ({}))) as {
          question?: string;
          context?: string;
        };

        if (typeof body.question !== "string" || body.question.trim() === "") {
          return json({ error: "question is required" }, 400, cors);
        }

        const result = await convene(body.question, {
          provider,
          db,
          ...(body.context !== undefined ? { context: body.context } : {}),
        });

        return json(result, 200, cors);
      }

      return json({ error: "not found", path: url.pathname }, 404, cors);
    } catch (error) {
      // Surface the message: a bare 500 on a model call is undiagnosable, and
      // the useful part (auth, quota, unknown model) is in the text.
      const message = error instanceof Error ? error.message : String(error);
      console.error(`${request.method} ${url.pathname} failed: ${message}`);
      return json({ error: message }, 500, cors);
    }
  };
}

if (import.meta.main) {
  const settings = loadSettings();
  const db = openDb(settings.dbPath);
  const provider = createProvider(settings.provider);

  // Rebuild the search index on every boot. It is a DELETE plus a few thousand
  // inserts against a local file — milliseconds — and it means the index can
  // never drift from the corpus on disk. A stale index is a silent retrieval
  // failure, which is far more expensive to notice than a boot cost.
  const documents = loadCorpus();
  const sections = indexCorpus(db, documents);

  const server = Bun.serve({
    port: settings.port,
    fetch: createApp({ settings, db, provider }),
  });

  console.log(
    `durbar listening on ${server.url} — provider=${provider.name} model=${provider.defaultModel}`,
  );
  console.log(`database: ${settings.dbPath}`);
  console.log(
    `knowledge: ${documents.length} documents, ${sections} sections indexed`,
  );
}

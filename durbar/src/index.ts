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
import {
  getCompanyProfile,
  patchCompanyProfile,
  validatePatch,
} from "./features/company/company.ts";
import {
  createDepartment,
  deleteDepartment,
  deleteGoal,
  getDepartment,
  getGoal,
  insertGoal,
  listDepartments,
  listGoals,
  okrsDeprecationHeaders,
  updateDepartment,
  updateGoal,
  validateDepartmentCreate,
  validateDepartmentPatch,
  validateGoalCreate,
  validateGoalPatch,
} from "./features/departments/departments.ts";
import {
  DEFAULT_MORNING_TIME,
  pendingActions,
  PRINCIPAL_BRIEF_MORNING,
  runDue,
  seedDaily,
  startScheduler,
} from "./features/scheduler/scheduler.ts";

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

      // ── company-profile ───────────────────────────────────────────────
      if (url.pathname === "/company-profile" && request.method === "GET") {
        const profile = getCompanyProfile(db);
        if (!profile)
          return json(
            { error: "No company profile found. Complete onboarding first." },
            404,
            cors,
          );
        return json(profile, 200, cors);
      }

      if (url.pathname === "/company-profile" && request.method === "PATCH") {
        const body: unknown = await request.json().catch(() => null);
        const validated = validatePatch(body);
        if (validated.error) return json({ error: validated.error }, 422, cors);
        if (!validated.data) return json({ error: "invalid patch" }, 422, cors);
        const merged = patchCompanyProfile(db, validated.data);
        return json(merged, 200, cors);
      }

      // ── departments ───────────────────────────────────────────────────
      if (url.pathname === "/departments" && request.method === "GET") {
        return json(listDepartments(db), 200, cors);
      }

      if (url.pathname === "/departments" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const validated = validateDepartmentCreate(body);
        if (!validated.ok) return json({ error: validated.error }, 422, cors);
        try {
          const created = createDepartment(
            db,
            validated.title,
            validated.mission,
          );
          return json(created, 201, cors);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          return json({ error: message }, 422, cors);
        }
      }

      // DELETE /departments/{slug}
      {
        const match = url.pathname.match(/^\/departments\/([^/]+)$/);
        if (match) {
          const slug = decodeURIComponent(match[1]!);
          if (request.method === "GET") {
            const state = getDepartment(db, slug);
            if (!state) return json({ error: "Unknown department" }, 404, cors);
            return json(state, 200, cors);
          }
          if (request.method === "DELETE") {
            const existing = getDepartment(db, slug);
            if (!existing)
              return json({ error: "Unknown department" }, 404, cors);
            deleteDepartment(db, slug);
            return new Response(null, { status: 204, headers: cors });
          }
          if (request.method === "PATCH") {
            const existing = getDepartment(db, slug);
            if (!existing)
              return json({ error: "Unknown department" }, 404, cors);
            const raw: unknown = await request.json().catch(() => null);
            const validated = validateDepartmentPatch(raw);
            if (!validated.ok)
              return json({ error: validated.error }, 422, cors);
            if (Object.keys(validated.patch).length === 0) {
              return json(existing, 200, cors);
            }
            try {
              updateDepartment(db, slug, validated.patch);
            } catch (error) {
              const message =
                error instanceof Error ? error.message : String(error);
              return json({ error: message }, 422, cors);
            }
            const updated = getDepartment(db, slug);
            if (!updated)
              return json({ error: "Department vanished" }, 500, cors);
            return json(updated, 200, cors);
          }
        }
      }

      // Goals: /departments/{slug}/goals and /departments/{slug}/goals/{id}
      // plus deprecated /okrs aliases.
      // Legacy `quarter` → period_value mapping: when both `quarter` and
      // `period_value` are present, `period_value` wins (explicit beats alias).
      // See validateGoalCreate / validateGoalPatch for the mapping logic.
      {
        const goalsMatch = url.pathname.match(
          /^\/departments\/([^/]+)\/(goals|okrs)$/,
        );
        if (goalsMatch) {
          const slug = decodeURIComponent(goalsMatch[1]!);
          const kind = goalsMatch[2]!;
          const isLegacy = kind === "okrs";
          if (request.method === "GET") {
            const existing = getDepartment(db, slug);
            if (!existing)
              return json({ error: "Unknown department" }, 404, cors);
            const goals = listGoals(db, slug);
            const headers: Record<string, string> = { ...cors };
            if (isLegacy) {
              Object.assign(headers, okrsDeprecationHeaders(slug));
            }
            return json(goals, 200, headers);
          }
          if (request.method === "POST") {
            const existing = getDepartment(db, slug);
            if (!existing)
              return json({ error: "Unknown department" }, 404, cors);
            const body: unknown = await request.json().catch(() => null);
            const validated = validateGoalCreate(body);
            if (!validated.ok)
              return json({ error: validated.error }, 422, cors);
            const id = insertGoal(db, slug, validated.data);
            const goal = getGoal(db, id);
            if (!goal)
              return json({ error: "Goal vanished after insert" }, 500, cors);
            const headers: Record<string, string> = { ...cors };
            if (isLegacy) {
              Object.assign(headers, okrsDeprecationHeaders(slug));
            }
            return json(goal, 201, headers);
          }
        }
      }

      {
        const goalMatch = url.pathname.match(
          /^\/departments\/([^/]+)\/(goals|okrs)\/([^/]+)$/,
        );
        if (goalMatch) {
          const slug = decodeURIComponent(goalMatch[1]!);
          const kind = goalMatch[2]!;
          const rawId = goalMatch[3]!;
          const isLegacy = kind === "okrs";
          const goalId = Number(rawId);
          if (!Number.isInteger(goalId))
            return json({ error: "goal id must be an integer" }, 422, cors);

          if (request.method === "PATCH") {
            const existing = getGoal(db, goalId);
            if (!existing || existing.department_slug !== slug)
              return json({ error: "Unknown Goal for department" }, 404, cors);
            const body: unknown = await request.json().catch(() => null);
            const validated = validateGoalPatch(body);
            if (!validated.ok)
              return json({ error: validated.error }, 422, cors);
            updateGoal(db, goalId, validated.data);
            const updated = getGoal(db, goalId);
            if (!updated)
              return json({ error: "Goal vanished mid-update" }, 404, cors);
            const headers: Record<string, string> = { ...cors };
            if (isLegacy) {
              Object.assign(headers, okrsDeprecationHeaders(slug, goalId));
            }
            return json(updated, 200, headers);
          }

          if (request.method === "DELETE") {
            const existing = getGoal(db, goalId);
            if (!existing || existing.department_slug !== slug)
              return json({ error: "Unknown Goal for department" }, 404, cors);
            deleteGoal(db, goalId);
            const headers: Record<string, string> = { ...cors };
            if (isLegacy) {
              Object.assign(headers, okrsDeprecationHeaders(slug, goalId));
            }
            return new Response(null, { status: 204, headers });
          }
        }
      }

      const schedulerActionsPath = "/features/scheduler/actions";
      const schedulerTickPath = "/features/scheduler/tick";

      if (url.pathname === schedulerActionsPath && request.method === "GET") {
        return json(pendingActions(db), 200, cors);
      }

      // Manual trigger. Useful for a first run without waiting for 08:00, and
      // for verifying delivery on a fresh install.
      if (url.pathname === schedulerTickPath && request.method === "POST") {
        const ran = await runDue({
          db,
          provider,
          morningTime: settings.morningBriefTime,
        });
        return json({ ran }, 200, cors);
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

  // Seed default departments once per DB (idempotent) and the daily brief
  // (deduped, so a restart cannot stack a second one).
  const { seedDefaultDepartments: seedDepts } =
    await import("./features/departments/departments.ts");
  seedDepts(db);
  const briefTime = settings.morningBriefTime || DEFAULT_MORNING_TIME;
  seedDaily(db, PRINCIPAL_BRIEF_MORNING, briefTime);
  const scheduler = startScheduler({ db, provider, morningTime: briefTime });

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
  console.log(
    `scheduler: brief at ${briefTime} UTC, ${pendingActions(db).length} action(s) pending`,
  );

  const shutdown = (): void => {
    scheduler.stop();
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

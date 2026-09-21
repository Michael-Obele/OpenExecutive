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
  AUTHORITY_SCOPES,
  archivePerson,
  createPerson,
  findApprovers,
  getPerson,
  listPeople,
  PrincipalProtectionError,
  updatePerson,
  validatePersonCreate,
  validatePersonPatch,
} from "./features/people/people.ts";
import {
  bulkSetStatus,
  getAlert,
  listLiveAlerts,
  reopenAlert,
  setStatus,
  validateAckBody,
  validateBulkAckBody,
} from "./features/alerts/alerts.ts";
import {
  deleteAdvice,
  deleteDecision,
  deleteInitiative,
  getAdvice,
  getDecision,
  getInitiative,
  listAdvice,
  listDecisions,
  listInitiatives,
  updateAdvice,
  updateDecision,
  updateInitiative,
} from "./features/memories/memories.ts";
import {
  deleteArtifact,
  getArtifact,
  listArtifacts,
  setArtifactArchived,
} from "./features/artifacts/artifacts.ts";
import {
  deleteSession,
  getSessionMetadata,
  listSessions,
  loadMessages,
} from "./features/sessions/sessions.ts";
import {
  DEFAULT_MORNING_TIME,
  pendingActions,
  PRINCIPAL_BRIEF_MORNING,
  runDue,
  seedDaily,
  startScheduler,
} from "./features/scheduler/scheduler.ts";
import {
  buildActivity,
  buildDailyActivity,
  buildToday,
  resolveCallerPersonId,
} from "./features/briefing/briefing.ts";
import { buildSuggestedPrompts, runChatTurn } from "./features/chat/chat.ts";
import {
  deleteDocument,
  getDocument,
  listDocuments,
  upsertDocument,
  validateDomain,
  validateFilename,
} from "./features/documents/documents.ts";
import {
  DOMAIN_ALIASES,
  searchKnowledge,
  UPLOAD_DOMAINS,
  withGeneral,
} from "./features/knowledge/knowledge.ts";

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

      // ── people ────────────────────────────────────────────────────────
      // by-scope must be matched before the generic /people/{id} block.
      if (url.pathname.startsWith("/people/by-scope/") && request.method === "GET") {
        const token = decodeURIComponent(url.pathname.slice("/people/by-scope/".length));
        if (!(AUTHORITY_SCOPES as readonly string[]).includes(token)) {
          return json(
            {
              error: `Unknown scope token: ${JSON.stringify(token)}. Valid tokens: ${AUTHORITY_SCOPES.join(", ")}`,
            },
            400,
            cors,
          );
        }
        const approvers = findApprovers(db, token as (typeof AUTHORITY_SCOPES)[number]);
        return json(approvers, 200, cors);
      }

      if (url.pathname === "/people" && request.method === "GET") {
        const includeArchived = url.searchParams.get("include_archived") === "true";
        return json(listPeople(db, includeArchived), 200, cors);
      }

      if (url.pathname === "/people" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const validated = validatePersonCreate(body);
        if (!validated.ok) return json({ error: validated.error }, 422, cors);
        if (
          validated.data.reports_to_person_id !== undefined &&
          validated.data.reports_to_person_id !== null
        ) {
          const target = getPerson(db, validated.data.reports_to_person_id);
          if (!target || target.archived) {
            return json({ error: "reports_to_person_id must reference an existing, non-archived person" }, 422, cors);
          }
        }
        const created = createPerson(db, validated.data);
        return json(created, 201, cors);
      }

      // POST /people/{id}/archive — must be before generic /people/{id} PATCH/GET.
      // Idempotent: archiving an already-archived person returns 204 (same as
      // upstream `archive_person` + route, which is 204 regardless).
      {
        const archiveMatch = url.pathname.match(/^\/people\/(\d+)\/archive$/);
        if (archiveMatch && request.method === "POST") {
          const id = Number(archiveMatch[1]);
          const existing = getPerson(db, id);
          if (!existing) return json({ error: "Person not found" }, 404, cors);
          if (existing.archived) return new Response(null, { status: 204, headers: cors });
          try {
            archivePerson(db, id);
          } catch (error) {
            if (error instanceof PrincipalProtectionError) {
              return json({ error: error.message }, 409, cors);
            }
            const message = error instanceof Error ? error.message : String(error);
            return json({ error: message }, 422, cors);
          }
          return new Response(null, { status: 204, headers: cors });
        }
      }

      {
        const personMatch = url.pathname.match(/^\/people\/(\d+)$/);
        if (personMatch) {
          const id = Number(personMatch[1]);
          if (request.method === "GET") {
            const person = getPerson(db, id);
            if (!person) return json({ error: "Person not found" }, 404, cors);
            return json(person, 200, cors);
          }
          if (request.method === "PATCH") {
            const existing = getPerson(db, id);
            if (!existing) return json({ error: "Person not found" }, 404, cors);
            const raw: unknown = await request.json().catch(() => null);
            const validated = validatePersonPatch(raw);
            if (!validated.ok) return json({ error: validated.error }, 422, cors);
            // FK validation for reports_to_person_id: target must exist and not be archived.
            if (
              validated.data.reports_to_person_id !== undefined &&
              validated.data.reports_to_person_id !== null
            ) {
              const target = getPerson(db, validated.data.reports_to_person_id);
              if (!target || target.archived) {
                return json({ error: "reports_to_person_id must reference an existing, non-archived person" }, 422, cors);
              }
            }
            if (Object.keys(validated.data).length === 0) {
              return json(existing, 200, cors);
            }
            try {
              const updated = updatePerson(db, id, validated.data);
              if (!updated) return json({ error: "Person vanished" }, 500, cors);
              return json(updated, 200, cors);
            } catch (error) {
              if (error instanceof PrincipalProtectionError) {
                return json({ error: error.message }, 409, cors);
              }
              throw error;
            }
          }
        }
      }

      // ── alerts ────────────────────────────────────────────────────────
      // GET /alerts/review — live queue (unread, inside TTL, not snoozed).
      // POST /alerts/review — run the Executive's relevance review on demand.
      // Upstream is POST only; Durbar supports both: GET lists live alerts,
      // POST runs the review (currently a no-op that returns zero counts — the
      // model-backed review is deferred).
      if (url.pathname === "/alerts/review" && request.method === "GET") {
        const live = listLiveAlerts(db);
        return json(live, 200, cors);
      }
      if (url.pathname === "/alerts/review" && request.method === "POST") {
        // Model-backed review deferred — return zero counts so the contract
        // is stable and the dashboard's "Re-check now" button works.
        return json(
          {
            reviewed: 0,
            closed: 0,
            changed: 0,
            routed: 0,
            nudged: 0,
            escalated: 0,
            drafted: 0,
            merged: 0,
            suggested: 0,
            annotated: 0,
          },
          200,
          cors,
        );
      }

      if (url.pathname === "/alerts/bulk-ack" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const validated = validateBulkAckBody(body);
        if (!validated.ok) {
          const code = validated.error.includes("required") ? 400 : 422;
          return json({ error: validated.error }, code, cors);
        }
        const { status, alert_ids, older_than_days, category } = validated.data;
        let before: string | null = null;
        if (older_than_days !== undefined) {
          before = new Date(Date.now() - older_than_days * 24 * 60 * 60 * 1000).toISOString();
        }
        const updated = bulkSetStatus(db, status, {
          ...(alert_ids !== undefined ? { alert_ids } : {}),
          ...(before ? { before } : {}),
          ...(category ? { category } : {}),
          excludeSources: ["artifact", "decision_scheduling"],
        });
        return json({ count: updated.length }, 200, cors);
      }

      {
        const ackMatch = url.pathname.match(/^\/alerts\/(\d+)\/ack$/);
        if (ackMatch && request.method === "POST") {
          const id = Number(ackMatch[1]);
          const existing = getAlert(db, id);
          if (!existing) return json({ error: "Alert not found" }, 404, cors);
          const body: unknown = await request.json().catch(() => null);
          const validated = validateAckBody(body);
          if (!validated.ok) return json({ error: validated.error }, 422, cors);
          setStatus(db, id, validated.status);
          // Mute handling deferred — requires topic pattern validation.
          const updated = getAlert(db, id);
          if (!updated) return json({ error: "Alert not found" }, 404, cors);
          return json(updated, 200, cors);
        }
      }

      {
        const reopenMatch = url.pathname.match(/^\/alerts\/(\d+)\/reopen$/);
        if (reopenMatch && request.method === "POST") {
          const id = Number(reopenMatch[1]);
          const existing = getAlert(db, id);
          if (!existing) return json({ error: "Alert not found" }, 404, cors);
          const ok = reopenAlert(db, id, ["artifact", "decision_scheduling"]);
          if (!ok) {
            return json({ error: "Only resolved, expired or dismissed alerts can be reopened" }, 409, cors);
          }
          const updated = getAlert(db, id);
          if (!updated) return json({ error: "Alert not found" }, 404, cors);
          return json(updated, 200, cors);
        }
      }

      // ── memories ──────────────────────────────────────────────────────
      if (url.pathname === "/memories/decisions" && request.method === "GET") {
        return json(listDecisions(db), 200, cors);
      }
      if (url.pathname === "/memories/initiatives" && request.method === "GET") {
        return json(listInitiatives(db), 200, cors);
      }
      if (url.pathname === "/memories/advice" && request.method === "GET") {
        return json(listAdvice(db), 200, cors);
      }

      {
        const decMatch = url.pathname.match(/^\/memories\/decisions\/(\d+)$/);
        if (decMatch) {
          const id = Number(decMatch[1]);
          if (request.method === "PATCH") {
            const body: unknown = await request.json().catch(() => null);
            const patch = (body ?? {}) as Record<string, unknown>;
            const allowed: Record<string, string> = {};
            for (const key of ["domain", "summary", "rationale", "outcome", "tags"]) {
              if (key in patch && patch[key] !== undefined) {
                if (typeof patch[key] !== "string") return json({ error: `${key} must be a string` }, 422, cors);
                allowed[key] = patch[key] as string;
              }
            }
            if (!updateDecision(db, id, allowed)) return json({ error: "Decision not found" }, 404, cors);
            const updated = getDecision(db, id);
            if (!updated) return json({ error: "Decision not found" }, 404, cors);
            return json(updated, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!deleteDecision(db, id)) return json({ error: "Decision not found" }, 404, cors);
            return new Response(null, { status: 204, headers: cors });
          }
        }
      }

      {
        const initMatch = url.pathname.match(/^\/memories\/initiatives\/(\d+)$/);
        if (initMatch) {
          const id = Number(initMatch[1]);
          if (request.method === "PATCH") {
            const body: unknown = await request.json().catch(() => null);
            const patch = (body ?? {}) as Record<string, unknown>;
            const allowed: Record<string, string> = {};
            for (const key of ["title", "status", "summary"]) {
              if (key in patch && patch[key] !== undefined) {
                if (typeof patch[key] !== "string") return json({ error: `${key} must be a string` }, 422, cors);
                allowed[key] = patch[key] as string;
              }
            }
            if (!updateInitiative(db, id, allowed)) return json({ error: "Initiative not found" }, 404, cors);
            const updated = getInitiative(db, id);
            if (!updated) return json({ error: "Initiative not found" }, 404, cors);
            return json(updated, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!deleteInitiative(db, id)) return json({ error: "Initiative not found" }, 404, cors);
            return new Response(null, { status: 204, headers: cors });
          }
        }
      }

      {
        const advMatch = url.pathname.match(/^\/memories\/advice\/(\d+)$/);
        if (advMatch) {
          const id = Number(advMatch[1]);
          if (request.method === "PATCH") {
            const body: unknown = await request.json().catch(() => null);
            const patch = (body ?? {}) as Record<string, unknown>;
            const allowed: Record<string, string> = {};
            for (const key of ["domain", "query_summary", "advice_summary"]) {
              if (key in patch && patch[key] !== undefined) {
                if (typeof patch[key] !== "string") return json({ error: `${key} must be a string` }, 422, cors);
                allowed[key] = patch[key] as string;
              }
            }
            if (!updateAdvice(db, id, allowed)) return json({ error: "Advice not found" }, 404, cors);
            const updated = getAdvice(db, id);
            if (!updated) return json({ error: "Advice not found" }, 404, cors);
            return json(updated, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!deleteAdvice(db, id)) return json({ error: "Advice not found" }, 404, cors);
            return new Response(null, { status: 204, headers: cors });
          }
        }
      }

      // ── artifacts ─────────────────────────────────────────────────────
      // Specific sub-paths before the generic /artifacts/{id} match.
      if (url.pathname === "/artifacts" && request.method === "GET") {
        const archived = url.searchParams.get("archived") === "true";
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 200;
        const artifacts = listArtifacts(db, Number.isFinite(limit) ? limit : 200, archived);
        return json({ artifacts }, 200, cors);
      }

      {
        const archiveMatch = url.pathname.match(/^\/artifacts\/(.+)\/archive$/);
        if (archiveMatch && request.method === "POST") {
          const compositeId = decodeURIComponent(archiveMatch[1]!);
          // Validate shape first: malformed id is 400, not 404.
          const parsed = compositeId.includes(":") && (compositeId.startsWith("alert:") || compositeId.startsWith("run:"));
          if (!parsed) return json({ error: `Malformed artifact id: ${JSON.stringify(compositeId)}` }, 400, cors);
          const ok = setArtifactArchived(db, compositeId, true);
          if (!ok) return json({ error: `Artifact ${JSON.stringify(compositeId)} not found` }, 404, cors);
          return json({ status: "archived", id: compositeId }, 200, cors);
        }
      }

      {
        const restoreMatch = url.pathname.match(/^\/artifacts\/(.+)\/restore$/);
        if (restoreMatch && request.method === "POST") {
          const compositeId = decodeURIComponent(restoreMatch[1]!);
          const parsed = compositeId.includes(":") && (compositeId.startsWith("alert:") || compositeId.startsWith("run:"));
          if (!parsed) return json({ error: `Malformed artifact id: ${JSON.stringify(compositeId)}` }, 400, cors);
          const ok = setArtifactArchived(db, compositeId, false);
          if (!ok) return json({ error: `Artifact ${JSON.stringify(compositeId)} not found` }, 404, cors);
          return json({ status: "restored", id: compositeId }, 200, cors);
        }
      }

      {
        const artifactMatch = url.pathname.match(/^\/artifacts\/(.+)$/);
        if (artifactMatch) {
          const compositeId = decodeURIComponent(artifactMatch[1]!);
          if (request.method === "GET") {
            const parsed = compositeId.includes(":") && (compositeId.startsWith("alert:") || compositeId.startsWith("run:"));
            if (!parsed) return json({ error: `Malformed artifact id: ${JSON.stringify(compositeId)}` }, 400, cors);
            const artifact = getArtifact(db, compositeId);
            if (!artifact) return json({ error: `Artifact ${JSON.stringify(compositeId)} not found` }, 404, cors);
            return json(artifact, 200, cors);
          }
          if (request.method === "DELETE") {
            const parsed = compositeId.includes(":") && (compositeId.startsWith("alert:") || compositeId.startsWith("run:"));
            if (!parsed) return json({ error: `Malformed artifact id: ${JSON.stringify(compositeId)}` }, 400, cors);
            const ok = deleteArtifact(db, compositeId);
            if (!ok) return json({ error: `Artifact ${JSON.stringify(compositeId)} not found` }, 404, cors);
            return json({ status: "deleted", id: compositeId }, 200, cors);
          }
        }
      }

      // ── sessions ──────────────────────────────────────────────────────
      // NOTE: Durbar returns all sessions newest-first. Upstream scopes by
      // caller_person_id (auth); multiuser scoping is deferred — see the
      // sessions module doc comment.
      if (url.pathname === "/sessions" && request.method === "GET") {
        return json(listSessions(db), 200, cors);
      }

      {
        const msgMatch = url.pathname.match(/^\/sessions\/([^/]+)\/messages$/);
        if (msgMatch && request.method === "GET") {
          const sessionId = decodeURIComponent(msgMatch[1]!);
          const meta = getSessionMetadata(db, sessionId);
          if (!meta) return json({ error: "Session not found" }, 404, cors);
          return json(loadMessages(db, sessionId), 200, cors);
        }
      }

      {
        const sessMatch = url.pathname.match(/^\/sessions\/([^/]+)$/);
        if (sessMatch) {
          const sessionId = decodeURIComponent(sessMatch[1]!);
          if (request.method === "GET") {
            const meta = getSessionMetadata(db, sessionId);
            if (!meta) return json({ error: "Session not found" }, 404, cors);
            return json(meta, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!deleteSession(db, sessionId)) return json({ error: "Session not found" }, 404, cors);
            return new Response(null, { status: 204, headers: cors });
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

      // ── briefing — today ────────────────────────────────────────────
      if (url.pathname === "/today" && request.method === "GET") {
        const callerEmail = request.headers.get("x-caller-email") ?? null;
        const callerId = resolveCallerPersonId(db, callerEmail);
        const today = buildToday(db, callerId);
        return json(today, 200, cors);
      }

      if (url.pathname === "/today/activity" && request.method === "GET") {
        const raw = url.searchParams.get("limit");
        const limit = raw ? Number(raw) : 20;
        if (!Number.isFinite(limit) || limit < 1 || limit > 100) {
          return json({ error: "limit must be in [1, 100]" }, 400, cors);
        }
        return json(buildActivity(db, limit), 200, cors);
      }

      if (url.pathname === "/today/activity/daily" && request.method === "GET") {
        const raw = url.searchParams.get("days");
        const days = raw ? Number(raw) : 90;
        if (!Number.isFinite(days) || days < 1 || days > 365) {
          return json({ error: "days must be in [1, 365]" }, 400, cors);
        }
        return json(buildDailyActivity(db, days), 200, cors);
      }

      if (url.pathname === "/morning-brief" && request.method === "GET") {
        const callerEmail = request.headers.get("x-caller-email") ?? null;
        const callerId = resolveCallerPersonId(db, callerEmail);
        const today = buildToday(db, callerId);
        return json(today, 200, {
          ...cors,
          deprecation: "true",
          sunset: "Sat, 22 Aug 2026 00:00:00 GMT",
          link: '</today>; rel="successor-version"',
        });
      }

      // ── chat ────────────────────────────────────────────────────────
      if (url.pathname === "/chat" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const msg = (body as Record<string, unknown> | null)?.["message"];
        if (typeof msg !== "string" || msg.trim() === "") {
          return json({ error: "message is required" }, 400, cors);
        }
        const sessionId = (body as Record<string, unknown>)?.["session_id"];
        const sid = typeof sessionId === "string" ? sessionId : null;
        const { sessionId: resolvedId, stream } = await runChatTurn(
          { message: msg, sessionId: sid },
          { db, provider },
        );
        // Stream SSE without buffering.
        const headers: Record<string, string> = {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
          ...cors,
        };
        // Expose session id via header for clients that need it before stream ends.
        headers["x-session-id"] = resolvedId;
        const sseStream = stream.pipeThrough(
          new TextEncoderStream() as unknown as TransformStream<string, Uint8Array>,
        );
        return new Response(sseStream as unknown as ReadableStream, { status: 200, headers });
      }

      if (url.pathname === "/chat/upload" && request.method === "POST") {
        const formData = await request.formData().catch(() => null);
        if (!formData) return json({ error: "Invalid multipart body" }, 400, cors);
        const message = formData.get("message");
        if (typeof message !== "string" || message.trim() === "") {
          return json({ error: "message is required" }, 400, cors);
        }
        const sessionIdRaw = formData.get("session_id");
        const sid = typeof sessionIdRaw === "string" ? sessionIdRaw : null;
        const files = formData.getAll("files") as unknown as File[];
        // Also accept single "file" field.
        const singleFile = formData.get("file") as unknown as File | null;
        const allFiles: File[] = [];
        for (const f of files) if (f instanceof File) allFiles.push(f);
        if (singleFile instanceof File) allFiles.push(singleFile);
        // If no files field but formData has file entries via File objects, collect all File values.
        if (allFiles.length === 0) {
          for (const [, value] of formData.entries()) {
            if (value instanceof File) allFiles.push(value);
          }
        }
        if (allFiles.length === 0) return json({ error: "No files uploaded" }, 400, cors);
        if (allFiles.length > 5) return json({ error: "Too many files: limit 5 per turn" }, 400, cors);
        for (const f of allFiles) {
          if (f.size > 20 * 1024 * 1024) {
            return json({ error: `${f.name}: file too large — ${Math.floor(f.size / (1024 * 1024))} MB (limit 20 MB)` }, 413, cors);
          }
        }
        // Extract text from text-like files and inline.
        const textParts: string[] = [];
        for (const f of allFiles) {
          const ext = f.name.slice(f.name.lastIndexOf(".")).toLowerCase();
          if ([".md", ".txt", ".csv"].includes(ext)) {
            const text = await f.text().catch(() => "");
            if (text) textParts.push(`File: ${f.name}\n${text.slice(0, 8000)}`);
          } else {
            textParts.push(`File: ${f.name} (${f.size} bytes, type ${f.type || "unknown"})`);
          }
        }
        const attachmentText = textParts.length > 0 ? textParts.join("\n\n") : null;
        const { sessionId: resolvedId, stream } = await runChatTurn(
          { message, sessionId: sid, ...(attachmentText ? { attachmentText } : {}) },
          { db, provider },
        );
        const headers: Record<string, string> = {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
          "x-accel-buffering": "no",
          ...cors,
        };
        headers["x-session-id"] = resolvedId;
        const sseStream = stream.pipeThrough(
          new TextEncoderStream() as unknown as TransformStream<string, Uint8Array>,
        );
        return new Response(sseStream as unknown as ReadableStream, { status: 200, headers });
      }

      if (url.pathname === "/chat/suggested-prompts" && request.method === "GET") {
        const result = buildSuggestedPrompts(db, provider);
        return json(result, 200, cors);
      }

      // ── knowledge ───────────────────────────────────────────────────
      if (url.pathname === "/knowledge/builtin" && request.method === "GET") {
        // List builtin files from the corpus on disk.
        const { readdirSync, statSync } = await import("node:fs");
        const { join } = await import("node:path");
        const root = join(import.meta.dir, "..", "knowledge", "builtin");
        const files: Array<{ domain: string; filename: string; size_bytes: number }> = [];
        const walk = (dir: string, domain: string): void => {
          try {
            for (const entry of readdirSync(dir)) {
              const full = join(dir, entry);
              const st = statSync(full);
              if (st.isDirectory()) {
                // Top-level dirs are domains; nested failures/skills handled via domain param.
                walk(full, entry);
              } else if (entry.endsWith(".md")) {
                files.push({ domain, filename: entry, size_bytes: st.size });
              }
            }
          } catch {
            // ignore missing dir
          }
        };
        // Only top-level domain dirs.
        try {
          for (const entry of readdirSync(root)) {
            const full = join(root, entry);
            try {
              if (statSync(full).isDirectory() && !entry.startsWith(".")) {
                walk(full, entry);
              }
            } catch {
              // ignore
            }
          }
        } catch {
          // no corpus
        }
        return json({ files }, 200, cors);
      }

      if (url.pathname === "/knowledge/search" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const query = b["query"];
        if (typeof query !== "string" || query.trim() === "") {
          return json({ error: "query must be non-empty" }, 400, cors);
        }
        const domainFilter = b["domain_filter"] as string[] | undefined;
        const specialist = b["specialist"] as string | undefined;
        const include = b["include"] as string[] | undefined;
        const nBuiltin = typeof b["n_builtin"] === "number" ? b["n_builtin"] : 5;
        const nCompany = typeof b["n_company"] === "number" ? b["n_company"] : 3;
        const nFailures = typeof b["n_failures"] === "number" ? b["n_failures"] : 3;
        void (typeof b["n_external"] === "number" ? b["n_external"] : 5);

        const validSources = new Set(["builtin", "company", "failures", "external"]);
        if (include) {
          for (const inc of include) {
            if (!validSources.has(inc)) {
              return json({ error: `Invalid include values: ${inc}` }, 400, cors);
            }
          }
        }
        if (domainFilter) {
          for (const d of domainFilter) {
            if (!UPLOAD_DOMAINS.has(d)) {
              return json({ error: `Unknown domain: ${d}` }, 400, cors);
            }
          }
        }
        if (specialist && !(specialist in DOMAIN_ALIASES)) {
          return json({ error: `Unknown specialist: ${specialist}` }, 400, cors);
        }

        let effectiveDomains: readonly string[] | null | undefined = domainFilter ?? null;
        if (!effectiveDomains && specialist) {
          effectiveDomains = DOMAIN_ALIASES[specialist] ?? null;
        }

        const specialistsSeeing = effectiveDomains
          ? Object.entries(DOMAIN_ALIASES)
              .filter(([, doms]) => doms.some((d) => (effectiveDomains as readonly string[]).includes(d)))
              .map(([name]) => name)
              .sort()
          : Object.keys(DOMAIN_ALIASES).sort();

        const wantBuiltin = !include || include.includes("builtin");
        const wantCompany = !include || include.includes("company");
        const wantFailures = !include || include.includes("failures");
        const wantExternal = !include || include.includes("external");

        const toHit = (hits: ReturnType<typeof searchKnowledge>): Array<Record<string, unknown>> =>
          hits.map((h) => ({
            filename: h.path.split("/").pop() ?? h.path,
            domain: h.domain,
            source: h.path,
            chunk_index: 0,
            distance: h.score,
            text: h.body.slice(0, 800),
          }));

        let builtin: ReturnType<typeof toHit> = [];
        let company: ReturnType<typeof toHit> = [];
        let failures: ReturnType<typeof toHit> = [];
        let external: ReturnType<typeof toHit> = [];

        if (wantBuiltin) {
          const hits = searchKnowledge(db, query as string, {
            ...(effectiveDomains ? { domain: effectiveDomains[0] } : {}),
            limit: Math.max(1, Math.min(nBuiltin, 25)),
          });
          builtin = toHit(hits);
        }
        if (wantCompany) {
          const companyDomains = withGeneral(effectiveDomains as string[] | null) as string[] | null;
          const hits = searchKnowledge(db, query as string, {
            ...(companyDomains ? { domain: companyDomains[0] } : {}),
            limit: Math.max(1, Math.min(nCompany, 25)),
          });
          company = toHit(hits);
        }
        if (wantFailures) {
          const hits = searchKnowledge(db, query as string, {
            kind: "failure",
            limit: Math.max(1, Math.min(nFailures, 25)),
          });
          failures = toHit(hits);
        }
        if (wantExternal) {
          // External sources not yet indexed in Durbar — return empty.
          external = [];
          // If external was requested but builtin wasn't, still need to handle partitioning.
          // For now external is always empty.
          if (!wantBuiltin && wantExternal) {
            // No-op: external stays empty.
          }
        }

        return json(
          {
            query,
            effective_domains: effectiveDomains,
            specialists_that_would_see_this: specialistsSeeing,
            builtin,
            company,
            failures,
            external,
          },
          200,
          cors,
        );
      }

      if (url.pathname === "/knowledge/failures" && request.method === "GET") {
        const { readdirSync, statSync } = await import("node:fs");
        const { join } = await import("node:path");
        const root = join(import.meta.dir, "..", "knowledge", "builtin", "failures");
        const files: Array<{ domain: string; filename: string; size_bytes: number }> = [];
        try {
          for (const entry of readdirSync(root)) {
            const full = join(root, entry);
            try {
              if (statSync(full).isDirectory()) {
                for (const f of readdirSync(full)) {
                  if (f.endsWith(".md")) {
                    const fp = join(full, f);
                    files.push({ domain: entry, filename: f, size_bytes: statSync(fp).size });
                  }
                }
              }
            } catch {
              // ignore
            }
          }
        } catch {
          // no failures dir
        }
        return json({ files }, 200, cors);
      }

      // GET /knowledge/failures/{domain}/{filename}
      {
        const failMatch = url.pathname.match(/^\/knowledge\/failures\/([^/]+)\/([^/]+)$/);
        if (failMatch && request.method === "GET") {
          const domain = decodeURIComponent(failMatch[1]!);
          const filename = decodeURIComponent(failMatch[2]!);
          if (!UPLOAD_DOMAINS.has(domain) && domain !== "general") {
            return json({ error: `Unknown domain: ${domain}` }, 400, cors);
          }
          if (!filename.endsWith(".md") || filename.includes("..") || filename.includes("/")) {
            return json({ error: "Invalid filename" }, 400, cors);
          }
          const { readFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const filePath = join(import.meta.dir, "..", "knowledge", "builtin", "failures", domain, filename);
          try {
            const content = readFileSync(filePath, "utf8");
            return json({ domain, filename, content }, 200, cors);
          } catch {
            return json({ error: "File not found" }, 404, cors);
          }
        }
      }

      if (url.pathname === "/knowledge/external" && request.method === "GET") {
        return json({ sources: [], total_chunks: 0 }, 200, cors);
      }

      // ── documents ───────────────────────────────────────────────────
      if (url.pathname === "/documents" && request.method === "GET") {
        return json({ documents: listDocuments(db) }, 200, cors);
      }

      if (url.pathname === "/documents" && request.method === "POST") {
        const contentType = request.headers.get("content-type") ?? "";
        let filename = "";
        let domain = "general";
        let content = "";

        if (contentType.includes("multipart/form-data")) {
          const formData = await request.formData().catch(() => null);
          if (!formData) return json({ error: "Invalid multipart body" }, 400, cors);
          const file = formData.get("file") as unknown as File | null;
          const domainRaw = formData.get("domain");
          if (typeof domainRaw === "string") domain = domainRaw;
          if (!file || !(file instanceof File)) {
            return json({ error: "No file provided" }, 400, cors);
          }
          filename = file.name;
          // Validate before reading.
          const fnErr = validateFilename(filename);
          if (fnErr) return json({ error: fnErr }, 400, cors);
          const dErr = validateDomain(domain);
          if (dErr) return json({ error: dErr }, 400, cors);
          const buf = await file.arrayBuffer().catch(() => null);
          if (!buf) return json({ error: "Failed to read file" }, 400, cors);
          if (buf.byteLength > 50 * 1024 * 1024) {
            return json({ error: "File too large (max 50MB)" }, 413, cors);
          }
          content = new TextDecoder().decode(buf);
        } else {
          const body: unknown = await request.json().catch(() => null);
          const b = (body ?? {}) as Record<string, unknown>;
          filename = typeof b["filename"] === "string" ? b["filename"] : "";
          domain = typeof b["domain"] === "string" ? b["domain"] : "general";
          content = typeof b["content"] === "string" ? b["content"] : "";
          if (!filename) return json({ error: "filename is required" }, 400, cors);
          const fnErr = validateFilename(filename);
          if (fnErr) return json({ error: fnErr }, 400, cors);
          const dErr = validateDomain(domain);
          if (dErr) return json({ error: dErr }, 400, cors);
        }

        const doc = upsertDocument(db, filename, domain, content);
        return json({ filename: doc.filename, chunks_indexed: 1, domain: doc.domain, status: "indexed" }, 200, cors);
      }

      {
        const docMatch = url.pathname.match(/^\/documents\/([^/]+)$/);
        if (docMatch) {
          const filename = decodeURIComponent(docMatch[1]!);
          if (request.method === "GET") {
            // For GET, allow any filename that is a bare name — but reject dotfiles/paths.
            if (filename.startsWith(".") || filename.includes("/") || filename.includes("\\")) {
              return json({ error: "Invalid filename" }, 400, cors);
            }
            const doc = getDocument(db, filename);
            if (!doc) return json({ error: "Document not found" }, 404, cors);
            const text = doc.content.trim() ? doc.content : "_No extractable text in this document._";
            return json({ filename: doc.filename, content: text }, 200, cors);
          }
          if (request.method === "DELETE") {
            if (filename.startsWith(".") || filename.includes("/") || filename.includes("\\") || filename !== docMatch[1]) {
              return json({ error: "Invalid filename" }, 400, cors);
            }
            const ok = deleteDocument(db, filename);
            if (!ok) return json({ error: "Document not found" }, 404, cors);
            return json({ deleted: filename }, 200, cors);
          }
        }
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

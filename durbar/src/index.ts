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
import {
  buildUserContent,
  evaluateAndDispatch,
  TRIAGE_PROMPT,
  TRIAGE_TOOL,
  triageEvent,
  validateTriageEvent,
} from "./features/triage/triage.ts";
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
import {
  completeRun,
  createRun,
  deleteDynamicDef,
  deleteRun,
  deriveTitle,
  getDynamicDef,
  getRun,
  getWorkflow,
  listDynamicDefs,
  listRuns,
  listWorkflows,
  setDynamicActive,
  upsertDynamicDef,
  validateDynamicDef,
} from "./features/workflows/workflows.ts";
import {
  cancelScheduledAction,
  getScheduledAction,
  listScheduledActions,
  timingSafeEqual,
  VALID_STATUSES,
} from "./features/scheduled/scheduled.ts";
import {
  addAnnotation,
  bulkApprove,
  CONTENT_TYPES,
  countByStatus,
  deleteAnnotation,
  getReviewItem,
  listAnnotations,
  listReviewItems,
  PRIORITIES,
  REVIEW_STATUSES,
  setReviewPriority,
  setReviewStatus,
  setReviewStatusAndPriority,
  toggleAnnotation,
  updateAnnotation,
  updateReviewNotes,
} from "./features/review/review.ts";
import {
  aggregateReliability,
  approveDecision,
  getDecisionInstance,
  listInstances,
  rejectDecision,
} from "./features/decisions/decisions.ts";
import {
  buildSessionGraph,
  computeCostSummary,
  computeDegradations,
  countAudit,
  EVENT_TYPES,
  getAuditEvent,
  isValidSessionId,
  queryAudit,
  usageSummary,
} from "./features/audit/audit.ts";
import {
  archiveCandidate,
  archiveEngagement,
  archiveOffer,
  CANDIDATE_STAGES,
  createCandidate,
  createEngagement,
  createOffer,
  decideOffer,
  ENGAGEMENT_STATUSES,
  extendOffer,
  getCandidate,
  getEngagement,
  getOffer,
  listCandidates,
  listEngagements,
  listOffers,
  OFFER_STATUSES,
  setCandidateStage,
  updateCandidate,
  updateOfferTerms,
  upsertEngagement,
  validateCandidateCreate,
  validateEngagementCreate,
} from "./features/talent/talent.ts";
import {
  createWatchlist,
  deleteWatchlist,
  getWatchlistBySlug,
  isValidSlug,
  listSignalsForWatchlist,
  listWatchlist,
  updateWatchlist,
  VALID_CADENCES,
  VALID_SEVERITIES,
} from "./features/watchlist/watchlist.ts";
import {
  cockpitCards,
  createClient,
  deleteClient,
  deriveSlug,
  getClient,
  listClients,
  updateClientMeta,
} from "./features/clients/clients.ts";
import {
  appendMessage,
  commitSession,
  createSession,
  forceDraft,
  getSession as getOnboardingSession,
  sessionToResponse,
} from "./features/onboarding/onboarding.ts";
import {
  activatePlan,
  addTask,
  advancePhase,
  archivePlan,
  archiveTask,
  createPlan,
  deleteTask,
  deleteTemplate,
  getPlan,
  getTask,
  getTemplate,
  listPlans,
  listTasks,
  listTemplates,
  ONBOARDING_PHASES,
  ONBOARDING_STATUSES,
  setTaskStatus,
  TASK_STATUSES,
  updatePlan,
  upsertTemplate,
} from "./features/staff_onboarding/staff_onboarding.ts";
import {
  buildAgentDetail,
  buildAgentMeta,
  clearOverride,
  isKnownAgent,
  KNOWN_AGENTS,
  listHistory,
  rollbackTo,
  setOverride,
} from "./features/agents/agents.ts";
import {
  createPersona,
  deletePersona,
  getPersona,
  isBuiltin,
  listPersonas,
  personaExists,
  resetPersona,
  upsertPersona,
} from "./features/personas/personas.ts";
import {
  getSkill,
  listSkills,
  searchSkills,
} from "./features/skills/skills.ts";
import {
  cancelEvalRun,
  createEvalRun,
  createUserScenario,
  deleteEvalRun,
  deleteUserScenario,
  EVAL_KINDS,
  getEvalRun,
  getUserScenario,
  listEvalRuns,
  listScenarioMeta,
  updateUserScenario,
  validateScenarioYaml,
} from "./features/evals/evals.ts";
import {
  getPrebuilt as getArchPrebuilt,
  getSection as getArchSection,
  listPrebuilt as listArchPrebuilt,
  SECTIONS as ARCH_SECTIONS,
} from "./features/architecture/architecture.ts";
import {
  getGuidePrebuilt,
  getGuideSection,
  GUIDE_SECTIONS,
  listGuidePrebuilt,
} from "./features/guide/guide.ts";
import {
  createGeneratedFixture,
  deleteGeneratedFixture,
  deriveSlug as deriveFixtureSlug,
  fixtureExists,
  getFixtureStatus,
  listAllFixtures,
  loadFixture,
  resetAllState,
  snapshotUserState,
  unloadFixture,
} from "./features/fixtures/fixtures.ts";

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

      // ── triage ──────────────────────────────────────────────────────────
      // The Chief of Staff. Not a council specialist — it classifies inbound
      // events for significance and decides alerting. Exposed for manual
      // testing and for the alert-creation path to call into.
      if (url.pathname === "/features/triage/prompt" && request.method === "GET") {
        return json({ prompt: TRIAGE_PROMPT, tool: TRIAGE_TOOL }, 200, cors);
      }

      if (url.pathname === "/features/triage/classify" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const validated = validateTriageEvent(body);
        if (!validated.ok) return json({ error: validated.error }, 422, cors);
        const decision = await triageEvent(validated.event, { db, provider });
        return json(decision, 200, cors);
      }

      if (url.pathname === "/features/triage/evaluate" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const validated = validateTriageEvent(body);
        if (!validated.ok) return json({ error: validated.error }, 422, cors);
        const result = await evaluateAndDispatch(validated.event, { db, provider });
        return json(result, 200, cors);
      }

      // Back-compat aliases without the /features prefix.
      if (url.pathname === "/triage/classify" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const validated = validateTriageEvent(body);
        if (!validated.ok) return json({ error: validated.error }, 422, cors);
        const decision = await triageEvent(validated.event, { db, provider });
        return json(decision, 200, cors);
      }

      if (url.pathname === "/triage/evaluate" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const validated = validateTriageEvent(body);
        if (!validated.ok) return json({ error: validated.error }, 422, cors);
        const result = await evaluateAndDispatch(validated.event, { db, provider });
        return json(result, 200, cors);
      }

      if (url.pathname === "/triage/debug" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => ({}));
        const record = (body ?? {}) as Record<string, unknown>;
        const eventRaw = record["event"];
        if (!eventRaw || typeof eventRaw !== "object") {
          return json({ error: "event is required" }, 422, cors);
        }
        const validated = validateTriageEvent(eventRaw);
        if (!validated.ok) return json({ error: validated.error }, 422, cors);
        // Expose the prompt context that would be sent to the model — useful
        // for debugging why triage classified something a given way, without
        // spending a model call.
        const mutes = (await import("./features/alerts/alerts.ts")).listMutes(db).map((m) => m.pattern);
        const recent = (await import("./features/alerts/alerts.ts")).listAlerts(db, { limit: 20 }).map((alert) => ({
          headline: alert.headline,
          severity: alert.severity,
          dedup_key: alert.dedup_key,
          topic_tags: alert.topic_tags,
        }));
        const initiatives = (await import("./features/memories/memories.ts")).listInitiatives(db)
          .filter((item) => item.status !== "completed" && item.status !== "done")
          .map((item) => ({ title: item.title, status: item.status, summary: item.summary }));
        const userContent = buildUserContent(validated.event, recent, mutes, initiatives);
        return json({ system: TRIAGE_PROMPT, user: userContent, tool: TRIAGE_TOOL }, 200, cors);
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
      if (
        url.pathname.startsWith("/people/by-scope/") &&
        request.method === "GET"
      ) {
        const token = decodeURIComponent(
          url.pathname.slice("/people/by-scope/".length),
        );
        if (!(AUTHORITY_SCOPES as readonly string[]).includes(token)) {
          return json(
            {
              error: `Unknown scope token: ${JSON.stringify(token)}. Valid tokens: ${AUTHORITY_SCOPES.join(", ")}`,
            },
            400,
            cors,
          );
        }
        const approvers = findApprovers(
          db,
          token as (typeof AUTHORITY_SCOPES)[number],
        );
        return json(approvers, 200, cors);
      }

      if (url.pathname === "/people" && request.method === "GET") {
        const includeArchived =
          url.searchParams.get("include_archived") === "true";
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
            return json(
              {
                error:
                  "reports_to_person_id must reference an existing, non-archived person",
              },
              422,
              cors,
            );
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
          if (existing.archived)
            return new Response(null, { status: 204, headers: cors });
          try {
            archivePerson(db, id);
          } catch (error) {
            if (error instanceof PrincipalProtectionError) {
              return json({ error: error.message }, 409, cors);
            }
            const message =
              error instanceof Error ? error.message : String(error);
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
            if (!existing)
              return json({ error: "Person not found" }, 404, cors);
            const raw: unknown = await request.json().catch(() => null);
            const validated = validatePersonPatch(raw);
            if (!validated.ok)
              return json({ error: validated.error }, 422, cors);
            // FK validation for reports_to_person_id: target must exist and not be archived.
            if (
              validated.data.reports_to_person_id !== undefined &&
              validated.data.reports_to_person_id !== null
            ) {
              const target = getPerson(db, validated.data.reports_to_person_id);
              if (!target || target.archived) {
                return json(
                  {
                    error:
                      "reports_to_person_id must reference an existing, non-archived person",
                  },
                  422,
                  cors,
                );
              }
            }
            if (Object.keys(validated.data).length === 0) {
              return json(existing, 200, cors);
            }
            try {
              const updated = updatePerson(db, id, validated.data);
              if (!updated)
                return json({ error: "Person vanished" }, 500, cors);
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
          before = new Date(
            Date.now() - older_than_days * 24 * 60 * 60 * 1000,
          ).toISOString();
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
            return json(
              {
                error:
                  "Only resolved, expired or dismissed alerts can be reopened",
              },
              409,
              cors,
            );
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
      if (
        url.pathname === "/memories/initiatives" &&
        request.method === "GET"
      ) {
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
            for (const key of [
              "domain",
              "summary",
              "rationale",
              "outcome",
              "tags",
            ]) {
              if (key in patch && patch[key] !== undefined) {
                if (typeof patch[key] !== "string")
                  return json({ error: `${key} must be a string` }, 422, cors);
                allowed[key] = patch[key] as string;
              }
            }
            if (!updateDecision(db, id, allowed))
              return json({ error: "Decision not found" }, 404, cors);
            const updated = getDecision(db, id);
            if (!updated)
              return json({ error: "Decision not found" }, 404, cors);
            return json(updated, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!deleteDecision(db, id))
              return json({ error: "Decision not found" }, 404, cors);
            return new Response(null, { status: 204, headers: cors });
          }
        }
      }

      {
        const initMatch = url.pathname.match(
          /^\/memories\/initiatives\/(\d+)$/,
        );
        if (initMatch) {
          const id = Number(initMatch[1]);
          if (request.method === "PATCH") {
            const body: unknown = await request.json().catch(() => null);
            const patch = (body ?? {}) as Record<string, unknown>;
            const allowed: Record<string, string> = {};
            for (const key of ["title", "status", "summary"]) {
              if (key in patch && patch[key] !== undefined) {
                if (typeof patch[key] !== "string")
                  return json({ error: `${key} must be a string` }, 422, cors);
                allowed[key] = patch[key] as string;
              }
            }
            if (!updateInitiative(db, id, allowed))
              return json({ error: "Initiative not found" }, 404, cors);
            const updated = getInitiative(db, id);
            if (!updated)
              return json({ error: "Initiative not found" }, 404, cors);
            return json(updated, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!deleteInitiative(db, id))
              return json({ error: "Initiative not found" }, 404, cors);
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
                if (typeof patch[key] !== "string")
                  return json({ error: `${key} must be a string` }, 422, cors);
                allowed[key] = patch[key] as string;
              }
            }
            if (!updateAdvice(db, id, allowed))
              return json({ error: "Advice not found" }, 404, cors);
            const updated = getAdvice(db, id);
            if (!updated) return json({ error: "Advice not found" }, 404, cors);
            return json(updated, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!deleteAdvice(db, id))
              return json({ error: "Advice not found" }, 404, cors);
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
        const artifacts = listArtifacts(
          db,
          Number.isFinite(limit) ? limit : 200,
          archived,
        );
        return json({ artifacts }, 200, cors);
      }

      {
        const archiveMatch = url.pathname.match(/^\/artifacts\/(.+)\/archive$/);
        if (archiveMatch && request.method === "POST") {
          const compositeId = decodeURIComponent(archiveMatch[1]!);
          // Validate shape first: malformed id is 400, not 404.
          const parsed =
            compositeId.includes(":") &&
            (compositeId.startsWith("alert:") ||
              compositeId.startsWith("run:"));
          if (!parsed)
            return json(
              {
                error: `Malformed artifact id: ${JSON.stringify(compositeId)}`,
              },
              400,
              cors,
            );
          const ok = setArtifactArchived(db, compositeId, true);
          if (!ok)
            return json(
              { error: `Artifact ${JSON.stringify(compositeId)} not found` },
              404,
              cors,
            );
          return json({ status: "archived", id: compositeId }, 200, cors);
        }
      }

      {
        const restoreMatch = url.pathname.match(/^\/artifacts\/(.+)\/restore$/);
        if (restoreMatch && request.method === "POST") {
          const compositeId = decodeURIComponent(restoreMatch[1]!);
          const parsed =
            compositeId.includes(":") &&
            (compositeId.startsWith("alert:") ||
              compositeId.startsWith("run:"));
          if (!parsed)
            return json(
              {
                error: `Malformed artifact id: ${JSON.stringify(compositeId)}`,
              },
              400,
              cors,
            );
          const ok = setArtifactArchived(db, compositeId, false);
          if (!ok)
            return json(
              { error: `Artifact ${JSON.stringify(compositeId)} not found` },
              404,
              cors,
            );
          return json({ status: "restored", id: compositeId }, 200, cors);
        }
      }

      {
        const artifactMatch = url.pathname.match(/^\/artifacts\/(.+)$/);
        if (artifactMatch) {
          const compositeId = decodeURIComponent(artifactMatch[1]!);
          if (request.method === "GET") {
            const parsed =
              compositeId.includes(":") &&
              (compositeId.startsWith("alert:") ||
                compositeId.startsWith("run:"));
            if (!parsed)
              return json(
                {
                  error: `Malformed artifact id: ${JSON.stringify(compositeId)}`,
                },
                400,
                cors,
              );
            const artifact = getArtifact(db, compositeId);
            if (!artifact)
              return json(
                { error: `Artifact ${JSON.stringify(compositeId)} not found` },
                404,
                cors,
              );
            return json(artifact, 200, cors);
          }
          if (request.method === "DELETE") {
            const parsed =
              compositeId.includes(":") &&
              (compositeId.startsWith("alert:") ||
                compositeId.startsWith("run:"));
            if (!parsed)
              return json(
                {
                  error: `Malformed artifact id: ${JSON.stringify(compositeId)}`,
                },
                400,
                cors,
              );
            const ok = deleteArtifact(db, compositeId);
            if (!ok)
              return json(
                { error: `Artifact ${JSON.stringify(compositeId)} not found` },
                404,
                cors,
              );
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
            if (!deleteSession(db, sessionId))
              return json({ error: "Session not found" }, 404, cors);
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

      if (
        url.pathname === "/today/activity/daily" &&
        request.method === "GET"
      ) {
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
          new TextEncoderStream() as unknown as TransformStream<
            string,
            Uint8Array
          >,
        );
        return new Response(sseStream as unknown as ReadableStream, {
          status: 200,
          headers,
        });
      }

      if (url.pathname === "/chat/upload" && request.method === "POST") {
        const formData = await request.formData().catch(() => null);
        if (!formData)
          return json({ error: "Invalid multipart body" }, 400, cors);
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
        if (allFiles.length === 0)
          return json({ error: "No files uploaded" }, 400, cors);
        if (allFiles.length > 5)
          return json({ error: "Too many files: limit 5 per turn" }, 400, cors);
        for (const f of allFiles) {
          if (f.size > 20 * 1024 * 1024) {
            return json(
              {
                error: `${f.name}: file too large — ${Math.floor(f.size / (1024 * 1024))} MB (limit 20 MB)`,
              },
              413,
              cors,
            );
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
            textParts.push(
              `File: ${f.name} (${f.size} bytes, type ${f.type || "unknown"})`,
            );
          }
        }
        const attachmentText =
          textParts.length > 0 ? textParts.join("\n\n") : null;
        const { sessionId: resolvedId, stream } = await runChatTurn(
          {
            message,
            sessionId: sid,
            ...(attachmentText ? { attachmentText } : {}),
          },
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
          new TextEncoderStream() as unknown as TransformStream<
            string,
            Uint8Array
          >,
        );
        return new Response(sseStream as unknown as ReadableStream, {
          status: 200,
          headers,
        });
      }

      if (
        url.pathname === "/chat/suggested-prompts" &&
        request.method === "GET"
      ) {
        const result = buildSuggestedPrompts(db, provider);
        return json(result, 200, cors);
      }

      // ── knowledge ───────────────────────────────────────────────────
      if (url.pathname === "/knowledge/builtin" && request.method === "GET") {
        // List builtin files from the corpus on disk.
        const { readdirSync, statSync } = await import("node:fs");
        const { join } = await import("node:path");
        const root = join(import.meta.dir, "..", "knowledge", "builtin");
        const files: Array<{
          domain: string;
          filename: string;
          size_bytes: number;
        }> = [];
        const BUILTIN_EXCLUDE = new Set(["failures", "skills"]);
        const walk = (dir: string, domain: string): void => {
          try {
            for (const entry of readdirSync(dir)) {
              const full = join(dir, entry);
              const st = statSync(full);
              if (st.isDirectory()) {
                if (BUILTIN_EXCLUDE.has(entry)) continue;
                walk(full, entry);
              } else if (entry.endsWith(".md")) {
                files.push({ domain, filename: entry, size_bytes: st.size });
              }
            }
          } catch {
            // ignore missing dir
          }
        };
        // Only top-level domain dirs, excluding failures/skills (separate endpoints).
        try {
          for (const entry of readdirSync(root)) {
            const full = join(root, entry);
            try {
              if (
                statSync(full).isDirectory() &&
                !entry.startsWith(".") &&
                !BUILTIN_EXCLUDE.has(entry)
              ) {
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
        const nBuiltin =
          typeof b["n_builtin"] === "number" ? b["n_builtin"] : 5;
        const nCompany =
          typeof b["n_company"] === "number" ? b["n_company"] : 3;
        const nFailures =
          typeof b["n_failures"] === "number" ? b["n_failures"] : 3;
        // n_external reserved for OER partitioning when external sources are indexed; validated but not yet partitioned (external stays empty).
        const _nExternal =
          typeof b["n_external"] === "number" ? b["n_external"] : 5;
        void _nExternal;

        const validSources = new Set([
          "builtin",
          "company",
          "failures",
          "external",
        ]);
        if (include) {
          for (const inc of include) {
            if (!validSources.has(inc)) {
              return json(
                { error: `Invalid include values: ${inc}` },
                400,
                cors,
              );
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
          return json(
            { error: `Unknown specialist: ${specialist}` },
            400,
            cors,
          );
        }

        let effectiveDomains: readonly string[] | null | undefined =
          domainFilter ?? null;
        if (!effectiveDomains && specialist) {
          effectiveDomains = DOMAIN_ALIASES[specialist] ?? null;
        }

        const specialistsSeeing = effectiveDomains
          ? Object.entries(DOMAIN_ALIASES)
              .filter(([, doms]) =>
                doms.some((d) =>
                  (effectiveDomains as readonly string[]).includes(d),
                ),
              )
              .map(([name]) => name)
              .sort()
          : Object.keys(DOMAIN_ALIASES).sort();

        const wantBuiltin = !include || include.includes("builtin");
        const wantCompany = !include || include.includes("company");
        const wantFailures = !include || include.includes("failures");
        const wantExternal = !include || include.includes("external");

        const toHit = (
          hits: ReturnType<typeof searchKnowledge>,
        ): Array<Record<string, unknown>> =>
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
            ...(effectiveDomains
              ? { domain: [...effectiveDomains] as string[] }
              : {}),
            limit: Math.max(1, Math.min(nBuiltin, 25)),
          });
          builtin = toHit(hits);
        }
        if (wantCompany) {
          const companyDomains = withGeneral(
            effectiveDomains as string[] | null,
          ) as string[] | null;
          const hits = searchKnowledge(db, query as string, {
            ...(companyDomains
              ? { domain: [...companyDomains] as string[] }
              : {}),
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
        const root = join(
          import.meta.dir,
          "..",
          "knowledge",
          "builtin",
          "failures",
        );
        const files: Array<{
          domain: string;
          filename: string;
          size_bytes: number;
        }> = [];
        try {
          for (const entry of readdirSync(root)) {
            const full = join(root, entry);
            try {
              if (statSync(full).isDirectory()) {
                for (const f of readdirSync(full)) {
                  if (f.endsWith(".md")) {
                    const fp = join(full, f);
                    files.push({
                      domain: entry,
                      filename: f,
                      size_bytes: statSync(fp).size,
                    });
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
        const failMatch = url.pathname.match(
          /^\/knowledge\/failures\/([^/]+)\/([^/]+)$/,
        );
        if (failMatch && request.method === "GET") {
          const domain = decodeURIComponent(failMatch[1]!);
          const filename = decodeURIComponent(failMatch[2]!);
          if (!UPLOAD_DOMAINS.has(domain) && domain !== "general") {
            return json({ error: `Unknown domain: ${domain}` }, 400, cors);
          }
          if (
            !filename.endsWith(".md") ||
            filename.includes("..") ||
            filename.includes("/")
          ) {
            return json({ error: "Invalid filename" }, 400, cors);
          }
          const { readFileSync } = await import("node:fs");
          const { join } = await import("node:path");
          const filePath = join(
            import.meta.dir,
            "..",
            "knowledge",
            "builtin",
            "failures",
            domain,
            filename,
          );
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
          if (!formData)
            return json({ error: "Invalid multipart body" }, 400, cors);
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
          if (!filename)
            return json({ error: "filename is required" }, 400, cors);
          const fnErr = validateFilename(filename);
          if (fnErr) return json({ error: fnErr }, 400, cors);
          const dErr = validateDomain(domain);
          if (dErr) return json({ error: dErr }, 400, cors);
        }

        const doc = upsertDocument(db, filename, domain, content);
        return json(
          {
            filename: doc.filename,
            chunks_indexed: 1,
            domain: doc.domain,
            status: "indexed",
          },
          200,
          cors,
        );
      }

      {
        const docMatch = url.pathname.match(/^\/documents\/([^/]+)$/);
        if (docMatch) {
          const filename = decodeURIComponent(docMatch[1]!);
          if (request.method === "GET") {
            // For GET, allow any filename that is a bare name — but reject dotfiles/paths.
            if (
              filename.startsWith(".") ||
              filename.includes("/") ||
              filename.includes("\\")
            ) {
              return json({ error: "Invalid filename" }, 400, cors);
            }
            const doc = getDocument(db, filename);
            if (!doc) return json({ error: "Document not found" }, 404, cors);
            const text = doc.content.trim()
              ? doc.content
              : "_No extractable text in this document._";
            return json({ filename: doc.filename, content: text }, 200, cors);
          }
          if (request.method === "DELETE") {
            if (
              filename.startsWith(".") ||
              filename.includes("/") ||
              filename.includes("\\") ||
              filename !== docMatch[1]
            ) {
              return json({ error: "Invalid filename" }, 400, cors);
            }
            const ok = deleteDocument(db, filename);
            if (!ok) return json({ error: "Document not found" }, 404, cors);
            return json({ deleted: filename }, 200, cors);
          }
        }
      }

      // ── workflows ───────────────────────────────────────────────────
      // Dynamic routes declared before /workflows/{name} so "custom" is not
      // captured as a workflow name.

      if (url.pathname === "/workflows" && request.method === "GET") {
        return json({ workflows: listWorkflows(db) }, 200, cors);
      }

      if (url.pathname === "/workflows/runs" && request.method === "GET") {
        const workflow = url.searchParams.get("workflow");
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 100;
        return json({ runs: listRuns(db, workflow, limit) }, 200, cors);
      }

      {
        const runMatch = url.pathname.match(/^\/workflows\/runs\/([^/]+)$/);
        if (runMatch) {
          const runId = runMatch[1] as string;
          if (request.method === "GET") {
            const run = getRun(db, runId);
            if (!run) return json({ error: `Run ${runId} not found` }, 404, cors);
            return json(run, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!deleteRun(db, runId)) return json({ error: `Run ${runId} not found` }, 404, cors);
            return json({ status: "deleted", run_id: runId }, 200, cors);
          }
        }
      }

      if (url.pathname === "/workflows/custom" && request.method === "GET") {
        return json({ definitions: listDynamicDefs(db, false) }, 200, cors);
      }

      if (url.pathname === "/workflows/custom" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        if (!body || typeof body !== "object") return json({ error: "Invalid JSON" }, 400, cors);
        const defn = body as Record<string, unknown>;
        if (typeof defn["name"] !== "string" || !(defn["name"] as string).trim()) {
          return json({ error: "name is required" }, 400, cors);
        }
        const name = defn["name"] as string;
        if (getDynamicDef(db, name)) {
          return json({ error: `A custom workflow named ${JSON.stringify(name)} already exists` }, 409, cors);
        }
        const errors = validateDynamicDef(defn as unknown as Parameters<typeof validateDynamicDef>[0]);
        if (errors.length > 0) return json({ error: errors.join("; "), detail: errors }, 422, cors);
        const stored = upsertDynamicDef(db, defn as unknown as Parameters<typeof upsertDynamicDef>[1]);
        return json(stored, 201, cors);
      }

      {
        const customMatch = url.pathname.match(/^\/workflows\/custom\/([^/]+)(\/activate)?$/);
        if (customMatch) {
          const name = decodeURIComponent(customMatch[1] as string);
          const isActivate = customMatch[2] === "/activate";
          if (isActivate && request.method === "POST") {
            const body: unknown = await request.json().catch(() => ({}));
            const b = (body ?? {}) as Record<string, unknown>;
            const isActive = b["is_active"] !== undefined ? Boolean(b["is_active"]) : true;
            if (!setDynamicActive(db, name, isActive)) {
              return json({ error: `Custom workflow ${JSON.stringify(name)} not found` }, 404, cors);
            }
            const defn = getDynamicDef(db, name);
            return json(defn, 200, cors);
          }
          if (!isActivate && request.method === "GET") {
            const defn = getDynamicDef(db, name);
            if (!defn) return json({ error: `Custom workflow ${JSON.stringify(name)} not found` }, 404, cors);
            return json(defn, 200, cors);
          }
          if (!isActivate && request.method === "PUT") {
            if (!getDynamicDef(db, name)) {
              return json({ error: `Custom workflow ${JSON.stringify(name)} not found` }, 404, cors);
            }
            const body: unknown = await request.json().catch(() => null);
            if (!body || typeof body !== "object") return json({ error: "Invalid JSON" }, 400, cors);
            const defn = body as Record<string, unknown> & { name: string };
            if (defn.name !== name) {
              return json({ error: "definition name does not match the path name" }, 422, cors);
            }
            const errors = validateDynamicDef(defn as unknown as Parameters<typeof validateDynamicDef>[0]);
            if (errors.length > 0) return json({ error: errors.join("; "), detail: errors }, 422, cors);
            const stored = upsertDynamicDef(db, defn as unknown as Parameters<typeof upsertDynamicDef>[1]);
            return json(stored, 200, cors);
          }
          if (!isActivate && request.method === "DELETE") {
            if (!deleteDynamicDef(db, name)) {
              return json({ error: `Custom workflow ${JSON.stringify(name)} not found` }, 404, cors);
            }
            return json({ status: "deleted", name }, 200, cors);
          }
        }
      }

      {
        const sampleMatch = url.pathname.match(/^\/workflows\/([^/]+)\/sample$/);
        if (sampleMatch && request.method === "GET") {
          const name = decodeURIComponent(sampleMatch[1] as string);
          const wf = getWorkflow(db, name);
          if (!wf) return json({ error: `Unknown workflow: ${name}` }, 404, cors);
          // Sample inputs are not yet materialized — return 404 per the Python contract
          // when no sample is defined (all builtins currently have none in Durbar).
          return json({ error: `Workflow ${JSON.stringify(name)} does not expose a sample` }, 404, cors);
        }
      }

      {
        const wfMatch = url.pathname.match(/^\/workflows\/([^/]+)$/);
        if (wfMatch && request.method === "GET") {
          const name = decodeURIComponent(wfMatch[1] as string);
          // Avoid capturing "custom" and "runs" which are handled above.
          if (name === "custom" || name === "runs") {
            // fall through to 404
          } else {
            const wf = getWorkflow(db, name);
            if (!wf) return json({ error: `Unknown workflow: ${name}` }, 404, cors);
            return json(wf, 200, cors);
          }
        }
      }

      {
        const runPostMatch = url.pathname.match(/^\/workflows\/([^/]+)\/runs$/);
        if (runPostMatch && request.method === "POST") {
          const name = decodeURIComponent(runPostMatch[1] as string);
          const wf = getWorkflow(db, name);
          if (!wf) return json({ error: `Unknown workflow: ${name}` }, 404, cors);
          const payload: unknown = await request.json().catch(() => null);
          if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
            return json({ error: "Invalid JSON" }, 400, cors);
          }
          const inputs = payload as Record<string, unknown>;
          const runId = crypto.randomUUID();
          const title = deriveTitle(name, inputs);

          // Real execution for the three scheduled workflows — thin prompt + context + artifact.
          // All other workflows remain stubbed until Task 9.
          const scheduledWorkflowNames = new Set([
            "end_of_day_digest",
            "executive_reflection",
            "executive_research",
            "morning_brief",
          ]);

          let artifact: string;
          if (scheduledWorkflowNames.has(name)) {
            try {
              if (name === "end_of_day_digest") {
                const { runEndOfDayDigest } = await import("./features/briefings/end-of-day-digest.ts");
                const result = await runEndOfDayDigest(
                  {
                    ...(typeof inputs["periodLabel"] === "string" ? { periodLabel: inputs["periodLabel"] as string } : {}),
                    ...(typeof inputs["period_label"] === "string" ? { periodLabel: inputs["period_label"] as string } : {}),
                    ...(typeof inputs["forceFull"] === "boolean" ? { forceFull: inputs["forceFull"] as boolean } : {}),
                    ...(typeof inputs["force_full"] === "boolean" ? { forceFull: inputs["force_full"] as boolean } : {}),
                  },
                  { db, provider, runId },
                );
                artifact = result.narrative;
              } else if (name === "executive_reflection") {
                const { runExecutiveReflection } = await import("./features/workflows/executive-reflection.ts");
                const result = await runExecutiveReflection(
                  {
                    ...(typeof inputs["periodLabel"] === "string" ? { periodLabel: inputs["periodLabel"] as string } : {}),
                    ...(typeof inputs["period_label"] === "string" ? { periodLabel: inputs["period_label"] as string } : {}),
                  },
                  { db, provider, runId },
                );
                artifact = result.narrative;
              } else if (name === "executive_research") {
                const { runExecutiveResearch } = await import("./features/workflows/executive-research.ts");
                const result = await runExecutiveResearch(
                  {
                    ...(typeof inputs["note"] === "string" ? { note: inputs["note"] as string } : {}),
                  },
                  { db, provider, runId },
                );
                artifact = result.narrative;
              } else if (name === "morning_brief") {
                const { runMorningBrief } = await import("./features/briefings/morning-brief.ts");
                const result = await runMorningBrief(
                  {
                    ...(typeof inputs["periodLabel"] === "string" ? { periodLabel: inputs["periodLabel"] as string } : {}),
                    ...(typeof inputs["period_label"] === "string" ? { periodLabel: inputs["period_label"] as string } : {}),
                    ...(typeof inputs["forceFull"] === "boolean" ? { forceFull: inputs["forceFull"] as boolean } : {}),
                    ...(typeof inputs["force_full"] === "boolean" ? { forceFull: inputs["force_full"] as boolean } : {}),
                  },
                  { db, provider, runId },
                );
                artifact = result.narrative;
              } else {
                createRun(db, runId, name, title, inputs);
                artifact = `# ${title}\n\n_Unexpected scheduled workflow name._`;
                completeRun(db, runId, artifact);
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : String(error);
              // Workflow impls now own persistence via runId passthrough; if they
              // threw before inserting, create a failed run so the outer id is not orphaned.
              const existing = getRun(db, runId);
              if (!existing) {
                createRun(db, runId, name, title, inputs);
                const { failRun } = await import("./features/workflows/workflows.ts");
                failRun(db, runId, message);
              } else {
                const { failRun } = await import("./features/workflows/workflows.ts");
                failRun(db, runId, message);
              }
              const sseHeaders: Record<string, string> = {
                "content-type": "text/event-stream",
                "cache-control": "no-cache",
                "x-accel-buffering": "no",
                ...cors,
              };
              const sseBody = [
                `data: ${JSON.stringify({ type: "run_created", run_id: runId, title, workflow: name, steps: wf.steps })}\n\n`,
                `data: ${JSON.stringify({ type: "error", message })}\n\n`,
                `data: ${JSON.stringify({ type: "done", run_id: runId })}\n\n`,
              ].join("");
              return new Response(sseBody, { status: 200, headers: sseHeaders });
            }
          } else {
            createRun(db, runId, name, title, inputs);
            artifact = `# ${title}\n\n_This run was stubbed — full workflow execution is not yet wired in Durbar._\n\nInputs:\n\`\`\`json\n${JSON.stringify(inputs, null, 2)}\n\`\`\``;
            completeRun(db, runId, artifact);
          }

          const sseHeaders: Record<string, string> = {
            "content-type": "text/event-stream",
            "cache-control": "no-cache",
            "x-accel-buffering": "no",
            ...cors,
          };
          const sseBody = [
            `data: ${JSON.stringify({ type: "run_created", run_id: runId, title, workflow: name, steps: wf.steps })}\n\n`,
            `data: ${JSON.stringify({ type: "artifact", content: artifact })}\n\n`,
            `data: ${JSON.stringify({ type: "done", run_id: runId })}\n\n`,
          ].join("");
          return new Response(sseBody, { status: 200, headers: sseHeaders });
        }
      }

      // ── scheduled ───────────────────────────────────────────────────
      if (url.pathname === "/scheduled" && request.method === "GET") {
        const status = url.searchParams.get("status") ?? "pending";
        const limitRaw = url.searchParams.get("limit");
        const order = url.searchParams.get("order") ?? "asc";
        if (status !== "all" && !VALID_STATUSES.has(status)) {
          return json({ error: `status must be 'all' or one of ${[...VALID_STATUSES].sort().join(", ")}` }, 400, cors);
        }
        const limit = limitRaw ? Number(limitRaw) : 100;
        if (!Number.isFinite(limit) || limit < 1 || limit > 1000) {
          return json({ error: "limit must be between 1 and 1000" }, 400, cors);
        }
        if (order !== "asc" && order !== "desc") {
          return json({ error: "order must be 'asc' or 'desc'" }, 400, cors);
        }
        const rows = listScheduledActions(db, status === "all" ? null : status, limit, order);
        return json(rows, 200, cors);
      }

      {
        const schedMatch = url.pathname.match(/^\/scheduled\/(\d+)$/);
        if (schedMatch) {
          const id = Number(schedMatch[1]);
          if (request.method === "GET") {
            const row = getScheduledAction(db, id);
            if (!row) return json({ error: "scheduled action not found" }, 404, cors);
            return json(row, 200, cors);
          }
          if (request.method === "DELETE") {
            // Admin gate: mirrors Python require_admin_token (fail-closed).
            // X-Forwarded-For is comma-split; first entry is the originating IP.
            // Missing header is treated as NOT loopback so remote curl without
            // the header cannot bypass the 503 when SCHEDULED_ADMIN_TOKEN is unset.
            const expected = settings.scheduledAdminToken;
            const headerToken = request.headers.get("x-admin-token");
            const forwarded = request.headers.get("x-forwarded-for");
            const firstForwarded = forwarded ? forwarded.split(",")[0]!.trim() : null;
            const LOOPBACKS = new Set(["127.0.0.1", "::1", "localhost"]);
            const isLoopback = firstForwarded !== null && LOOPBACKS.has(firstForwarded);
            if (expected) {
              if (!headerToken || !timingSafeEqual(headerToken, expected)) {
                return json({ error: "Invalid or missing X-Admin-Token" }, 401, cors);
              }
            } else if (!isLoopback) {
              return json(
                {
                  error:
                    "Scheduled-action admin endpoints are disabled. Set SCHEDULED_ADMIN_TOKEN to enable them for non-loopback access.",
                },
                503,
                cors,
              );
            }
            const result = cancelScheduledAction(db, id);
            if (result === "not_found") return json({ error: "scheduled action not found" }, 404, cors);
            if (result === "not_cancellable") {
              return json({ error: "action is already running, done, failed, or cancelled — cannot cancel" }, 409, cors);
            }
            const row = getScheduledAction(db, id);
            return json(row, 200, cors);
          }
        }
      }

      // ── review ──────────────────────────────────────────────────────
      if (url.pathname === "/review/items" && request.method === "GET") {
        const status = url.searchParams.get("status") as string | null;
        const domain = url.searchParams.get("domain");
        const contentType = url.searchParams.get("content_type") as string | null;
        const limitRaw = url.searchParams.get("limit");
        const offsetRaw = url.searchParams.get("offset");
        if (status && !REVIEW_STATUSES.includes(status as (typeof REVIEW_STATUSES)[number])) {
          return json({ error: `Invalid status: ${status}` }, 400, cors);
        }
        if (contentType && !CONTENT_TYPES.includes(contentType as (typeof CONTENT_TYPES)[number])) {
          return json({ error: `Invalid content_type: ${contentType}` }, 400, cors);
        }
        const limit = limitRaw ? Number(limitRaw) : 100;
        const offset = offsetRaw ? Number(offsetRaw) : 0;
        const items = listReviewItems(db, {
          ...(status ? { status: status as (typeof REVIEW_STATUSES)[number] } : {}),
          ...(domain ? { domain } : {}),
          ...(contentType ? { contentType: contentType as (typeof CONTENT_TYPES)[number] } : {}),
          limit,
          offset,
        });
        return json(items, 200, cors);
      }

      if (url.pathname === "/review/stats" && request.method === "GET") {
        return json(countByStatus(db), 200, cors);
      }

      if (url.pathname === "/review/bulk-approve" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => ({}));
        const b = (body ?? {}) as Record<string, unknown>;
        const domain = typeof b["domain"] === "string" ? b["domain"] : null;
        const count = bulkApprove(db, domain);
        return json({ approved_count: count }, 200, cors);
      }

      if (url.pathname === "/review/annotations" && request.method === "GET") {
        const activeOnlyRaw = url.searchParams.get("active_only");
        const activeOnly = activeOnlyRaw === null ? true : activeOnlyRaw !== "false";
        return json(listAnnotations(db, { activeOnly }), 200, cors);
      }

      {
        const reviewItemMatch = url.pathname.match(/^\/review\/items\/([^/]+)$/);
        if (reviewItemMatch) {
          const itemId = decodeURIComponent(reviewItemMatch[1] as string);
          if (request.method === "GET") {
            const item = getReviewItem(db, itemId);
            if (!item) return json({ error: "Review item not found" }, 404, cors);
            const annotations = listAnnotations(db, { itemId, activeOnly: false });
            return json({ item, annotations }, 200, cors);
          }
          if (request.method === "PATCH") {
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            const status = b["status"] as string | undefined;
            const priority = b["priority"] as string | undefined;
            const reviewerNotes = b["reviewer_notes"] as string | undefined;
            if (status && !REVIEW_STATUSES.includes(status as (typeof REVIEW_STATUSES)[number])) {
              return json({ error: `Invalid status: ${status}` }, 400, cors);
            }
            if (priority && !PRIORITIES.includes(priority as (typeof PRIORITIES)[number])) {
              return json({ error: `Invalid priority: ${priority}` }, 400, cors);
            }
            let item = getReviewItem(db, itemId);
            if (!item) return json({ error: "Review item not found" }, 404, cors);
            if (status && priority) {
              const notes = reviewerNotes !== undefined ? reviewerNotes : item.reviewer_notes;
              item = setReviewStatusAndPriority(
                db,
                itemId,
                status as (typeof REVIEW_STATUSES)[number],
                priority as (typeof PRIORITIES)[number],
                notes,
              ) as typeof item;
            } else if (status) {
              const notes = reviewerNotes !== undefined ? reviewerNotes : item.reviewer_notes;
              item = setReviewStatus(db, itemId, status as (typeof REVIEW_STATUSES)[number], notes) as typeof item;
              if (priority) {
                item = setReviewPriority(db, itemId, priority as (typeof PRIORITIES)[number]) as typeof item;
              }
            } else if (reviewerNotes !== undefined) {
              item = updateReviewNotes(db, itemId, reviewerNotes) as typeof item;
              if (priority) {
                item = setReviewPriority(db, itemId, priority as (typeof PRIORITIES)[number]) as typeof item;
              }
            } else if (priority) {
              item = setReviewPriority(db, itemId, priority as (typeof PRIORITIES)[number]) as typeof item;
            }
            return json(item, 200, cors);
          }
        }
      }

      {
        const itemAnnotListMatch = url.pathname.match(/^\/review\/items\/([^/]+)\/annotations$/);
        if (itemAnnotListMatch) {
          const itemId = decodeURIComponent(itemAnnotListMatch[1] as string);
          if (request.method === "GET") {
            if (!getReviewItem(db, itemId)) return json({ error: "Review item not found" }, 404, cors);
            return json(listAnnotations(db, { itemId, activeOnly: false }), 200, cors);
          }
          if (request.method === "POST") {
            const item = getReviewItem(db, itemId);
            if (!item) return json({ error: "Review item not found" }, 404, cors);
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            const correction = b["correction"];
            if (typeof correction !== "string" || !correction.trim()) {
              return json({ error: "correction is required" }, 400, cors);
            }
            const annot = addAnnotation(db, itemId, item.domain, correction);
            return json(annot, 200, cors);
          }
        }
      }

      {
        const annotMatch = url.pathname.match(/^\/review\/annotations\/([^/]+)$/);
        if (annotMatch) {
          const annotId = decodeURIComponent(annotMatch[1] as string);
          if (request.method === "PATCH") {
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            if (typeof b["correction"] === "string") updateAnnotation(db, annotId, b["correction"] as string);
            if (typeof b["is_active"] === "boolean") toggleAnnotation(db, annotId, b["is_active"] as boolean);
            return json({ updated: annotId }, 200, cors);
          }
          if (request.method === "DELETE") {
            deleteAnnotation(db, annotId);
            return json({ deleted: annotId }, 200, cors);
          }
        }
      }

      // ── decisions ───────────────────────────────────────────────────
      if (url.pathname === "/decisions" && request.method === "GET") {
        const decisionClass = url.searchParams.get("decision_class") ?? "meeting_scheduling";
        const status = url.searchParams.get("status");
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 50;
        if (!Number.isFinite(limit) || limit < 1 || limit > 500) {
          return json({ error: "limit must be 1–500" }, 400, cors);
        }
        return json(listInstances(db, decisionClass, { ...(status ? { status } : {}), limit }), 200, cors);
      }

      {
        const decMatch = url.pathname.match(/^\/decisions\/(\d+)$/);
        if (decMatch && request.method === "GET") {
          const id = Number(decMatch[1]);
          const inst = getDecisionInstance(db, id);
          if (!inst) return json({ error: "Decision instance not found" }, 404, cors);
          return json(inst, 200, cors);
        }
      }

      {
        const approveMatch = url.pathname.match(/^\/decisions\/(\d+)\/approve$/);
        if (approveMatch && request.method === "POST") {
          const id = Number(approveMatch[1]);
          const body: unknown = await request.json().catch(() => ({}));
          const b = (body ?? {}) as Record<string, unknown>;
          const edits = (b["edits"] as Record<string, unknown> | null) ?? null;
          const result = approveDecision(db, id, edits);
          if (result.error) return json({ error: result.error }, result.statusCode ?? 400, cors);
          return json(result.instance, 200, cors);
        }
      }

      {
        const rejectMatch = url.pathname.match(/^\/decisions\/(\d+)\/reject$/);
        if (rejectMatch && request.method === "POST") {
          const id = Number(rejectMatch[1]);
          const result = rejectDecision(db, id);
          if (result.error) return json({ error: result.error }, result.statusCode ?? 400, cors);
          return json(result.instance, 200, cors);
        }
      }

      if (url.pathname === "/audit/reliability" && request.method === "GET") {
        const decisionClass = url.searchParams.get("decision_class") ?? "meeting_scheduling";
        const daysRaw = url.searchParams.get("days");
        const days = daysRaw ? Number(daysRaw) : 30;
        if (!Number.isFinite(days) || days < 1 || days > 365) {
          return json({ error: "days must be 1–365" }, 400, cors);
        }
        return json(aggregateReliability(db, decisionClass, days), 200, cors);
      }

      // ── audit ───────────────────────────────────────────────────────
      if (url.pathname === "/audit/logs" && request.method === "GET") {
        const eventType = url.searchParams.get("event_type");
        const sessionId = url.searchParams.get("session_id");
        const actor = url.searchParams.get("actor");
        const q = url.searchParams.get("q");
        const since = url.searchParams.get("since");
        const until = url.searchParams.get("until");
        const limitRaw = url.searchParams.get("limit");
        const offsetRaw = url.searchParams.get("offset");
        const limit = limitRaw ? Number(limitRaw) : 100;
        const offset = offsetRaw ? Number(offsetRaw) : 0;
        if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
          return json({ error: "limit must be an integer in [1, 1000]" }, 400, cors);
        }
        if (!Number.isInteger(offset) || offset < 0) {
          return json({ error: "offset must be a non-negative integer" }, 400, cors);
        }
        if (since !== null && Number.isNaN(Date.parse(since))) {
          return json({ error: "since must be an ISO8601 timestamp" }, 400, cors);
        }
        if (until !== null && Number.isNaN(Date.parse(until))) {
          return json({ error: "until must be an ISO8601 timestamp" }, 400, cors);
        }
        if (eventType && !EVENT_TYPES.includes(eventType as (typeof EVENT_TYPES)[number])) {
          return json({ error: `Unknown event_type: ${JSON.stringify(eventType)}` }, 422, cors);
        }
        const items = queryAudit(db, {
          ...(eventType ? { eventType } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(actor ? { actor } : {}),
          ...(q ? { q } : {}),
          ...(since ? { since } : {}),
          ...(until ? { until } : {}),
          limit,
          offset,
        });
        const total = countAudit(db, {
          ...(eventType ? { eventType } : {}),
          ...(sessionId ? { sessionId } : {}),
          ...(actor ? { actor } : {}),
          ...(q ? { q } : {}),
          ...(since ? { since } : {}),
          ...(until ? { until } : {}),
        });
        return json({ items, total, limit, offset, event_types: [...EVENT_TYPES] }, 200, cors);
      }

      {
        const auditLogMatch = url.pathname.match(/^\/audit\/logs\/(\d+)$/);
        if (auditLogMatch && request.method === "GET") {
          const id = Number(auditLogMatch[1]);
          const event = getAuditEvent(db, id);
          if (!event) return json({ error: "audit event not found" }, 404, cors);
          return json(event, 200, cors);
        }
      }

      {
        const auditSessMatch = url.pathname.match(/^\/audit\/sessions\/([^/]+)$/);
        if (auditSessMatch && request.method === "GET") {
          const sessionId = decodeURIComponent(auditSessMatch[1] as string);
          if (!isValidSessionId(sessionId)) {
            return json({ error: "invalid session_id format" }, 400, cors);
          }
          const events = queryAudit(db, { sessionId, limit: 1000 });
          if (events.length === 0) return json({ error: "no events for session_id" }, 404, cors);
          const { graph, channel } = buildSessionGraph(events);
          const costSummary = computeCostSummary(events);
          const degradations = computeDegradations(events);
          return json(
            {
              session_id: sessionId,
              events: events.map((e) => ({
                id: e.id,
                ts: e.ts,
                event_type: e.event_type,
                session_id: e.session_id,
                turn_id: e.turn_id,
                actor: e.actor,
                summary: e.summary,
                details: e.details,
              })),
              graph,
              channel,
              cost_summary: costSummary,
              degradations,
            },
            200,
            cors,
          );
        }
      }

      if (url.pathname === "/audit/usage" && request.method === "GET") {
        const since = url.searchParams.get("since");
        const until = url.searchParams.get("until");
        const data = usageSummary(db, since, until);
        return json(
          {
            since: since ?? null,
            until: until ?? null,
            totals: data.totals,
            by_day: data.by_day,
            by_model: data.by_model,
            by_source: data.by_source,
          },
          200,
          cors,
        );
      }

      // ── talent ────────────────────────────────────────────────────────
      // Engagements
      if (url.pathname === "/engagements" && request.method === "GET") {
        const includeArchived = url.searchParams.get("include_archived") === "true";
        return json(listEngagements(db, includeArchived), 200, cors);
      }
      if (url.pathname === "/engagements" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const validated = validateEngagementCreate(body);
        if (!validated.ok) return json({ error: validated.error }, 422, cors);
        const created = createEngagement(db, validated.data);
        return json(created, 201, cors);
      }
      {
        const engArchiveMatch = url.pathname.match(/^\/engagements\/(\d+)\/archive$/);
        if (engArchiveMatch && request.method === "POST") {
          const id = Number(engArchiveMatch[1]);
          if (!getEngagement(db, id)) return json({ error: "Engagement not found" }, 404, cors);
          archiveEngagement(db, id);
          return new Response(null, { status: 204, headers: cors });
        }
      }
      {
        const engMatch = url.pathname.match(/^\/engagements\/(\d+)\/matches$/);
        if (engMatch && request.method === "GET") {
          const id = Number(engMatch[1]);
          if (!getEngagement(db, id)) return json({ error: "Engagement not found" }, 404, cors);
          // Stub: graph matching deferred — return empty
          return json([], 200, cors);
        }
      }
      {
        const engGetMatch = url.pathname.match(/^\/engagements\/(\d+)$/);
        if (engGetMatch) {
          const id = Number(engGetMatch[1]);
          if (request.method === "GET") {
            const eng = getEngagement(db, id);
            if (!eng) return json({ error: "Engagement not found" }, 404, cors);
            return json(eng, 200, cors);
          }
          if (request.method === "PATCH") {
            const existing = getEngagement(db, id);
            if (!existing) return json({ error: "Engagement not found" }, 404, cors);
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            const patch: Record<string, unknown> = {};
            for (const k of ["role_title", "department", "status", "location", "comp_band", "must_haves", "description"]) {
              if (k in b && b[k] !== undefined) patch[k] = b[k];
            }
            if (patch["status"] && !ENGAGEMENT_STATUSES.includes(patch["status"] as typeof ENGAGEMENT_STATUSES[number])) {
              return json({ error: `Invalid status: ${patch["status"]}` }, 422, cors);
            }
            if (patch["role_title"] !== undefined && (typeof patch["role_title"] !== "string" || !(patch["role_title"] as string).trim())) {
              return json({ error: "role_title must be non-empty" }, 422, cors);
            }
            const roleTitle = (patch["role_title"] as string | undefined) ?? existing.role_title;
            const updated = upsertEngagement(db, id, { ...patch, role_title: roleTitle } as Parameters<typeof upsertEngagement>[2]);
            return json(updated, 200, cors);
          }
        }
      }
      if (url.pathname === "/talent/reindex" && request.method === "POST") {
        return json({ indexed: 0 }, 200, cors);
      }
      // Candidates — literal paths before param paths
      // Spec alias: GET /candidates/similar?candidate_id=123 (query-style)
      if (url.pathname === "/candidates/similar" && request.method === "GET") {
        const candidateIdRaw = url.searchParams.get("candidate_id");
        if (!candidateIdRaw) return json({ error: "candidate_id query param is required" }, 400, cors);
        const id = Number(candidateIdRaw);
        if (!Number.isInteger(id)) return json({ error: "candidate_id must be an integer" }, 400, cors);
        if (!getCandidate(db, id)) return json({ error: "Candidate not found" }, 404, cors);
        return json([], 200, cors);
      }
      if (url.pathname === "/candidates" && request.method === "GET") {
        const engagementId = url.searchParams.get("engagement_id") ? Number(url.searchParams.get("engagement_id")) : undefined;
        const stage = url.searchParams.get("stage") as typeof CANDIDATE_STAGES[number] | null;
        const includeArchived = url.searchParams.get("include_archived") === "true";
        if (stage && !CANDIDATE_STAGES.includes(stage)) return json({ error: `Invalid stage: ${stage}` }, 422, cors);
        return json(listCandidates(db, { ...(engagementId !== undefined ? { engagement_id: engagementId } : {}), ...(stage ? { stage } : {}), includeArchived }), 200, cors);
      }
      if (url.pathname === "/candidates" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const validated = validateCandidateCreate(body);
        if (!validated.ok) return json({ error: validated.error }, 422, cors);
        if (!getEngagement(db, validated.data.engagement_id)) return json({ error: `Engagement ${validated.data.engagement_id} not found` }, 404, cors);
        const created = createCandidate(db, validated.data);
        return json(created, 201, cors);
      }
      {
        const candSimilarMatch = url.pathname.match(/^\/candidates\/(\d+)\/similar$/);
        if (candSimilarMatch && request.method === "GET") {
          const id = Number(candSimilarMatch[1]);
          if (!getCandidate(db, id)) return json({ error: "Candidate not found" }, 404, cors);
          return json([], 200, cors);
        }
      }
      {
        const candStageMatch = url.pathname.match(/^\/candidates\/(\d+)\/stage$/);
        if (candStageMatch && request.method === "POST") {
          const id = Number(candStageMatch[1]);
          if (!getCandidate(db, id)) return json({ error: "Candidate not found" }, 404, cors);
          const body: unknown = await request.json().catch(() => null);
          const b = (body ?? {}) as Record<string, unknown>;
          const stage = b["stage"] as string | undefined;
          if (!stage || !CANDIDATE_STAGES.includes(stage as typeof CANDIDATE_STAGES[number])) return json({ error: `Invalid stage: ${stage}` }, 422, cors);
          const updated = setCandidateStage(db, id, stage as typeof CANDIDATE_STAGES[number]);
          if (!updated) return json({ error: "Candidate not found" }, 404, cors);
          return json(updated, 200, cors);
        }
      }
      {
        const candArchiveMatch = url.pathname.match(/^\/candidates\/(\d+)\/archive$/);
        if (candArchiveMatch && request.method === "POST") {
          const id = Number(candArchiveMatch[1]);
          if (!getCandidate(db, id)) return json({ error: "Candidate not found" }, 404, cors);
          archiveCandidate(db, id);
          return new Response(null, { status: 204, headers: cors });
        }
      }
      {
        const candGetMatch = url.pathname.match(/^\/candidates\/(\d+)$/);
        if (candGetMatch) {
          const id = Number(candGetMatch[1]);
          if (request.method === "GET") {
            const cand = getCandidate(db, id);
            if (!cand) return json({ error: "Candidate not found" }, 404, cors);
            return json(cand, 200, cors);
          }
          if (request.method === "PATCH") {
            const existing = getCandidate(db, id);
            if (!existing) return json({ error: "Candidate not found" }, 404, cors);
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            const patch: Record<string, unknown> = {};
            for (const k of ["full_name", "current_title", "current_company", "location", "source", "notes"]) {
              if (k in b && b[k] !== undefined) {
                if (k === "full_name" && typeof b[k] === "string" && !(b[k] as string).trim()) return json({ error: "full_name must be non-empty" }, 422, cors);
                patch[k] = b[k];
              }
            }
            if ("email" in b) patch["email"] = b["email"];
            if ("linkedin_url" in b) patch["linkedin_url"] = b["linkedin_url"];
            const updated = updateCandidate(db, id, patch as Parameters<typeof updateCandidate>[2]);
            if (!updated) return json({ error: "Candidate not found" }, 404, cors);
            return json(updated, 200, cors);
          }
        }
      }
      // Offers
      if (url.pathname === "/offers" && request.method === "GET") {
        const candidateId = url.searchParams.get("candidate_id") ? Number(url.searchParams.get("candidate_id")) : undefined;
        const engagementId = url.searchParams.get("engagement_id") ? Number(url.searchParams.get("engagement_id")) : undefined;
        const status = url.searchParams.get("status") as typeof OFFER_STATUSES[number] | null;
        const includeArchived = url.searchParams.get("include_archived") === "true";
        if (status && !OFFER_STATUSES.includes(status)) return json({ error: `Invalid status: ${status}` }, 422, cors);
        return json(listOffers(db, { ...(candidateId !== undefined ? { candidate_id: candidateId } : {}), ...(engagementId !== undefined ? { engagement_id: engagementId } : {}), ...(status ? { status } : {}), includeArchived }), 200, cors);
      }
      if (url.pathname === "/offers" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const candidateId = b["candidate_id"];
        const compSummary = b["comp_summary"];
        if (typeof candidateId !== "number" || !Number.isInteger(candidateId)) return json({ error: "candidate_id is required" }, 422, cors);
        if (typeof compSummary !== "string" || !compSummary.trim()) return json({ error: "comp_summary is required" }, 422, cors);
        const candidate = getCandidate(db, candidateId);
        if (!candidate) return json({ error: `Candidate ${candidateId} not found` }, 404, cors);
        try {
          const offer = createOffer(db, { candidate_id: candidateId, engagement_id: candidate.engagement_id, comp_summary: compSummary.trim(), note: typeof b["note"] === "string" ? b["note"] : undefined });
          return json(offer, 201, cors);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("already has an open offer")) return json({ error: msg }, 409, cors);
          return json({ error: msg }, 400, cors);
        }
      }
      {
        const offerArchiveMatch = url.pathname.match(/^\/offers\/(\d+)\/archive$/);
        if (offerArchiveMatch && request.method === "POST") {
          const id = Number(offerArchiveMatch[1]);
          if (!getOffer(db, id)) return json({ error: "Offer not found" }, 404, cors);
          archiveOffer(db, id);
          return new Response(null, { status: 204, headers: cors });
        }
      }
      {
        const offerExtendMatch = url.pathname.match(/^\/offers\/(\d+)\/extend$/);
        if (offerExtendMatch && request.method === "POST") {
          const id = Number(offerExtendMatch[1]);
          if (!getOffer(db, id)) return json({ error: "Offer not found" }, 404, cors);
          const body: unknown = await request.json().catch(() => ({}));
          const b = (body ?? {}) as Record<string, unknown>;
          try {
            const offer = extendOffer(db, id, { expires_at: typeof b["expires_at"] === "string" ? b["expires_at"] : null, expires_in_days: typeof b["expires_in_days"] === "number" ? b["expires_in_days"] : 7, note: typeof b["note"] === "string" ? b["note"] : null });
            return json({ offer, approval_state: "none", nudges_scheduled: 0, warnings: [] }, 200, cors);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("not an ISO") || msg.includes("must be in the future")) return json({ error: msg }, 400, cors);
            return json({ error: msg }, 409, cors);
          }
        }
      }
      {
        const offerDecisionMatch = url.pathname.match(/^\/offers\/(\d+)\/decision$/);
        if (offerDecisionMatch && request.method === "POST") {
          const id = Number(offerDecisionMatch[1]);
          if (!getOffer(db, id)) return json({ error: "Offer not found" }, 404, cors);
          const body: unknown = await request.json().catch(() => ({}));
          const b = (body ?? {}) as Record<string, unknown>;
          const decision = b["decision"] as string | undefined;
          if (!decision || !["accepted", "declined", "expired", "rescinded"].includes(decision)) return json({ error: `Invalid decision: ${decision}` }, 422, cors);
          try {
            const offer = decideOffer(db, id, decision as typeof OFFER_STATUSES[number], typeof b["note"] === "string" ? b["note"] : null);
            return json({ offer, cancelled_nudges: 0, side_effects: [] }, 200, cors);
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return json({ error: msg }, 409, cors);
          }
        }
      }
      {
        const offerPatchMatch = url.pathname.match(/^\/offers\/(\d+)$/);
        if (offerPatchMatch) {
          const id = Number(offerPatchMatch[1]);
          if (request.method === "GET") {
            const offer = getOffer(db, id);
            if (!offer) return json({ error: "Offer not found" }, 404, cors);
            return json(offer, 200, cors);
          }
          if (request.method === "PATCH") {
            const existing = getOffer(db, id);
            if (!existing) return json({ error: "Offer not found" }, 404, cors);
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            try {
              const updated = updateOfferTerms(db, id, { comp_summary: typeof b["comp_summary"] === "string" ? b["comp_summary"] : null, note: typeof b["note"] === "string" ? b["note"] : null });
              if (!updated) return json({ error: "Offer not found" }, 404, cors);
              return json(updated, 200, cors);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              return json({ error: msg }, 409, cors);
            }
          }
        }
      }

      // ── watchlist ───────────────────────────────────────────────────
      if (url.pathname === "/watchlist" && request.method === "GET") {
        const enabledOnly = url.searchParams.get("enabled_only") === "true";
        const signalType = url.searchParams.get("signal_type") ?? undefined;
        return json(listWatchlist(db, { enabledOnly, ...(signalType ? { signalType } : {}) }), 200, cors);
      }
      if (url.pathname === "/watchlist" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const slug = typeof b["slug"] === "string" ? (b["slug"] as string).trim() : "";
        const signalType = typeof b["signal_type"] === "string" ? (b["signal_type"] as string).trim() : "";
        const target = typeof b["target"] === "string" ? (b["target"] as string).trim() : "";
        if (!slug || !isValidSlug(slug)) return json({ error: `slug ${JSON.stringify(slug)} must be kebab-case, max 61 chars (a-z, 0-9, '-')` }, 400, cors);
        if (!signalType) return json({ error: "signal_type is required" }, 400, cors);
        if (!target) return json({ error: "target is required" }, 400, cors);
        const cadence = typeof b["cadence"] === "string" ? b["cadence"] as string : "15min";
        if (!VALID_CADENCES.includes(cadence as typeof VALID_CADENCES[number])) return json({ error: `unknown cadence ${JSON.stringify(cadence)}` }, 400, cors);
        const mode = typeof b["mode"] === "string" ? b["mode"] as string : "active";
        if (!["active", "dry_run"].includes(mode)) return json({ error: `unknown mode ${JSON.stringify(mode)}` }, 400, cors);
        const severityFloor = typeof b["severity_floor"] === "string" ? b["severity_floor"] as string : "low";
        const severityCeiling = typeof b["severity_ceiling"] === "string" ? b["severity_ceiling"] as string : "urgent";
        if (!VALID_SEVERITIES.includes(severityFloor as typeof VALID_SEVERITIES[number])) return json({ error: `unknown severity_floor ${JSON.stringify(severityFloor)}` }, 400, cors);
        if (!VALID_SEVERITIES.includes(severityCeiling as typeof VALID_SEVERITIES[number])) return json({ error: `unknown severity_ceiling ${JSON.stringify(severityCeiling)}` }, 400, cors);
        if (getWatchlistBySlug(db, slug)) return json({ error: `slug ${JSON.stringify(slug)} already exists; PATCH it instead` }, 409, cors);
        try {
          const created = createWatchlist(db, { slug, signal_type: signalType, target, cadence, severity_floor: severityFloor, severity_ceiling: severityCeiling, mode, route_to_specialist: typeof b["route_to_specialist"] === "string" ? b["route_to_specialist"] as string : "", notes: typeof b["notes"] === "string" ? (b["notes"] as string).slice(0, 500) : "" });
          return json(created, 201, cors);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("UNIQUE")) return json({ error: `slug ${JSON.stringify(slug)} already exists; PATCH it instead` }, 409, cors);
          return json({ error: msg }, 500, cors);
        }
      }
      if (url.pathname === "/watchlist/signals" && request.method === "GET") {
        // Global signals listing — not in reference, but useful; return empty
        return json([], 200, cors);
      }
      {
        const wlSignalsMatch = url.pathname.match(/^\/watchlist\/([^/]+)\/signals$/);
        if (wlSignalsMatch && request.method === "GET") {
          const slug = decodeURIComponent(wlSignalsMatch[1]!);
          const item = getWatchlistBySlug(db, slug);
          if (!item) return json({ error: `Watchlist entry ${JSON.stringify(slug)} not found` }, 404, cors);
          const limitRaw = url.searchParams.get("limit");
          const limit = limitRaw ? Math.max(1, Math.min(Number(limitRaw) || 50, 200)) : 50;
          return json(listSignalsForWatchlist(db, item.id, limit), 200, cors);
        }
      }
      {
        const wlApproveMatch = url.pathname.match(/^\/watchlist\/([^/]+)\/approve$/);
        if (wlApproveMatch && request.method === "POST") {
          const slug = decodeURIComponent(wlApproveMatch[1]!);
          const item = getWatchlistBySlug(db, slug);
          if (!item) return json({ error: `Watchlist entry ${JSON.stringify(slug)} not found` }, 404, cors);
          // Approve: set enabled=1, mode=active
          const updated = updateWatchlist(db, item.id, { enabled: true, mode: "active" });
          return json(updated, 200, cors);
        }
      }
      {
        const wlDeclineMatch = url.pathname.match(/^\/watchlist\/([^/]+)\/decline$/);
        if (wlDeclineMatch && request.method === "POST") {
          const slug = decodeURIComponent(wlDeclineMatch[1]!);
          const item = getWatchlistBySlug(db, slug);
          if (!item) return json({ error: `Watchlist entry ${JSON.stringify(slug)} not found` }, 404, cors);
          const body: unknown = await request.json().catch(() => ({}));
          const b = (body ?? {}) as Record<string, unknown>;
          const reason = typeof b["reason"] === "string" ? b["reason"] as string : "not_relevant";
          if (reason === "too_noisy") {
            const updated = updateWatchlist(db, item.id, { severity_floor: "high", mode: "active" });
            return json({ slug, reason, result: "kept_high_floor", item: updated }, 200, cors);
          }
          deleteWatchlist(db, slug);
          return json({ slug, reason, result: "removed" }, 200, cors);
        }
      }
      {
        const wlMatch = url.pathname.match(/^\/watchlist\/([^/]+)$/);
        if (wlMatch) {
          const slug = decodeURIComponent(wlMatch[1]!);
          if (request.method === "GET") {
            const item = getWatchlistBySlug(db, slug);
            if (!item) return json({ error: `Watchlist entry ${JSON.stringify(slug)} not found` }, 404, cors);
            return json(item, 200, cors);
          }
          if (request.method === "PATCH") {
            const item = getWatchlistBySlug(db, slug);
            if (!item) return json({ error: `Watchlist entry ${JSON.stringify(slug)} not found` }, 404, cors);
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            if (b["mode"] !== undefined && b["mode"] !== null && !["active", "dry_run"].includes(b["mode"] as string)) return json({ error: `unknown mode ${JSON.stringify(b["mode"])}` }, 400, cors);
            if (b["cadence"] !== undefined && b["cadence"] !== null && !VALID_CADENCES.includes(b["cadence"] as typeof VALID_CADENCES[number])) return json({ error: `unknown cadence ${JSON.stringify(b["cadence"])}` }, 400, cors);
            if (b["severity_floor"] !== undefined && b["severity_floor"] !== null && !VALID_SEVERITIES.includes(b["severity_floor"] as typeof VALID_SEVERITIES[number])) return json({ error: `unknown severity_floor ${JSON.stringify(b["severity_floor"])}` }, 400, cors);
            if (b["severity_ceiling"] !== undefined && b["severity_ceiling"] !== null && !VALID_SEVERITIES.includes(b["severity_ceiling"] as typeof VALID_SEVERITIES[number])) return json({ error: `unknown severity_ceiling ${JSON.stringify(b["severity_ceiling"])}` }, 400, cors);
            const patch: Record<string, unknown> = {};
            if ("enabled" in b) patch["enabled"] = b["enabled"];
            if ("mode" in b && b["mode"] !== null) patch["mode"] = b["mode"];
            if ("cadence" in b && b["cadence"] !== null) patch["cadence"] = b["cadence"];
            if ("severity_floor" in b && b["severity_floor"] !== null) patch["severity_floor"] = b["severity_floor"];
            if ("severity_ceiling" in b && b["severity_ceiling"] !== null) patch["severity_ceiling"] = b["severity_ceiling"];
            if ("trigger" in b && b["trigger"] !== null) patch["trigger"] = b["trigger"];
            if ("notes" in b && b["notes"] !== null) patch["notes"] = b["notes"];
            if (Object.keys(patch).length === 0) return json({ error: "nothing to change — pass at least one tunable field" }, 400, cors);
            const updated = updateWatchlist(db, item.id, patch);
            return json(updated, 200, cors);
          }
          if (request.method === "DELETE") {
            const item = getWatchlistBySlug(db, slug);
            if (!item) return json({ error: `Watchlist entry ${JSON.stringify(slug)} not found` }, 404, cors);
            deleteWatchlist(db, slug);
            return new Response(null, { status: 204, headers: cors });
          }
        }
      }

      // ── clients ─────────────────────────────────────────────────────
      // Literal paths before param paths
      if (url.pathname === "/clients/cockpit" && request.method === "GET") {
        const cards = cockpitCards(db);
        return json({ clients: cards, generated_at: new Date().toISOString() }, 200, cors);
      }
      if (url.pathname === "/clients/generate" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const description = typeof b["description"] === "string" ? (b["description"] as string).trim() : "";
        if (!description) return json({ error: "description is required" }, 400, cors);
        const suggested = deriveSlug(description.slice(0, 40));
        // Stub: return a bundle without LLM generation
        return json({ suggested_name: suggested, display_name: description.slice(0, 80), bundle: { profile: { name: description.slice(0, 80) }, docs: [] } }, 200, cors);
      }
      if (url.pathname === "/clients/save" && request.method === "POST") {
        return json({ saved: true }, 200, cors);
      }
      if (url.pathname === "/clients" && request.method === "GET") {
        const clients = listClients(db);
        return json({ active: null, fixture_active: null, rotation_in_progress: false, clients }, 200, cors);
      }
      if (url.pathname === "/clients" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const displayName = typeof b["display_name"] === "string" ? (b["display_name"] as string).trim() : "";
        if (!displayName) return json({ error: "display_name is required" }, 400, cors);
        const slugRaw = typeof b["slug"] === "string" ? (b["slug"] as string).trim() : "";
        const slug = slugRaw || deriveSlug(displayName);
        if (!/^[a-z0-9_-]+$/.test(slug)) return json({ error: "Invalid slug" }, 400, cors);
        if (getClient(db, slug)) return json({ error: `Client ${JSON.stringify(slug)} already exists` }, 409, cors);
        const created = createClient(db, { slug, display_name: displayName });
        return json(created, 201, cors);
      }
      {
        const clientActivateMatch = url.pathname.match(/^\/clients\/([^/]+)\/activate$/);
        if (clientActivateMatch && request.method === "POST") {
          const slug = decodeURIComponent(clientActivateMatch[1]!);
          const client = getClient(db, slug);
          if (!client) return json({ error: `Client ${JSON.stringify(slug)} not found` }, 404, cors);
          return json({ activated: slug }, 200, cors);
        }
      }
      {
        const clientMatch = url.pathname.match(/^\/clients\/([^/]+)$/);
        if (clientMatch) {
          const slug = decodeURIComponent(clientMatch[1]!);
          if (request.method === "GET") {
            const client = getClient(db, slug);
            if (!client) return json({ error: `Client ${JSON.stringify(slug)} not found` }, 404, cors);
            return json(client, 200, cors);
          }
          if (request.method === "PATCH") {
            const existing = getClient(db, slug);
            if (!existing) return json({ error: `Client ${JSON.stringify(slug)} not found` }, 404, cors);
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            if (!b || Object.keys(b).length === 0) return json({ error: "empty metadata patch" }, 400, cors);
            const updated = updateClientMeta(db, slug, b);
            return json(updated, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!getClient(db, slug)) return json({ error: `Client ${JSON.stringify(slug)} not found` }, 404, cors);
            deleteClient(db, slug);
            return json({ deleted: slug }, 200, cors);
          }
        }
      }

      // ── onboarding (company-setup interview) ────────────────────────
      if (url.pathname === "/onboard/start" && request.method === "POST") {
        const id = crypto.randomUUID();
        const session = createSession(db, id);
        return json(sessionToResponse(session), 200, cors);
      }
      if (url.pathname === "/onboard/message" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const sessionId = typeof b["session_id"] === "string" ? b["session_id"] as string : "";
        const message = typeof b["message"] === "string" ? b["message"] as string : "";
        if (!sessionId) return json({ error: "session_id is required" }, 400, cors);
        if (!message.trim()) return json({ error: "message is required" }, 400, cors);
        if (message.length > 20000) return json({ error: "message too long" }, 422, cors);
        const session = getOnboardingSession(db, sessionId);
        if (!session) return json({ error: "Setup session not found or expired." }, 404, cors);
        try {
          const updated = appendMessage(db, sessionId, "user", message);
          if (!updated) return json({ error: "Setup session not found or expired." }, 404, cors);
          return json(sessionToResponse(updated), 200, cors);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("Already committed")) return json({ error: msg }, 400, cors);
          throw e;
        }
      }
      if (url.pathname === "/onboard/draft" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const sessionId = typeof b["session_id"] === "string" ? b["session_id"] as string : "";
        if (!sessionId) return json({ error: "session_id is required" }, 400, cors);
        const session = getOnboardingSession(db, sessionId);
        if (!session) return json({ error: "Setup session not found or expired." }, 404, cors);
        const updated = forceDraft(db, sessionId);
        if (!updated) return json({ error: "Setup session not found or expired." }, 404, cors);
        return json(sessionToResponse(updated), 200, cors);
      }
      if (url.pathname === "/onboard/commit" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const sessionId = typeof b["session_id"] === "string" ? b["session_id"] as string : "";
        if (!sessionId) return json({ error: "session_id is required" }, 400, cors);
        const session = getOnboardingSession(db, sessionId);
        if (!session) return json({ error: "Setup session not found or expired." }, 404, cors);
        try {
          const profilePatch = (b["profile"] as Record<string, unknown> | undefined) ?? undefined;
          const updated = commitSession(db, sessionId, profilePatch);
          if (!updated) return json({ error: "Setup session not found or expired." }, 404, cors);
          return json(sessionToResponse(updated), 200, cors);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("No draft") || msg.includes("Already committed") || msg.includes("must have a name")) return json({ error: msg }, 422, cors);
          throw e;
        }
      }
      {
        const onboardSessionMatch = url.pathname.match(/^\/onboard\/session\/([^/]+)$/);
        if (onboardSessionMatch && request.method === "GET") {
          const id = decodeURIComponent(onboardSessionMatch[1]!);
          const session = getOnboardingSession(db, id);
          if (!session) return json({ error: "Setup session not found or expired." }, 404, cors);
          return json(sessionToResponse(session), 200, cors);
        }
      }

      // ── staff onboarding ────────────────────────────────────────────
      // Templates — literal before param
      if (url.pathname === "/onboarding-templates" && request.method === "GET") {
        const activeOnly = url.searchParams.get("active_only") !== "false";
        return json(listTemplates(db, activeOnly), 200, cors);
      }
      if (url.pathname === "/onboarding-templates" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const name = typeof b["name"] === "string" ? (b["name"] as string).trim() : "";
        if (!name || !/^[a-z0-9_]+$/.test(name)) return json({ error: "name must be snake_case (a-z, 0-9, _)" }, 422, cors);
        const title = typeof b["title"] === "string" ? (b["title"] as string).trim() : "";
        if (!title) return json({ error: "title is required" }, 422, cors);
        const tmpl = upsertTemplate(db, { name, title, description: typeof b["description"] === "string" ? b["description"] as string : "", department: typeof b["department"] === "string" ? b["department"] as string : "", ramp_days: typeof b["ramp_days"] === "number" ? b["ramp_days"] : 0, checkin_cadence: typeof b["checkin_cadence"] === "string" ? b["checkin_cadence"] as string : "", task_specs: Array.isArray(b["task_specs"]) ? b["task_specs"] as never[] : [], brief_sections: Array.isArray(b["brief_sections"]) ? b["brief_sections"] as string[] : [], is_active: b["is_active"] !== false, created_at: "", updated_at: "" });
        return json(tmpl, 200, cors);
      }
      {
        const tmplMatch = url.pathname.match(/^\/onboarding-templates\/([^/]+)$/);
        if (tmplMatch) {
          const name = decodeURIComponent(tmplMatch[1]!);
          if (request.method === "GET") {
            const tmpl = getTemplate(db, name);
            if (!tmpl) return json({ error: "Template not found" }, 404, cors);
            return json(tmpl, 200, cors);
          }
          if (request.method === "PUT") {
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            if (typeof b["name"] === "string" && b["name"] !== name) return json({ error: "Body name must match path name" }, 400, cors);
            const title = typeof b["title"] === "string" ? (b["title"] as string).trim() : "";
            if (!title) return json({ error: "title is required" }, 422, cors);
            const tmpl = upsertTemplate(db, { name, title, description: typeof b["description"] === "string" ? b["description"] as string : "", department: typeof b["department"] === "string" ? b["department"] as string : "", ramp_days: typeof b["ramp_days"] === "number" ? b["ramp_days"] : 0, checkin_cadence: typeof b["checkin_cadence"] === "string" ? b["checkin_cadence"] as string : "", task_specs: Array.isArray(b["task_specs"]) ? b["task_specs"] as never[] : [], brief_sections: Array.isArray(b["brief_sections"]) ? b["brief_sections"] as string[] : [], is_active: b["is_active"] !== false, created_at: "", updated_at: "" });
            return json(tmpl, 200, cors);
          }
          if (request.method === "PATCH") {
            const existing = getTemplate(db, name);
            if (!existing) return json({ error: "Template not found" }, 404, cors);
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            const patch: Record<string, unknown> = {};
            for (const k of ["title", "description", "department", "ramp_days", "checkin_cadence", "task_specs", "brief_sections", "is_active"]) {
              if (k in b) patch[k] = b[k];
            }
            const updated = upsertTemplate(db, { ...existing, ...patch, name } as typeof existing);
            return json(updated, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!deleteTemplate(db, name)) return json({ error: "Template not found" }, 404, cors);
            return new Response(null, { status: 204, headers: cors });
          }
        }
      }
      // Plans
      if (url.pathname === "/onboarding-plans" && request.method === "GET") {
        const status = url.searchParams.get("status") as typeof ONBOARDING_STATUSES[number] | null;
        const includeArchived = url.searchParams.get("include_archived") === "true";
        if (status && !ONBOARDING_STATUSES.includes(status)) return json({ error: `Invalid status: ${status}` }, 422, cors);
        return json(listPlans(db, { ...(status ? { status } : {}), includeArchived }), 200, cors);
      }
      if (url.pathname === "/onboarding-plans" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const fullName = typeof b["full_name"] === "string" ? (b["full_name"] as string).trim() : "";
        const startDate = typeof b["start_date"] === "string" ? (b["start_date"] as string).trim() : "";
        if (!fullName) return json({ error: "full_name is required" }, 422, cors);
        if (!startDate) return json({ error: "start_date is required" }, 422, cors);
        const templateName = typeof b["template_name"] === "string" ? b["template_name"] as string : "";
        if (templateName && !getTemplate(db, templateName)) return json({ error: `Template ${JSON.stringify(templateName)} not found` }, 404, cors);
        const plan = createPlan(db, { full_name: fullName, start_date: startDate, role: typeof b["role"] === "string" ? b["role"] as string : "", template_name: templateName, person_id: typeof b["person_id"] === "number" ? b["person_id"] : null, manager_person_id: typeof b["manager_person_id"] === "number" ? b["manager_person_id"] : null, buddy_person_id: typeof b["buddy_person_id"] === "number" ? b["buddy_person_id"] : null, engagement_id: typeof b["engagement_id"] === "number" ? b["engagement_id"] : null, candidate_id: typeof b["candidate_id"] === "number" ? b["candidate_id"] : null });
        return json(plan, 201, cors);
      }
      {
        const planAdvanceMatch = url.pathname.match(/^\/onboarding-plans\/(\d+)\/advance$/);
        if (planAdvanceMatch && request.method === "POST") {
          const id = Number(planAdvanceMatch[1]);
          if (!getPlan(db, id)) return json({ error: "Plan not found" }, 404, cors);
          const updated = advancePhase(db, id);
          return json(updated, 200, cors);
        }
      }
      {
        const planActivateMatch = url.pathname.match(/^\/onboarding-plans\/(\d+)\/activate$/);
        if (planActivateMatch && request.method === "POST") {
          const id = Number(planActivateMatch[1]);
          if (!getPlan(db, id)) return json({ error: "Plan not found" }, 404, cors);
          const updated = activatePlan(db, id);
          return json(updated, 200, cors);
        }
      }
      {
        const planArchiveMatch = url.pathname.match(/^\/onboarding-plans\/(\d+)\/archive$/);
        if (planArchiveMatch && request.method === "POST") {
          const id = Number(planArchiveMatch[1]);
          if (!getPlan(db, id)) return json({ error: "Plan not found" }, 404, cors);
          archivePlan(db, id);
          return new Response(null, { status: 204, headers: cors });
        }
      }
      {
        const planTasksMatch = url.pathname.match(/^\/onboarding-plans\/(\d+)\/tasks$/);
        if (planTasksMatch) {
          const planId = Number(planTasksMatch[1]);
          if (request.method === "GET") {
            if (!getPlan(db, planId)) return json({ error: "Plan not found" }, 404, cors);
            return json(listTasks(db, planId), 200, cors);
          }
          if (request.method === "POST") {
            if (!getPlan(db, planId)) return json({ error: "Plan not found" }, 404, cors);
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            const title = typeof b["title"] === "string" ? (b["title"] as string).trim() : "";
            if (!title) return json({ error: "title is required" }, 422, cors);
            const phase = typeof b["phase"] === "string" ? b["phase"] as string : "week_1";
            if (!ONBOARDING_PHASES.includes(phase as typeof ONBOARDING_PHASES[number])) return json({ error: `Invalid phase: ${phase}` }, 422, cors);
            const task = addTask(db, planId, { title, phase: phase as typeof ONBOARDING_PHASES[number], category: typeof b["category"] === "string" ? b["category"] as string : "general", owner_person_id: typeof b["owner_person_id"] === "number" ? b["owner_person_id"] : null, due_date: typeof b["due_date"] === "string" ? b["due_date"] : null });
            return json(task, 201, cors);
          }
        }
      }
      {
        const planGetMatch = url.pathname.match(/^\/onboarding-plans\/(\d+)$/);
        if (planGetMatch) {
          const id = Number(planGetMatch[1]);
          if (request.method === "GET") {
            const plan = getPlan(db, id);
            if (!plan) return json({ error: "Plan not found" }, 404, cors);
            return json(plan, 200, cors);
          }
          if (request.method === "PATCH") {
            if (!getPlan(db, id)) return json({ error: "Plan not found" }, 404, cors);
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            const patch: Record<string, unknown> = {};
            if ("person_id" in b) patch["person_id"] = b["person_id"];
            if ("manager_person_id" in b) patch["manager_person_id"] = b["manager_person_id"];
            if ("buddy_person_id" in b) patch["buddy_person_id"] = b["buddy_person_id"];
            if ("status" in b && b["status"] !== null) {
              if (!ONBOARDING_STATUSES.includes(b["status"] as typeof ONBOARDING_STATUSES[number])) return json({ error: `Invalid status: ${b["status"]}` }, 422, cors);
              patch["status"] = b["status"];
            }
            if ("current_phase" in b && b["current_phase"] !== null) {
              if (!ONBOARDING_PHASES.includes(b["current_phase"] as typeof ONBOARDING_PHASES[number])) return json({ error: `Invalid phase: ${b["current_phase"]}` }, 422, cors);
              patch["current_phase"] = b["current_phase"];
            }
            const updated = updatePlan(db, id, patch as Parameters<typeof updatePlan>[2]);
            return json(updated, 200, cors);
          }
        }
      }
      // Onboarding tasks — top-level
      if (url.pathname === "/onboarding-tasks" && request.method === "GET") {
        const planId = url.searchParams.get("plan_id") ? Number(url.searchParams.get("plan_id")) : undefined;
        return json(listTasks(db, planId), 200, cors);
      }
      if (url.pathname === "/onboarding-tasks" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const planId = typeof b["plan_id"] === "number" ? b["plan_id"] : null;
        const title = typeof b["title"] === "string" ? (b["title"] as string).trim() : "";
        if (!planId) return json({ error: "plan_id is required" }, 422, cors);
        if (!title) return json({ error: "title is required" }, 422, cors);
        if (!getPlan(db, planId)) return json({ error: "Plan not found" }, 404, cors);
        const task = addTask(db, planId, { title, phase: typeof b["phase"] === "string" && ONBOARDING_PHASES.includes(b["phase"] as typeof ONBOARDING_PHASES[number]) ? b["phase"] as typeof ONBOARDING_PHASES[number] : "week_1", category: typeof b["category"] === "string" ? b["category"] as string : "general" });
        return json(task, 201, cors);
      }
      {
        const taskActivateMatch = url.pathname.match(/^\/onboarding-tasks\/(\d+)\/activate$/);
        if (taskActivateMatch && request.method === "POST") {
          const id = Number(taskActivateMatch[1]);
          const task = getTask(db, id);
          if (!task) return json({ error: "Task not found" }, 404, cors);
          const updated = setTaskStatus(db, id, "in_progress");
          return json(updated, 200, cors);
        }
      }
      {
        const taskArchiveMatch = url.pathname.match(/^\/onboarding-tasks\/(\d+)\/archive$/);
        if (taskArchiveMatch && request.method === "POST") {
          const id = Number(taskArchiveMatch[1]);
          if (!getTask(db, id)) return json({ error: "Task not found" }, 404, cors);
          archiveTask(db, id);
          return new Response(null, { status: 204, headers: cors });
        }
      }
      {
        const taskStatusMatch = url.pathname.match(/^\/onboarding-tasks\/(\d+)\/status$/);
        if (taskStatusMatch && request.method === "POST") {
          const id = Number(taskStatusMatch[1]);
          if (!getTask(db, id)) return json({ error: "Task not found" }, 404, cors);
          const body: unknown = await request.json().catch(() => null);
          const b = (body ?? {}) as Record<string, unknown>;
          const status = b["status"] as string | undefined;
          if (!status || !TASK_STATUSES.includes(status as typeof TASK_STATUSES[number])) return json({ error: `Invalid status: ${status}` }, 422, cors);
          const updated = setTaskStatus(db, id, status as typeof TASK_STATUSES[number], typeof b["completed_by_person_id"] === "number" ? b["completed_by_person_id"] : null);
          return json(updated, 200, cors);
        }
      }
      {
        const taskMatch = url.pathname.match(/^\/onboarding-tasks\/(\d+)$/);
        if (taskMatch && request.method === "DELETE") {
          const id = Number(taskMatch[1]);
          if (!deleteTask(db, id)) return json({ error: "Task not found" }, 404, cors);
          return new Response(null, { status: 204, headers: cors });
        }
      }

      // ── agents ──────────────────────────────────────────────────────
      if (url.pathname === "/agents/models" && request.method === "GET") {
        return json(["deepseek-chat", "deepseek-reasoner", "gpt-4o", "claude-3-5-sonnet"], 200, cors);
      }
      if (url.pathname === "/agents" && request.method === "GET") {
        const agents = KNOWN_AGENTS.map((id) => buildAgentMeta(db, id));
        return json(agents, 200, cors);
      }
      {
        const agentHistoryMatch = url.pathname.match(/^\/agents\/([^/]+)\/history$/);
        if (agentHistoryMatch && request.method === "GET") {
          const agentId = decodeURIComponent(agentHistoryMatch[1]!);
          if (!isKnownAgent(agentId)) return json({ error: "Unknown agent" }, 404, cors);
          return json(listHistory(db, agentId), 200, cors);
        }
      }
      {
        const agentRollbackMatch = url.pathname.match(/^\/agents\/([^/]+)\/rollback$/);
        if (agentRollbackMatch && request.method === "POST") {
          const agentId = decodeURIComponent(agentRollbackMatch[1]!);
          if (!isKnownAgent(agentId)) return json({ error: "Unknown agent" }, 404, cors);
          const body: unknown = await request.json().catch(() => null);
          const b = (body ?? {}) as Record<string, unknown>;
          const historyId = typeof b["history_id"] === "number" ? b["history_id"] : (typeof b["id"] === "number" ? b["id"] : null);
          if (historyId === null) return json({ error: "history_id is required" }, 422, cors);
          const rolled = rollbackTo(db, agentId, historyId);
          if (!rolled) return json({ error: "History entry not found" }, 404, cors);
          return json(buildAgentDetail(db, agentId), 200, cors);
        }
      }
      {
        const agentTestMatch = url.pathname.match(/^\/agents\/([^/]+)\/test$/);
        if (agentTestMatch && request.method === "POST") {
          const agentId = decodeURIComponent(agentTestMatch[1]!);
          if (!isKnownAgent(agentId)) return json({ error: "Unknown agent" }, 404, cors);
          const body: unknown = await request.json().catch(() => null);
          const b = (body ?? {}) as Record<string, unknown>;
          const query = typeof b["query"] === "string" ? b["query"] as string : "";
          if (!query.trim()) return json({ error: "query is required" }, 422, cors);
          // Stub: return a canned response
          return json({ response: `[stub] ${agentId} response to: ${query.slice(0, 200)}` }, 200, cors);
        }
      }
      {
        const agentOverrideMatch = url.pathname.match(/^\/agents\/([^/]+)\/override$/);
        if (agentOverrideMatch) {
          const agentId = decodeURIComponent(agentOverrideMatch[1]!);
          if (!isKnownAgent(agentId)) return json({ error: "Unknown agent" }, 404, cors);
          if (request.method === "POST" || request.method === "PATCH") {
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            const patch: Record<string, unknown> & { _set?: Set<string> } = {};
            const set = new Set<string>();
            for (const k of ["prompt", "model", "use_deep_reasoning", "role", "voice_persona_slug", "research_focus"]) {
              if (k in b) { patch[k] = b[k]; set.add(k); }
            }
            // Alias: use_deep_reasoning vs deep_reasoning
            if ("deep_reasoning" in b && !("use_deep_reasoning" in b)) { patch["use_deep_reasoning"] = b["deep_reasoning"]; set.add("use_deep_reasoning"); }
            patch._set = set;
            if (patch["model"] !== undefined && patch["model"] !== null && typeof patch["model"] === "string" && !(patch["model"] as string).trim()) {
              return json({ error: "model must be non-empty" }, 422, cors);
            }
            setOverride(db, agentId, patch as Parameters<typeof setOverride>[2]);
            return json(buildAgentDetail(db, agentId), 200, cors);
          }
          if (request.method === "DELETE") {
            clearOverride(db, agentId);
            return new Response(null, { status: 204, headers: cors });
          }
        }
      }
      {
        const agentMatch = url.pathname.match(/^\/agents\/([^/]+)$/);
        if (agentMatch && request.method === "GET") {
          const agentId = decodeURIComponent(agentMatch[1]!);
          if (!isKnownAgent(agentId)) return json({ error: "Unknown agent" }, 404, cors);
          return json(buildAgentDetail(db, agentId), 200, cors);
        }
      }

      // ── personas ────────────────────────────────────────────────────
      if (url.pathname === "/personas" && request.method === "GET") {
        return json(listPersonas(db), 200, cors);
      }
      if (url.pathname === "/personas" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const displayName = typeof b["display_name"] === "string" ? (b["display_name"] as string).trim() : "";
        const personaBody = typeof b["body"] === "string" ? b["body"] as string : "";
        if (!displayName) return json({ error: "display_name must not be empty" }, 400, cors);
        if (!personaBody.trim()) return json({ error: "body must not be empty" }, 400, cors);
        const created = createPersona(db, displayName, personaBody);
        return json(created, 201, cors);
      }
      {
        const personaResetMatch = url.pathname.match(/^\/personas\/([^/]+)\/reset$/);
        if (personaResetMatch && request.method === "POST") {
          const slug = decodeURIComponent(personaResetMatch[1]!);
          const reset = resetPersona(db, slug);
          if (!reset) return json({ error: `Persona ${JSON.stringify(slug)} has no built-in to reset to` }, 400, cors);
          return json(reset, 200, cors);
        }
      }
      {
        const personaMatch = url.pathname.match(/^\/personas\/([^/]+)$/);
        if (personaMatch) {
          const slug = decodeURIComponent(personaMatch[1]!);
          if (request.method === "GET") {
            const persona = getPersona(db, slug);
            if (!persona) return json({ error: `Persona ${JSON.stringify(slug)} not found` }, 404, cors);
            return json(persona, 200, cors);
          }
          if (request.method === "PUT") {
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            const displayName = typeof b["display_name"] === "string" ? (b["display_name"] as string).trim() : "";
            const personaBody = typeof b["body"] === "string" ? b["body"] as string : "";
            if (!displayName) return json({ error: "display_name must not be empty" }, 400, cors);
            if (!personaBody.trim()) return json({ error: "body must not be empty" }, 400, cors);
            const updated = upsertPersona(db, slug, displayName, personaBody);
            return json(updated, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!personaExists(db, slug)) return json({ error: `Persona ${JSON.stringify(slug)} not found` }, 404, cors);
            if (isBuiltin(slug)) return json({ error: `Persona ${JSON.stringify(slug)} is a built-in and cannot be deleted. Use /reset to restore it.` }, 400, cors);
            deletePersona(db, slug);
            return new Response(null, { status: 204, headers: cors });
          }
        }
      }

      // ── skills ──────────────────────────────────────────────────────
      if (url.pathname === "/skills/search" && request.method === "GET") {
        const q = url.searchParams.get("q");
        if (!q || !q.trim()) return json({ error: "q is required" }, 400, cors);
        const nRaw = url.searchParams.get("n");
        const n = nRaw ? Math.max(1, Math.min(Number(nRaw) || 5, 20)) : 5;
        const hits = searchSkills(db, q, n);
        return json({ results: hits.map((h) => ({ ...h, distance: h.score })) }, 200, cors);
      }
      if (url.pathname === "/skills" && request.method === "GET") {
        const skills = listSkills(db);
        return json({ skills }, 200, cors);
      }
      {
        const skillMatch = url.pathname.match(/^\/skills\/([^/]+)$/);
        if (skillMatch && request.method === "GET") {
          const name = decodeURIComponent(skillMatch[1]!);
          // Avoid capturing "search" which is handled above
          if (name !== "search") {
            const skill = getSkill(db, name);
            if (!skill) return json({ error: `Skill '${name}' not found` }, 404, cors);
            return json(skill, 200, cors);
          }
        }
      }

      // ── evals ───────────────────────────────────────────────────────
      if (url.pathname === "/evals/scenarios" && request.method === "GET") {
        const scenarios = listScenarioMeta(db);
        const byKind: Record<string, unknown[]> = {};
        for (const s of scenarios) {
          const kind = (s["kind"] as string) ?? "chat";
          if (!byKind[kind]) byKind[kind] = [];
          byKind[kind]!.push(s);
        }
        return json({ scenarios, by_kind: byKind, total: scenarios.length }, 200, cors);
      }
      if (url.pathname === "/evals/scenarios" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const yaml = typeof b["yaml"] === "string" ? b["yaml"] as string : null;
        if (!yaml) return json({ error: "`yaml` field is required" }, 400, cors);
        let parsed: { id: string; kind: string };
        try { parsed = validateScenarioYaml(yaml); } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 422, cors); }
        if (getUserScenario(db, parsed.id)) return json({ error: `User scenario id ${JSON.stringify(parsed.id)} already exists` }, 409, cors);
        createUserScenario(db, parsed.id, parsed.kind, yaml);
        return json({ id: parsed.id, kind: parsed.kind, is_builtin: false }, 200, cors);
      }
      {
        const evalScenarioMatch = url.pathname.match(/^\/evals\/scenarios\/([^/]+)$/);
        if (evalScenarioMatch) {
          const sid = decodeURIComponent(evalScenarioMatch[1]!);
          if (request.method === "GET") {
            const row = getUserScenario(db, sid);
            if (!row) return json({ error: `Scenario ${sid} not found` }, 404, cors);
            return json({ id: sid, kind: row["kind"], yaml: row["yaml"], is_builtin: false }, 200, cors);
          }
          if (request.method === "PATCH") {
            const body: unknown = await request.json().catch(() => null);
            const b = (body ?? {}) as Record<string, unknown>;
            const yaml = typeof b["yaml"] === "string" ? b["yaml"] as string : null;
            if (!yaml) return json({ error: "`yaml` field is required" }, 400, cors);
            let parsed: { id: string; kind: string };
            try { parsed = validateScenarioYaml(yaml); } catch (e) { return json({ error: e instanceof Error ? e.message : String(e) }, 422, cors); }
            if (parsed.id !== sid) return json({ error: `YAML \`id\` (${JSON.stringify(parsed.id)}) does not match URL id (${JSON.stringify(sid)}). To rename, delete and recreate.` }, 422, cors);
            if (!updateUserScenario(db, sid, parsed.kind, yaml)) return json({ error: `Scenario ${sid} not found` }, 404, cors);
            return json({ id: sid, kind: parsed.kind, is_builtin: false }, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!deleteUserScenario(db, sid)) return json({ error: `Scenario ${sid} not found` }, 404, cors);
            return json({ status: "deleted", id: sid }, 200, cors);
          }
        }
      }
      if (url.pathname === "/evals/runs" && request.method === "GET") {
        const kind = url.searchParams.get("kind") ?? undefined;
        const limitRaw = url.searchParams.get("limit");
        const limit = limitRaw ? Number(limitRaw) : 100;
        return json({ runs: listEvalRuns(db, kind, limit) }, 200, cors);
      }
      if (url.pathname === "/evals/runs" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const kind = typeof b["kind"] === "string" ? b["kind"] as string : "chat";
        if (!EVAL_KINDS.includes(kind as typeof EVAL_KINDS[number])) return json({ error: `kind must be one of: ${[...EVAL_KINDS].join(", ")}` }, 422, cors);
        const runId = crypto.randomUUID().replace(/-/g, "");
        const scenarioIds: string[] = typeof b["scenario_id"] === "string" ? [b["scenario_id"] as string] : [];
        createEvalRun(db, runId, kind, scenarioIds);
        // Leave as running — caller can cancel or poll. No immediate complete
        // (otherwise POST /evals/runs/{id}/cancel is dead code).
        const run = getEvalRun(db, runId);
        return json(run, 201, cors);
      }
      {
        const evalCancelMatch = url.pathname.match(/^\/evals\/runs\/([^/]+)\/cancel$/);
        if (evalCancelMatch && request.method === "POST") {
          const runId = decodeURIComponent(evalCancelMatch[1]!);
          const run = getEvalRun(db, runId);
          if (!run) return json({ error: `Eval run ${runId} not found` }, 404, cors);
          if (run.status !== "running") return json({ error: `Eval run ${runId} is ${run.status} and cannot be canceled` }, 409, cors);
          cancelEvalRun(db, runId);
          return json({ status: "canceling", run_id: runId }, 200, cors);
        }
      }
      {
        const evalRunMatch = url.pathname.match(/^\/evals\/runs\/([^/]+)$/);
        if (evalRunMatch) {
          const runId = decodeURIComponent(evalRunMatch[1]!);
          if (request.method === "GET") {
            const run = getEvalRun(db, runId);
            if (!run) return json({ error: `Eval run ${runId} not found` }, 404, cors);
            // Parse JSON fields for response
            let results: unknown = [];
            let scenarioIds: unknown = [];
            try { results = JSON.parse((run.results as string) ?? "[]"); } catch { results = []; }
            try { scenarioIds = JSON.parse((run.scenario_ids as string) ?? "[]"); } catch { scenarioIds = []; }
            return json({ ...run, results, scenario_ids: scenarioIds }, 200, cors);
          }
          if (request.method === "DELETE") {
            if (!deleteEvalRun(db, runId)) return json({ error: `Eval run ${runId} not found` }, 404, cors);
            return json({ status: "deleted", run_id: runId }, 200, cors);
          }
        }
      }

      // ── architecture ────────────────────────────────────────────────
      if (url.pathname === "/architecture/sections" && request.method === "GET") {
        const available = listArchPrebuilt();
        const sections = ARCH_SECTIONS.map((spec) => {
          const content = available.get(spec.id);
          return {
            id: spec.id,
            title: spec.title,
            sub: spec.sub,
            wants_mermaid: spec.wants_mermaid,
            diagram_kind: spec.diagram_kind,
            generated_at: (content?.["generated_at"] as string | undefined) ?? null,
            fresh: content !== undefined,
          };
        });
        return json({ sections }, 200, cors);
      }
      {
        const archMatch = url.pathname.match(/^\/architecture\/sections\/([^/]+)$/);
        if (archMatch && request.method === "GET") {
          const id = decodeURIComponent(archMatch[1]!);
          const spec = getArchSection(id);
          if (!spec) return json({ error: `Unknown section: ${id}` }, 404, cors);
          const content = getArchPrebuilt(id);
          if (!content) return json({ error: `No pre-authored content for section: ${id}` }, 404, cors);
          return json(content, 200, cors);
        }
      }

      // ── guide ───────────────────────────────────────────────────────
      if (url.pathname === "/guide/sections" && request.method === "GET") {
        const available = listGuidePrebuilt();
        const sections = GUIDE_SECTIONS.map((spec) => {
          const content = available.get(spec.id);
          return {
            id: spec.id,
            title: spec.title,
            sub: spec.sub,
            generated_at: (content?.["generated_at"] as string | undefined) ?? null,
            fresh: content !== undefined,
          };
        });
        return json({ sections }, 200, cors);
      }
      {
        const guideMatch = url.pathname.match(/^\/guide\/sections\/([^/]+)$/);
        if (guideMatch && request.method === "GET") {
          const id = decodeURIComponent(guideMatch[1]!);
          const spec = getGuideSection(id);
          if (!spec) return json({ error: `Unknown section: ${id}` }, 404, cors);
          const content = getGuidePrebuilt(id);
          if (!content) return json({ error: `No pre-authored content for section: ${id}` }, 404, cors);
          return json(content, 200, cors);
        }
      }

      // ── fixtures ────────────────────────────────────────────────────
      if (url.pathname === "/fixtures" && request.method === "GET") {
        return json({ fixtures: listAllFixtures(db) }, 200, cors);
      }
      if (url.pathname === "/fixtures/status" && request.method === "GET") {
        return json(getFixtureStatus(db), 200, cors);
      }
      if (url.pathname === "/fixtures/snapshot" && request.method === "POST") {
        return json(await snapshotUserState(db), 200, cors);
      }
      if (url.pathname === "/fixtures/reset" && request.method === "POST") {
        return json(resetAllState(db), 200, cors);
      }
      if (url.pathname === "/fixtures/unload" && request.method === "POST") {
        return json(unloadFixture(db), 200, cors);
      }
      {
        const fixtureUnloadMatch = url.pathname.match(/^\/fixtures\/([^/]+)\/unload$/);
        if (fixtureUnloadMatch && request.method === "POST") {
          const name = decodeURIComponent(fixtureUnloadMatch[1]!);
          if (!/^[a-z0-9_-]+$/.test(name)) return json({ error: "Invalid fixture name" }, 400, cors);
          if (!fixtureExists(db, name)) return json({ error: `Fixture ${name} not found` }, 404, cors);
          return json(unloadFixture(db), 200, cors);
        }
      }
      if (url.pathname === "/fixtures/generate" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const description = typeof b["description"] === "string" ? (b["description"] as string).trim() : "";
        if (!description) return json({ error: "description is required" }, 400, cors);
        const suggested = deriveFixtureSlug(description.slice(0, 40), (name) => fixtureExists(db, name));
        return json({ suggested_name: suggested, display_name: description.slice(0, 80), bundle: { profile: { name: description.slice(0, 80) }, docs: [] } }, 200, cors);
      }
      if (url.pathname === "/fixtures" && request.method === "POST") {
        const body: unknown = await request.json().catch(() => null);
        const b = (body ?? {}) as Record<string, unknown>;
        const bundle = b["bundle"] as Record<string, unknown> | undefined;
        if (!bundle) return json({ error: "bundle is required" }, 422, cors);
        const profile = bundle["profile"] as Record<string, unknown> | undefined;
        const name = typeof profile?.["name"] === "string" ? (profile["name"] as string).trim() : "";
        if (!name) return json({ error: "bundle.profile.name is required" }, 422, cors);
        const slug = deriveFixtureSlug(name, (n) => fixtureExists(db, n));
        const scenarioDesc = typeof b["scenario_description"] === "string" ? b["scenario_description"] as string : "";
        createGeneratedFixture(db, { name: slug, display_name: name, scenario_description: scenarioDesc });
        return json({ name: slug, display_name: name, source: "generated", doc_count: 0 }, 200, cors);
      }
      {
        const fixtureLoadMatch = url.pathname.match(/^\/fixtures\/([^/]+)\/load$/);
        if (fixtureLoadMatch && request.method === "POST") {
          const name = decodeURIComponent(fixtureLoadMatch[1]!);
          if (!/^[a-z0-9_-]+$/.test(name)) return json({ error: "Invalid fixture name" }, 400, cors);
          if (!fixtureExists(db, name)) return json({ error: `Fixture ${name} not found` }, 404, cors);
          return json(loadFixture(db, name), 200, cors);
        }
      }
      {
        const fixtureDeleteMatch = url.pathname.match(/^\/fixtures\/([^/]+)$/);
        if (fixtureDeleteMatch && request.method === "DELETE") {
          const name = decodeURIComponent(fixtureDeleteMatch[1]!);
          if (!/^[a-z0-9_-]+$/.test(name)) return json({ error: "Invalid fixture name" }, 400, cors);
          // Curated fixtures cannot be deleted — check if it's curated
          const curated = listAllFixtures(db).find((f) => f.name === name && f.source === "curated");
          if (curated) return json({ error: "Curated fixtures cannot be deleted" }, 400, cors);
          if (!deleteGeneratedFixture(db, name)) return json({ error: "Generated fixture not found" }, 404, cors);
          return json({ deleted: true, name }, 200, cors);
        }
      }
      {
        const fixtureSnapshotMatch = url.pathname.match(/^\/fixtures\/([^/]+)\/snapshot$/);
        if (fixtureSnapshotMatch && request.method === "GET") {
          const name = decodeURIComponent(fixtureSnapshotMatch[1]!);
          if (!fixtureExists(db, name)) return json({ error: `Fixture ${name} not found` }, 404, cors);
          return json({ name, snapshot: true }, 200, cors);
        }
      }
      {
        const fixtureResetMatch = url.pathname.match(/^\/fixtures\/([^/]+)\/reset$/);
        if (fixtureResetMatch && request.method === "POST") {
          const name = decodeURIComponent(fixtureResetMatch[1]!);
          if (!fixtureExists(db, name)) return json({ error: `Fixture ${name} not found` }, 404, cors);
          return json({ reset: name }, 200, cors);
        }
      }
      {
        const fixtureGenerateMatch = url.pathname.match(/^\/fixtures\/([^/]+)\/generate$/);
        if (fixtureGenerateMatch && request.method === "POST") {
          const name = decodeURIComponent(fixtureGenerateMatch[1]!);
          if (!fixtureExists(db, name)) return json({ error: `Fixture ${name} not found` }, 404, cors);
          return json({ generated: name }, 200, cors);
        }
      }

      // ── health/honcho ───────────────────────────────────────────────
      if (url.pathname === "/health/honcho" && request.method === "GET") {
        return json({ status: "disabled", base_url: "", workspace_id: "" }, 200, cors);
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
  const briefTime = settings.morningBriefTime;
  const eodTime = settings.eodDigestTime;
  const reflectionTime = settings.reflectionTime;
  seedDaily(db, PRINCIPAL_BRIEF_MORNING, briefTime);
  seedDaily(db, "principal_brief_eod", eodTime);
  seedDaily(db, "executive_reflection", reflectionTime);
  // watchlist_research_scan is daily at 08:00 (DEFAULT_MORNING_TIME) — same
  // constant used in scheduler chaining. Not tied to briefTime so an env
  // override of PRINCIPAL_BRIEF_MORNING_TIME does not shift research.
  seedDaily(db, "watchlist_research_scan", DEFAULT_MORNING_TIME);
  const scheduler = startScheduler({
    db,
    provider,
    morningTime: briefTime,
    eodTime,
    reflectionTime,
  });

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

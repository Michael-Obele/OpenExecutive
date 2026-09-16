// Remote data layer — type-safe client↔server bridge.
// `query` for reads (refresh/loading/error), `command` for button mutations,
// `form` for native HTML <form> mutations. All run server-side via backendFetch
// with the caller's identity stamped from the verified session.
//
// Per AGENTS.md: remote functions by default over +page.server.ts actions;
// TanStack Query is the client cache over these where needed.
import * as v from 'valibot';
import { command, form, query } from '$app/server';
import { getRequestEvent } from '$app/server';
import { backendFetch, backendJson } from '$lib/server/backend.js';
import type {
	ReviewItemPatch,
	ReviewPriority,
	ReviewStatus,
	WatchlistCreate,
	WatchlistPatch
} from '$lib/api.js';

function callerEmail(): string | null {
	try {
		return getRequestEvent().locals.user?.email?.toLowerCase() ?? null;
	} catch {
		return null;
	}
}

async function get<T>(path: string, search?: Record<string, string>): Promise<T> {
	const url = search ? `${path}?${new URLSearchParams(search).toString()}` : path;
	const res = await backendFetch(url, { callerEmail: callerEmail() });
	if (!res.ok) throw new Error(`Backend GET ${path} failed: ${res.statusText}`);
	return (await res.json()) as T;
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
	const res = await backendFetch(path, {
		method,
		callerEmail: callerEmail(),
		contentType: body !== undefined ? 'application/json' : undefined,
		body: body !== undefined ? JSON.stringify(body) : undefined
	});
	if (!res.ok) {
		let detail = res.statusText;
		try {
			const b = (await res.json()) as { detail?: string };
			if (b?.detail) detail = b.detail;
		} catch {
			// non-JSON
		}
		throw new Error(`Backend ${method} ${path} failed: ${detail}`);
	}
	if (res.status === 204) return undefined as T;
	const text = await res.text();
	return (text ? JSON.parse(text) : undefined) as T;
}

// ---- Health / briefing ----
export const getHealth = query(async () => get('/health'));
export const getToday = query(async () => get('/today'));
export const getSuggestedPrompts = query(async () => get('/chat/suggested-prompts'));

// ---- Sessions ----
export const listSessions = query(async () => get('/sessions'));
export const getSessionMessages = query(v.string(), async (sessionId) =>
	get(`/sessions/${encodeURIComponent(sessionId)}/messages`)
);
export const deleteSession = command(v.string(), async (sessionId) => {
	await send(`/sessions/${encodeURIComponent(sessionId)}`, 'DELETE');
	await listSessions().refresh();
});

// ---- Review ----
export const getReviewStats = query(async () => get('/review/stats'));
export const listReviewItems = query(
	v.optional(
		v.object({
			status: v.optional(v.picklist(['pending', 'approved', 'rejected', 'needs_revision'])),
			domain: v.optional(v.string()),
			content_type: v.optional(v.picklist(['builtin', 'external'])),
			limit: v.optional(v.number()),
			offset: v.optional(v.number())
		}),
		{}
	),
	async (params) => {
		const search: Record<string, string> = {};
		if (params.status) search.status = params.status;
		if (params.domain) search.domain = params.domain;
		if (params.content_type) search.content_type = params.content_type;
		if (params.limit != null) search.limit = String(params.limit);
		if (params.offset != null) search.offset = String(params.offset);
		return get('/review/items', search);
	}
);
export const patchReviewItem = command(
	v.object({ itemId: v.string(), patch: v.record(v.string(), v.unknown()) }),
	async ({ itemId, patch }) => {
		const updated = await send(`/review/items/${encodeURIComponent(itemId)}`, 'PATCH', patch);
		await listReviewItems().refresh();
		await getReviewStats().refresh();
		return updated;
	}
);

// ---- Departments ----
export const listDepartments = query(async () => get('/departments'));
export const getDepartment = query(v.string(), async (slug) =>
	get(`/departments/${encodeURIComponent(slug)}`)
);

// ---- People ----
export const listPeople = query(async () => get('/people'));
export const getPerson = query(v.string(), async (id) => get(`/people/${encodeURIComponent(id)}`));

// ---- Knowledge ----
export const listDocuments = query(async () => get('/knowledge/documents'));
export const listBuiltinFiles = query(async () => get('/knowledge/builtin'));
export const listSkills = query(async () => get('/skills'));
export const getSkill = query(v.string(), async (name) =>
	get(`/skills/${encodeURIComponent(name)}`)
);

// ---- Workflows / jobs ----
export const listWorkflows = query(async () => get('/workflows'));
export const getWorkflow = query(v.string(), async (name) =>
	get(`/workflows/${encodeURIComponent(name)}`)
);
export const listWorkflowRuns = query(async () => get('/workflows/runs'));
export const getWorkflowRun = query(v.string(), async (runId) =>
	get(`/workflows/runs/${encodeURIComponent(runId)}`)
);

// ---- Artifacts ----
export const listArtifacts = query(
	v.optional(v.object({ archived: v.optional(v.boolean()) }), {}),
	async (params) => get('/artifacts', params.archived ? { archived: 'true' } : {})
);
export const getArtifact = query(v.string(), async (id) =>
	get(`/artifacts/${encodeURIComponent(id)}`)
);

// ---- Watchlist ----
export const listWatchlist = query(async () => get('/watchlist'));
export const getWatchlistItem = query(v.string(), async (slug) =>
	get(`/watchlist/${encodeURIComponent(slug)}`)
);

// ---- Talent ----
export const listCandidates = query(async () => get('/talent/candidates'));
export const listEngagements = query(async () => get('/talent/engagements'));
export const getCandidate = query(v.string(), async (id) =>
	get(`/talent/candidates/${encodeURIComponent(id)}`)
);
export const getEngagement = query(v.string(), async (id) =>
	get(`/talent/engagements/${encodeURIComponent(id)}`)
);

// ---- Clients ----
export const listClients = query(async () => get('/clients'));
export const getClientsCockpit = query(async () => get('/clients/cockpit'));

// ---- Onboarding (staff) ----
export const listOnboardingPlans = query(async () => get('/onboarding/plans'));
export const getOnboardingPlan = query(v.number(), async (id) => get(`/onboarding/plans/${id}`));

// ---- Audit ----
export const getActivity = query(v.optional(v.number(), 20), async (limit) =>
	get('/activity', { limit: String(limit) })
);

// ---- Company profile ----
export const getCompanyProfile = query(async () => get('/company/profile'));

// ---- Architecture / guide (static backend content) ----
export const listArchitectureSections = query(async () => get('/architecture/sections'));
export const getArchitectureSection = query(v.string(), async (id) =>
	get(`/architecture/sections/${encodeURIComponent(id)}`)
);

// ---- Mutations via native HTML forms (remote `form`) ----
// Company profile edit — PATCH /company/profile with partial fields.
export const updateCompanyProfile = form(
	v.object({
		name: v.optional(v.string()),
		mission: v.optional(v.string()),
		vision: v.optional(v.string()),
		values: v.optional(v.string()),
		industry: v.optional(v.string()),
		size: v.optional(v.string())
	}),
	async (data) => {
		const updated = await send('/company/profile', 'PATCH', data);
		await getCompanyProfile().refresh();
		await getToday().refresh();
		return updated;
	}
);

// Alert ack from the briefing — POST /today/ack.
export const ackAlert = form(v.object({ alert_id: v.number() }), async ({ alert_id }) => {
	await send('/today/ack', 'POST', { alert_id });
	await getToday().refresh();
});

// Watchlist create — POST /watchlist.
export const createWatchlistItem = form(
	v.object({
		name: v.pipe(v.string(), v.minLength(1)),
		source_type: v.string(),
		source_config: v.optional(v.string()),
		cadence: v.optional(v.string()),
		severity: v.optional(v.string())
	}),
	async (data) => {
		const created = await send('/watchlist', 'POST', data);
		await listWatchlist().refresh();
		return created;
	}
);

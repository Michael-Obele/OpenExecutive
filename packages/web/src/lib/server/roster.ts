// Roster guard — ports `packages/ui/src/auth.ts` allowlist contract to Better Auth.
// Env-var fallback for bootstrap (fresh install, roster empty). Once any Person
// row exists with an email, the backend's `/auth/allowed-emails` endpoint becomes
// authoritative and this list is only consulted to admit the first operator.
import { env } from '$env/dynamic/private';

const BACKEND_BASE = env.BACKEND_BASE_URL ?? 'http://localhost:8000';
const BACKEND_SHARED_SECRET = env.BACKEND_SHARED_SECRET ?? '';

const ALLOWED_EMAILS_FALLBACK: ReadonlySet<string> = new Set(
	(env.ALLOWED_EMAILS ?? '')
		.split(',')
		.map((e) => e.trim().toLowerCase())
		.filter((e) => e.length > 0)
);

// 5-minute cache. Cheap insurance against hammering the backend on every
// sign-in attempt. Module-level cache is per-server-instance.
const ROSTER_TTL_MS = 5 * 60 * 1000;
let rosterCache: { fetchedAt: number; emails: Set<string> } | null = null;

export async function fetchRosterEmails(): Promise<Set<string> | null> {
	const now = Date.now();
	if (rosterCache && now - rosterCache.fetchedAt < ROSTER_TTL_MS) {
		return rosterCache.emails;
	}
	try {
		const headers: Record<string, string> = {};
		if (BACKEND_SHARED_SECRET) headers['x-api-key'] = BACKEND_SHARED_SECRET;
		const res = await fetch(`${BACKEND_BASE}/auth/allowed-emails`, {
			headers,
			cache: 'no-store'
		});
		if (!res.ok) {
			console.warn(
				`[auth] roster fetch failed (HTTP ${res.status}); falling back to ALLOWED_EMAILS env`
			);
			return null;
		}
		const rows = (await res.json()) as Array<{ email: string; person_id: number }>;
		const emails = new Set(rows.map((r) => r.email.toLowerCase()));
		rosterCache = { fetchedAt: now, emails };
		return emails;
	} catch (err) {
		console.warn(`[auth] roster fetch error; falling back to ALLOWED_EMAILS env: ${String(err)}`);
		return null;
	}
}

/**
 * Resolve whether an email is permitted by the current allowlist regime.
 * Returns `{ allowed, source }` where source is one of:
 *  - `roster` — People table populated and authoritative; matched.
 *  - `env_empty_roster` — roster has no email-bearing rows yet; env fallback used.
 *  - `env_after_fetch_error` — backend fetch failed; env fallback used.
 */
export async function checkEmailAllowed(
	email: string
): Promise<{ allowed: boolean; source: string }> {
	const roster = await fetchRosterEmails();
	if (roster && roster.size > 0) {
		return { allowed: roster.has(email.toLowerCase()), source: 'roster' };
	}
	return {
		allowed: ALLOWED_EMAILS_FALLBACK.has(email.toLowerCase()),
		source: roster === null ? 'env_after_fetch_error' : 'env_empty_roster'
	};
}

// Fire-and-forget audit call to the backend. Never awaited — auth must never
// block or expose errors due to audit failures.
export function auditAuth(
	event_type: string,
	summary: string,
	actor: string | null,
	details: Record<string, unknown>
): void {
	const headers: Record<string, string> = { 'content-type': 'application/json' };
	if (BACKEND_SHARED_SECRET) headers['x-api-key'] = BACKEND_SHARED_SECRET;
	fetch(`${BACKEND_BASE}/audit/log`, {
		method: 'POST',
		headers,
		body: JSON.stringify({ event_type, summary, actor, details })
	}).catch(() => {
		// Intentionally swallowed — audit failures must never surface to users.
	});
}

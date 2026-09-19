import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { db } from '$lib/server/db';
import { auditAuth, checkEmailAllowed } from '$lib/server/roster';

// Better Auth config — email+password (no OAuth), 24h session TTL, roster gate
// via `user.validateUserInfo` (runs on create-user for sign-up and on sign-in
// for email/password). Fail-open on roster-fetch errors at request time is
// handled in hooks.server.ts so a backend hiccup never locks out valid sessions.
export const auth = betterAuth({
	baseURL: env.ORIGIN,
	secret: env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: 'pg' }),
	session: {
		expiresIn: 24 * 60 * 60,
		updateAge: 60 * 60
	},
	emailAndPassword: { enabled: true },
	user: {
		validateUserInfo: async ({ user }) => {
			const email = typeof user.email === 'string' ? user.email.toLowerCase() : null;
			if (!email) {
				auditAuth('auth_login', 'Login denied: no email', null, {
					denied: true,
					reason: 'no_email'
				});
				return { error: 'no_email' };
			}
			// Roster check is best-effort: if the backend is unreachable (e.g. dev
			// without API running), fall back to ALLOWED_EMAILS env. When that env
			// is empty, allow the sign-up/sign-in so the first user can bootstrap.
			// The hooks.server.ts guard re-checks on every request once the backend
			// is back, so this fail-open only affects the initial auth moment.
			let allowed = true;
			let source = 'bootstrap';
			try {
				const result = await checkEmailAllowed(email);
				allowed = result.allowed;
				source = result.source;
			} catch {
				// checkEmailAllowed already returns null on fetch failure, but guard
				// against any unexpected throw.
				allowed = true;
				source = 'bootstrap_after_error';
			}
			if (!allowed) {
				auditAuth('auth_login', `Login denied: ${email} (not in ${source})`, email, {
					denied: true,
					reason: 'not_in_allowlist',
					source
				});
				return { error: 'not_in_allowlist' };
			}
			auditAuth('auth_login', `Login: ${email}`, email, { provider: 'email', source });
		}
	},
	plugins: [
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});

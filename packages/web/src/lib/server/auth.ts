import { env } from '$env/dynamic/private';
import { betterAuth } from 'better-auth/minimal';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { sveltekitCookies } from 'better-auth/svelte-kit';
import { getRequestEvent } from '$app/server';
import { google } from 'better-auth/social-providers';
import { db } from '$lib/server/db';
import { auditAuth, checkEmailAllowed } from '$lib/server/roster';

// Better Auth config — ports `packages/ui/src/auth.ts` roster contract:
// Google OAuth only (email must be verified), 24h session TTL, roster gate
// via `user.validateUserInfo` (runs on create-user, link-account, and OAuth
// sign-in with the fresh provider email). Fail-open on roster-fetch errors
// at request time is handled in hooks.server.ts so a backend hiccup never
// locks out valid sessions — the strict gate here already vetted them once.
export const auth = betterAuth({
	baseURL: env.ORIGIN,
	secret: env.BETTER_AUTH_SECRET,
	database: drizzleAdapter(db, { provider: 'pg' }),
	session: {
		expiresIn: 24 * 60 * 60,
		updateAge: 60 * 60
	},
	socialProviders: {
		google: {
			clientId: env.AUTH_GOOGLE_ID ?? '',
			clientSecret: env.AUTH_GOOGLE_SECRET ?? ''
		}
	},
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
			const { allowed, source } = await checkEmailAllowed(email);
			if (!allowed) {
				auditAuth('auth_login', `Login denied: ${email} (not in ${source})`, email, {
					denied: true,
					reason: 'not_in_allowlist',
					source
				});
				return { error: 'not_in_allowlist' };
			}
			auditAuth('auth_login', `Login: ${email}`, email, { provider: 'google', source });
		}
	},
	plugins: [
		sveltekitCookies(getRequestEvent) // make sure this is the last plugin in the array
	]
});

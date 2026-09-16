import { sequence } from '@sveltejs/kit/hooks';
import type { Handle } from '@sveltejs/kit';
import { building } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/server/auth';
import { svelteKitHandler } from 'better-auth/svelte-kit';
import { auditAuth, checkEmailAllowed } from '$lib/server/roster';

// Ports `packages/ui/src/middleware.ts`: gate every page + non-auth API route.
// Unauthenticated traffic redirects to /signin (pages) or 401s (API routes).
// Re-checks the roster on every gated request so a user removed mid-session
// is bounced on next request. Fail-open on roster-fetch errors so a brief
// backend hiccup doesn't lock out valid sessions.
const handleGuard: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	const isAuthPath = path.startsWith('/api/auth') || path === '/signin' || path === '/signin/';
	const isStatic =
		path.startsWith('/_app/') ||
		path === '/favicon.ico' ||
		(path.includes('.') && !path.startsWith('/api/'));
	if (!isAuthPath && !isStatic && !building) {
		const session = await auth.api.getSession({ headers: event.request.headers });
		const email = session?.user?.email?.toLowerCase() ?? null;
		if (!email) {
			if (path.startsWith('/api/')) {
				return Response.json({ error: 'unauthorized' }, { status: 401 });
			}
			const dest = event.url.pathname + event.url.search;
			throw redirect(302, `/signin?callbackUrl=${encodeURIComponent(dest)}`);
		}
		const { allowed, source } = await checkEmailAllowed(email);
		if (source === 'env_after_fetch_error') {
			// fail-open — strict gate at sign-in already vetted them
		} else if (!allowed) {
			auditAuth('auth_logout', `Session revoked: ${email} (not in ${source})`, email, {
				revoked: true,
				reason: 'not_in_allowlist',
				source
			});
			if (path.startsWith('/api/')) {
				return Response.json({ error: 'unauthorized' }, { status: 401 });
			}
			throw redirect(302, '/signin?error=AccessDenied');
		}
		event.locals.session = session?.session;
		event.locals.user = session?.user;
	}
	return resolve(event);
};

const handleBetterAuth: Handle = async ({ event, resolve }) => {
	const session = await auth.api.getSession({ headers: event.request.headers });

	if (session) {
		event.locals.session = session.session;
		event.locals.user = session.user;
	}

	return svelteKitHandler({ event, resolve, auth, building });
};

export const handle: Handle = sequence(handleGuard, handleBetterAuth);

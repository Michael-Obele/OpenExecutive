// Auth remote forms — email+password via Better Auth.
// Runs server-side (has access to `auth` + `getRequestEvent` for cookies).
// Per AGENTS.md: native HTML <form> + remote `form` functions, Valibot validation.
import * as v from 'valibot';
import { form } from '$app/server';
import { redirect } from '@sveltejs/kit';
import { getRequestEvent } from '$app/server';
import { auth } from '$lib/server/auth.js';

function safeCallbackUrl(raw: string | undefined): string {
	if (!raw) return '/';
	if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
	return raw;
}

export const signIn = form(
	v.object({
		email: v.pipe(v.string(), v.email('Enter a valid email')),
		_password: v.pipe(v.string(), v.minLength(1, 'Password is required')),
		callbackUrl: v.optional(v.string(), '/')
	}),
	async ({ email, _password, callbackUrl }, issue) => {
		const headers = getRequestEvent().request.headers;
		try {
			await auth.api.signInEmail({
				body: { email: email.trim(), password: _password },
				headers,
				asResponse: false
			});
		} catch (err: unknown) {
			// Better Auth throws APIError with body.message; fall back to generic.
			const apiMessage =
				(err as { body?: { message?: string } })?.body?.message ??
				(err instanceof Error && err.message ? err.message : null);
			const message = apiMessage ?? 'Invalid email or password.';
			// Surface as a form-level issue so it shows via allIssues().
			const { invalid } = await import('@sveltejs/kit');
			invalid(issue.email(message));
		}
		redirect(303, safeCallbackUrl(callbackUrl));
	}
);

export const signUp = form(
	v.object({
		name: v.pipe(v.string(), v.minLength(1, 'Name is required')),
		email: v.pipe(v.string(), v.email('Enter a valid email')),
		_password: v.pipe(v.string(), v.minLength(8, 'Password must be at least 8 characters')),
		callbackUrl: v.optional(v.string(), '/')
	}),
	async ({ name, email, _password, callbackUrl }, issue) => {
		const headers = getRequestEvent().request.headers;
		try {
			await auth.api.signUpEmail({
				body: { name: name.trim(), email: email.trim(), password: _password },
				headers,
				asResponse: false
			});
		} catch (err: unknown) {
			const apiMessage =
				(err as { body?: { message?: string } })?.body?.message ??
				(err instanceof Error && err.message ? err.message : null);
			const message = apiMessage ?? 'Sign-up failed.';
			const { invalid } = await import('@sveltejs/kit');
			invalid(issue.email(message));
		}
		redirect(303, safeCallbackUrl(callbackUrl));
	}
);

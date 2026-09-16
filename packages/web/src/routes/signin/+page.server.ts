import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';

function safeCallbackUrl(raw: string | null): string {
	if (!raw) return '/';
	if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
	return raw;
}

export const load: PageServerLoad = async ({ url, locals }) => {
	if (locals.user) {
		throw redirect(302, safeCallbackUrl(url.searchParams.get('callbackUrl')));
	}
	return {
		callbackUrl: safeCallbackUrl(url.searchParams.get('callbackUrl')),
		error: url.searchParams.get('error')
	};
};

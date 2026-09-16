import { drizzle } from 'drizzle-orm/neon-http';
import { neon } from '@neondatabase/serverless';
import * as schema from './schema';
import { env } from '$env/dynamic/private';

function getDb() {
	const url = env.DATABASE_URL;
	if (!url) throw new Error('DATABASE_URL is not set');
	return drizzle(neon(url), { schema });
}

// Lazy — don't connect at import time so `vite build` prerender doesn't need a live DB.
export const db: ReturnType<typeof getDb> = new Proxy({} as ReturnType<typeof getDb>, {
	get(_target, prop) {
		const real = getDb();
		const value = (real as unknown as Record<string, unknown>)[prop as string];
		return typeof value === 'function'
			? (value as (...args: unknown[]) => unknown).bind(real)
			: value;
	}
});

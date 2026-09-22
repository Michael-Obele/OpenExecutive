/**
 * Health + briefing remote functions.
 *
 * Demonstrates the `query` flavor: read-only, server-side, with
 * `refresh()` / `loading` / `error` on the client. All calls go through
 * `durbarFetch` so the dashboard never assumes same-origin — `DURBAR_PUBLIC_URL`
 * is the only difference between local and split deployments.
 */
import { query } from '$app/server';
import { durbarJson } from '$lib/server/durbar.js';

export interface HealthStatus {
	status: string;
	provider: string;
	model: string;
}

export interface TodayBrief {
	brief?: unknown;
	activity?: unknown;
	[key: string]: unknown;
}

export const getHealth = query(async (): Promise<HealthStatus> => {
	return durbarJson<HealthStatus>('/health');
});

export const getToday = query(async (): Promise<TodayBrief> => {
	return durbarJson<TodayBrief>('/today');
});

export const getActivity = query(async (): Promise<unknown> => {
	return durbarJson<unknown>('/today/activity');
});

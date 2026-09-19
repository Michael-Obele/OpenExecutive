// Shared constants and pure helpers for the department detail page and its
// Goal sub-components. Ported from
// `packages/ui/src/app/departments/[slug]/page.tsx`.
import type { DepartmentConfig, Goal } from '$lib/api.js';

export const STATUS_OPTS = ['on_track', 'at_risk', 'off_track'] as const;
export type GoalStatus = (typeof STATUS_OPTS)[number];

export const STATUS_COLORS: Record<string, string> = {
	on_track: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
	at_risk: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
	off_track: 'bg-rose-500/20 text-rose-300 border-rose-500/30'
};

export const AUTHORITY_OPTS: DepartmentConfig['authority_level'][] = [
	'auto_execute',
	'propose_only',
	'escalate'
];

export const AUTHORITY_META: Record<
	DepartmentConfig['authority_level'],
	{ label: string; hint: string }
> = {
	auto_execute: {
		label: 'Acts on its own',
		hint: "The specialist runs actions in its scope without asking. You'll see them in the audit log."
	},
	propose_only: {
		label: 'Proposes, you approve',
		hint: 'The specialist drafts actions and routes them to a person for approval before anything happens.'
	},
	escalate: {
		label: 'Escalates to a human',
		hint: 'The specialist will not act — it forwards everything to a human.'
	}
};

// "Last reviewed >N days ago" → render the row with a stale accent.
// Healthy departments have `daily@09:00` so nothing should ever exceed 1d;
// 7d catches departments that drift well past their cadence.
const STALE_REVIEW_DAYS = 7;
const STALE_REVIEW_MS = STALE_REVIEW_DAYS * 24 * 60 * 60 * 1000;

export function isStaleReview(lastReviewedAt: string): boolean {
	if (!lastReviewedAt) return false; // "Never reviewed" rendered separately
	const ts = new Date(lastReviewedAt).getTime();
	if (!Number.isFinite(ts)) return false;
	return Date.now() - ts > STALE_REVIEW_MS;
}

export function formatPeriodLabel(g: Goal): string {
	if (g.period_type === 'ongoing') return g.period_value || 'Ongoing';
	return `${g.period_type.charAt(0).toUpperCase() + g.period_type.slice(1)}: ${g.period_value}`;
}

export function cls(...parts: (string | false | undefined)[]): string {
	return parts.filter(Boolean).join(' ');
}

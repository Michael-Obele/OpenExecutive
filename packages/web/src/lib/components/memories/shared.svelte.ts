// Shared helpers for the Pulse page (memory + cadence). Ported from
// `packages/ui/src/components/memories/shared.tsx`, minus the presentational
// primitives — a plain module cannot render markup, so StatTile / LivePulse /
// Tag / SectionHeading / Skeleton / EmptyState are re-declared as snippets in
// each consuming component. What stays here: domain/format helpers, the
// scheduled-action "rhythm" taxonomy (used by both the header stat strip and
// CadenceSection), and the colour maps those snippets share.

import type { ScheduledAction } from '$lib/api.js';

export const DOMAINS = [
	'strategy',
	'finance',
	'hr',
	'legal',
	'operations',
	'marketing',
	'product',
	'board',
	'general'
];

export const STATUSES = ['active', 'paused', 'completed', 'planned'];

/** ISO timestamp → YYYY-MM-DD. */
export function formatDate(iso: string): string {
	return iso.slice(0, 10);
}

/** ISO timestamp → an absolute string plus a coarse relative label ("in 5m", "3d ago"). */
export function formatRunAt(iso: string): { absolute: string; relative: string } {
	const d = new Date(iso);
	if (Number.isNaN(d.getTime())) return { absolute: iso, relative: '' };
	const absolute = d.toLocaleString();
	const deltaMs = d.getTime() - Date.now();
	const abs = Math.abs(deltaMs);
	const mins = Math.round(abs / 60_000);
	const hours = Math.round(abs / 3_600_000);
	const days = Math.round(abs / 86_400_000);
	let unit: string;
	if (mins < 60) unit = `${mins}m`;
	else if (hours < 48) unit = `${hours}h`;
	else unit = `${days}d`;
	const relative = deltaMs >= 0 ? `in ${unit}` : `${unit} ago`;
	return { absolute, relative };
}

export const STATUS_PILL: Record<string, string> = {
	pending: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
	running: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
	done: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
	failed: 'bg-red-500/15 text-red-300 border-red-500/30',
	cancelled: 'bg-surface-input/40 text-fg-muted border-line-strong/40'
};

// ---------------------------------------------------------------------------
// Rhythm taxonomy — turns raw scheduled_actions `kind` strings into the human
// rhythm groups shown on the Pulse page. Shared by PulseHeader (counts) and
// CadenceSection (cards). `ad_hoc` is intentionally absent from the groups: the
// Follow-ups block owns it (its own status filter + cancel).
// ---------------------------------------------------------------------------

export type RhythmGroup = 'daily' | 'departments' | 'awaiting' | 'system';

export interface KindMeta {
	label: string;
	group: RhythmGroup;
	blurb?: string;
}

export const KIND_META: Record<string, KindMeta> = {
	principal_brief_morning: {
		label: 'Morning brief',
		group: 'daily',
		blurb: 'Whole-company state, sent to you each morning.'
	},
	executive_reflection: {
		label: 'Executive reflection',
		group: 'daily',
		blurb: 'Decides what to act on, just before the morning brief.'
	},
	principal_brief_eod: {
		label: 'End-of-day digest',
		group: 'daily',
		blurb: "What landed today and what's still open."
	},
	dept_cadence: { label: 'Check-in', group: 'departments' },
	awaiting_human: { label: 'Awaiting a human reply', group: 'awaiting' },
	proactive_nudge: { label: 'Nudge', group: 'awaiting' },
	nudge_scan: {
		label: 'Nudge scan',
		group: 'system',
		blurb: 'Chases stalled commitments and idle initiatives.'
	},
	external_monitor_scan: {
		label: 'External monitor',
		group: 'system',
		blurb: 'Watches the watch list for material signals.'
	},
	watchlist_research_scan: {
		label: 'Watchlist research',
		group: 'system',
		blurb: 'Periodic research pass over your watch list.'
	}
};

export function metaFor(action: ScheduledAction): KindMeta {
	const meta = KIND_META[action.kind];
	if (meta) return meta;
	// Unknown kind: keep it visible rather than dropping it. Internal-channel
	// rows are system plumbing; anything else is a pending commitment.
	return {
		label: action.kind || 'Scheduled action',
		group: action.channel === '__internal__' ? 'system' : 'awaiting'
	};
}

/** Group pending rows (excluding ad_hoc) by rhythm group, each sorted soonest-first. */
export function groupByRhythm(actions: ScheduledAction[]): Record<RhythmGroup, ScheduledAction[]> {
	const groups: Record<RhythmGroup, ScheduledAction[]> = {
		daily: [],
		departments: [],
		awaiting: [],
		system: []
	};
	for (const a of actions) {
		if (a.kind === 'ad_hoc') continue;
		groups[metaFor(a).group].push(a);
	}
	for (const key of Object.keys(groups) as RhythmGroup[]) {
		groups[key].sort((x, y) => x.run_at.localeCompare(y.run_at));
	}
	return groups;
}

// ---------------------------------------------------------------------------
// Tone maps — kept dependency-free and theme-token-driven so the snippets that
// consume them render correctly in both light and dark mode.
// ---------------------------------------------------------------------------

export type StatTone = 'default' | 'accent' | 'emerald' | 'amber';

export const STAT_VALUE_TONE: Record<StatTone, string> = {
	default: 'text-fg',
	accent: 'text-indigo-300',
	emerald: 'text-emerald-300',
	amber: 'text-amber-300'
};

export type TagTone = 'info' | 'muted';

export const TAG_TONE: Record<TagTone, string> = {
	info: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
	muted: 'bg-surface-input/40 text-fg-subtle border-line'
};

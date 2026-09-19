// Constants and pure helpers behind `Briefing.svelte`. Split out of the
// component only because the upstream React file
// (`packages/ui/src/components/Briefing.tsx`, 2,351 LOC) keeps them all in one
// module — every function here is a 1:1 port, behaviour unchanged.
import type {
	OnboardingBriefItem,
	PersonBriefItem,
	ProposalItem,
	TalentBriefItem
} from '$lib/api.js';

// High-volume sections render their full list inside a fixed-height scroll
// (max-h-[32rem] — like the Pulse "Recent activity" card) instead of capping
// at a "Show N more" expander, so no section grows the page. Count badges
// still reflect the full totals.
// Narrative bullets kept on screen before the rest fold into "Show N more".
export const NARRATIVE_HEAD_BULLETS = 2;
// A proposal body longer than this (chars) is clamped to a few lines at rest
// with a Show more/less toggle, so the "Needs you" queue stays scannable.
export const LONG_BODY_CHARS = 180;

// "Needs you" shows this many cards after "Start here" before a Show-more
// toggle takes over — a queue, not a wall.
export const NEEDS_YOU_VISIBLE = 8;
// Bulk-dismiss cutoffs (days) offered under each lane.
export const NEEDS_YOU_DISMISS_OLDER_THAN_DAYS = 7;
export const MONITORING_DISMISS_OLDER_THAN_DAYS = 3;

// The handled rail's disclosure panel. Upstream hard-codes the id in two
// places (the toggle's `aria-controls` and the panel itself).
export const HANDLED_DETAILS_ID = 'sec-handled-details';

// `{' · '}` written literally in Svelte trips the autofixer ("mustache
// interpolation with a string literal value"), so the `" · "` separators the
// upstream file wrote inline live here as a named constant.
export const DOT_SEP = ' · ';

// Future-relative label for a pending run time ("in 8h"). Past/blank →
// "soon" (the caller renders "overdue" separately via the backend flag).
export function formatFuture(iso: string): string {
	const then = new Date(iso).getTime();
	if (Number.isNaN(then)) return 'soon';
	const mins = Math.round((then - Date.now()) / 60000);
	if (mins <= 0) return 'soon';
	if (mins < 60) return `in ${mins}m`;
	const hrs = Math.round(mins / 60);
	if (hrs < 24) return `in ${hrs}h`;
	return `in ${Math.round(hrs / 24)}d`;
}

// Compact age label ("3h", "9d") for a card chip; "" for an unparseable stamp.
export function ageLabel(iso: string | null | undefined, now: Date = new Date()): string {
	if (!iso) return '';
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return '';
	const mins = Math.max(0, Math.round((now.getTime() - t) / 60000));
	if (mins < 60) return `${mins}m`;
	const hours = Math.round(mins / 60);
	if (hours < 48) return `${hours}h`;
	return `${Math.round(hours / 24)}d`;
}

// Whole days between now and an ISO stamp: 0 = due within the day, negative =
// past (floor, so an 11-hour-old deadline is -1 → "overdue", never "due today").
// null if unparseable.
export function daysUntil(iso: string | null | undefined, now: Date = new Date()): number | null {
	if (!iso) return null;
	const t = Date.parse(iso);
	if (Number.isNaN(t)) return null;
	return Math.floor((t - now.getTime()) / 86400000);
}

// Ids of proposals older than `days` — what the bulk "Dismiss older than"
// footer sends: explicit ids from the caller's own lane (visible cards and
// those behind "Show more" alike), never a server-side age sweep, which would
// also hit teammates' routed items.
export function olderThan(
	proposals: ProposalItem[],
	days: number,
	now: Date = new Date()
): number[] {
	const cutoff = now.getTime() - days * 86400000;
	return proposals
		.filter((p) => {
			// Same age anchor as the server's TTL: a re-firing situation is not old.
			const t = Date.parse(p.last_seen_at ?? p.created_at);
			return !Number.isNaN(t) && t < cutoff;
		})
		.map((p) => p.alert_id);
}

export function formatRelTime(iso: string): string {
	try {
		const diff = new Date(iso).getTime() - Date.now();
		const abs = Math.abs(diff);
		if (abs < 60_000) return 'now';
		if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m`;
		if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h`;
		return `${Math.round(abs / 86_400_000)}d`;
	} catch {
		return '—';
	}
}

// Compact label for an authority-scope token (see people/models.py).
export const AUTHORITY_LABELS: Record<string, string> = {
	spend_lt_2k: 'spend<2k',
	spend_lt_10k: 'spend<10k',
	spend_gt_10k: 'spend>10k',
	hiring_signoff: 'hiring',
	vendor_onboarding: 'vendors',
	customer_credit: 'credit',
	legal_sign: 'legal',
	board_comms: 'board',
	wildcard: 'all'
};

export function authorityLabel(token: string): string {
	return AUTHORITY_LABELS[token] ?? token;
}

// Status chip text + colour. `overdue` repaints the attention states red.
export function personStatusChip(person: PersonBriefItem): { label: string; cls: string } | null {
	const red = 'bg-rose-500/20 text-rose-300 border-rose-500/30';
	const amber = 'bg-amber-500/20 text-amber-300 border-amber-500/30';
	const sky = 'bg-sky-500/20 text-sky-300 border-sky-500/30';
	const slate = 'bg-slate-500/20 text-slate-300 border-slate-500/30';
	switch (person.status) {
		case 'needs_reply':
			return {
				label:
					person.awaiting_reply_count > 1
						? `${person.awaiting_reply_count} awaiting reply`
						: 'Awaiting reply',
				cls: person.overdue ? red : amber
			};
		case 'awaiting':
			return {
				label: `${person.awaiting_count} to action`,
				cls: person.overdue ? red : sky
			};
		case 'on_leave':
			return { label: 'On leave', cls: slate };
		default:
			return null; // "clear" — no chip, shown as subtle text instead
	}
}

// One-line roster summary shown under the People header.
export function peopleSummary(people: PersonBriefItem[]): {
	text: string;
	hasOverdue: boolean;
} {
	const needsReply = people.filter((p) => p.status === 'needs_reply').length;
	const awaiting = people.filter((p) => p.status === 'awaiting').length;
	const onLeave = people.filter((p) => p.status === 'on_leave').length;
	const overdue = people.filter((p) => p.overdue).length;
	const parts: string[] = [];
	if (needsReply > 0) parts.push(`${needsReply} to reply`);
	if (awaiting > 0) parts.push(`${awaiting} to action`);
	if (overdue > 0) parts.push(`${overdue} overdue`);
	if (onLeave > 0) parts.push(`${onLeave} on leave`);
	return { text: parts.length > 0 ? parts.join(' · ') : 'All clear', hasOverdue: overdue > 0 };
}

export type StatTone = 'indigo' | 'rose' | 'amber' | 'sky' | 'slate';

// `targetIds` are the section element ids a pill jumps to, in priority order
// (the first one that's actually present wins). Each section now renders once
// (the responsive grid stacks instead of duplicating into a mobile block), so
// these are effectively single-element, but the list shape is kept for headroom.
export interface StatPill {
	label: string;
	tone: StatTone;
	targetIds: string[];
}

export const STAT_TONES: Record<StatTone, string> = {
	indigo: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
	rose: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
	amber: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
	sky: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
	// Quietest tone — passive monitoring signals, not something demanding action.
	slate: 'bg-slate-500/15 text-slate-300 border-slate-500/30'
};

// Section ids the status pills scroll to. Kept beside the pill builder so the
// ids and the `id={…}` attributes on the sections stay in sync.
export const SECTION_IDS = {
	needsYou: 'sec-needs-you',
	handled: 'sec-handled',
	inFlight: 'sec-in-flight',
	monitoring: 'sec-monitoring',
	departments: 'sec-departments',
	people: 'sec-people',
	talent: 'sec-talent',
	onboarding: 'sec-onboarding',
	practice: 'sec-practice'
} as const;

// Smooth-scroll to the first rendered (visible) section in `ids`, popping open
// a collapsed <details> so the pill "shows the detail". No-ops gracefully when
// none of the targets are on the page (e.g. a 1-person org has no People block).
export function scrollToFirstVisible(ids: string[]): void {
	for (const id of ids) {
		const el = document.getElementById(id);
		if (el && el.offsetParent !== null) {
			el.querySelector('details')?.setAttribute('open', '');
			el.scrollIntoView({ behavior: 'smooth', block: 'start' });
			return;
		}
	}
}

// Jump to the alert's card; when it is folded behind "Show more" (no element
// yet), land on the queue section instead of clicking dead.
export function scrollToAlertCard(alertId: number): void {
	const target =
		document.getElementById(`alert-${alertId}`) ?? document.getElementById(SECTION_IDS.needsYou);
	target?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Glanceable status pills shown under the header — a one-second read of
// what needs attention, ordered most-urgent first. Zero counts are
// dropped; an empty result renders an "All clear" pill at the call site.
export function briefingStats(args: {
	needsYou: number;
	handledOvernight: number;
	peopleOverdue: number;
	peopleNeedReply: number;
	deptAtRisk: number;
	inFlight: number;
	monitoring: number;
	searchesNeedingAttention: number;
}): StatPill[] {
	const pills: StatPill[] = [];
	const peopleTargets = [SECTION_IDS.people];
	if (args.needsYou > 0)
		pills.push({
			label: `${args.needsYou} need${args.needsYou === 1 ? 's' : ''} you`,
			tone: 'indigo',
			targetIds: [SECTION_IDS.needsYou]
		});
	// What the Executive already did on its own — shown right after the ask,
	// so the first read is "N need you, it handled M" (trust + relief).
	if (args.handledOvernight > 0)
		pills.push({
			label: `Executive handled ${args.handledOvernight} overnight`,
			tone: 'sky',
			targetIds: [SECTION_IDS.handled]
		});
	if (args.peopleOverdue > 0)
		pills.push({
			label: `${args.peopleOverdue} overdue`,
			tone: 'rose',
			targetIds: peopleTargets
		});
	if (args.peopleNeedReply > 0)
		pills.push({
			label: `${args.peopleNeedReply} awaiting reply`,
			tone: 'amber',
			targetIds: peopleTargets
		});
	if (args.deptAtRisk > 0)
		pills.push({
			label: `${args.deptAtRisk} dept${args.deptAtRisk === 1 ? '' : 's'} at risk`,
			tone: 'amber',
			targetIds: [SECTION_IDS.departments]
		});
	if (args.inFlight > 0)
		pills.push({
			label: `${args.inFlight} in flight`,
			tone: 'sky',
			targetIds: [SECTION_IDS.inFlight]
		});
	if (args.searchesNeedingAttention > 0)
		pills.push({
			label: `${args.searchesNeedingAttention} search${args.searchesNeedingAttention === 1 ? '' : 'es'} to move`,
			tone: 'indigo',
			targetIds: [SECTION_IDS.talent]
		});
	// Passive watchlist signals — quietest pill, last, so it never crowds the
	// action-oriented ones but the lane is still reachable in one click.
	if (args.monitoring > 0)
		pills.push({
			label: `${args.monitoring} monitoring`,
			tone: 'slate',
			targetIds: [SECTION_IDS.monitoring]
		});
	return pills;
}

// Seed prompt for a clicked narrative bullet. The Executive receives the
// open-alert digest as a <briefing> block on every chat turn, so the seed only
// needs to name the item — the exec matches it by headline. No alert_id is
// carried (the bullet has none); acking stays on the proposal card.
export function buildNarrativeSeed(text: string): string {
	return (
		`Let's dig into this from today's briefing:\n\n"${text}"\n\n` +
		`[Discuss mode] Walk me through what's going on, why it matters, and what ` +
		`you'd recommend. The full details are in your briefing context. Answer ` +
		`conversationally — don't take any action unless I explicitly ask.`
	);
}

// Discuss-handoff seed for a passive monitoring signal — shared by the
// ProposalCard monitoring branch and the rail's MonitoringPanel so the two
// entry points stay in sync (don't approve, just interpret the signal).
export function buildMonitoringSeed(proposal: ProposalItem): string {
	const body = proposal.body || proposal.headline;
	return (
		`Help me understand this signal we're monitoring:\n\n${body}\n\n` +
		`[Discuss mode — alert_id=${proposal.alert_id}] This is a passive ` +
		`monitoring signal, not a proposal to approve. Explain why it matters, ` +
		`whether it warrants any action, and what you'd recommend. Answer ` +
		`conversationally. Only if I explicitly ask you to act should you do ` +
		`more than advise; do not ack or dismiss the alert yourself.`
	);
}

// Seed prompt for handing a search off into chat — mirrors the proposal
// "Discuss" flow so the Executive picks up with the right engagement in mind.
export function buildTalentSeed(t: TalentBriefItem): string {
	return (
		`Let's review the ${t.role_title} search. ` +
		`Where do we stand across the pipeline, and what's the next move? ` +
		`(engagement ${t.engagement_id})`
	);
}

export function buildOnboardingSeed(o: OnboardingBriefItem): string {
	const role = o.role ? ` (${o.role})` : '';
	return `How is ${o.full_name}${role}'s onboarding going? Walk me through where their plan stands and anything overdue.`;
}

// ---------------------------------------------------------------------------
// Narrative blocks
//
// Upstream rendered the narrative with `react-markdown`, overriding `ul`/`li`
// so (a) only the first NARRATIVE_HEAD_BULLETS bullets stay on screen and the
// rest fold into a "Show N more signals" disclosure, and (b) every bullet is
// its own click target that hands the item to chat. `Markdown.svelte` renders
// sanitised HTML and cannot carry per-node behaviour, so the narrative is split
// into top-level blocks here: prose blocks go straight to `Markdown.svelte`,
// list blocks get the upstream head/tail + click-to-discuss treatment with each
// bullet's inline Markdown rendered by `Markdown.svelte`.
// ---------------------------------------------------------------------------

export type NarrativeBlock =
	{ kind: 'markdown'; text: string } | { kind: 'list'; items: string[]; raw: string };

/** First NARRATIVE_HEAD_BULLETS bullets — the ones kept on screen. */
export function narrativeHead(items: string[]): string[] {
	return items.slice(0, NARRATIVE_HEAD_BULLETS);
}

/** The bullets that fold into "Show N more signals". */
export function narrativeTail(items: string[]): string[] {
	return items.slice(NARRATIVE_HEAD_BULLETS);
}

/**
 * Split Markdown into top-level blocks, keeping list items whole (lazy wrapped
 * continuation lines are re-joined). Blank lines and non-list runs are prose.
 */
export function splitNarrative(md: string): NarrativeBlock[] {
	const blocks: NarrativeBlock[] = [];
	let paragraph: string[] = [];
	let list: string[] | null = null;

	const flushParagraph = () => {
		const text = paragraph.join('\n').trim();
		if (text) blocks.push({ kind: 'markdown', text });
		paragraph = [];
	};
	const flushList = () => {
		if (list && list.length > 0) {
			blocks.push({
				kind: 'list',
				items: list,
				// Kept so the non-interactive case (standalone /today, no
				// `onContinue`) can render the list through `Markdown.svelte`
				// exactly as upstream's default renderer did.
				raw: list.map((item) => `- ${item}`).join('\n')
			});
		}
		list = null;
	};

	for (const line of md.split('\n')) {
		const item = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
		if (item) {
			flushParagraph();
			list ??= [];
			list.push(item[1].trim());
			continue;
		}
		if (line.trim() === '') {
			flushParagraph();
			flushList();
			continue;
		}
		if (list) {
			if (/^\s+\S/.test(line)) {
				// Lazy continuation of the bullet above.
				list[list.length - 1] += ` ${line.trim()}`;
				continue;
			}
			flushList();
		}
		paragraph.push(line);
	}
	flushParagraph();
	flushList();
	return blocks;
}

/**
 * Flatten inline Markdown to plain text — the Svelte stand-in for upstream's
 * `nodeToPlainText`, which walked the react-markdown AST so a clicked bullet
 * handed the Executive one clean string (`**Headline** — text` → `Headline —
 * text`). No parsed tree exists here, so the same inline constructs are
 * stripped with the equivalent regexes.
 */
export function markdownToPlainText(text: string): string {
	return text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/\*\*([^*]+)\*\*/g, '$1')
		.replace(/\*([^*]+)\*/g, '$1')
		.replace(/(^|[\s(])_([^_]+)_(?=$|[\s.,;:!?)])/g, '$1$2')
		.trim();
}

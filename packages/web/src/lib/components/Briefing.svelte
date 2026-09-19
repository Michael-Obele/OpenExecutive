<script lang="ts">
	// Ported from `packages/ui/src/components/Briefing.tsx` (2,351 LOC).
	//
	// The upstream file holds one exported component plus a dozen internal
	// sub-components. A Svelte file holds one component, so the sub-components
	// that own no local state render as `{#snippet}`s here, with their props
	// hoisted into the snippet arguments. The two that DO own local state were
	// split into `./briefing/`: `ProposalCard.svelte` (edit draft + long-body
	// expander) and the pure helpers/constants in `./briefing/briefing.ts`.
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';

	import InfoTip from '$lib/components/InfoTip.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons.js';
	import Markdown from '$lib/components/Markdown.svelte';
	import ProposalCard from './briefing/ProposalCard.svelte';
	import {
		HANDLED_DETAILS_ID,
		MONITORING_DISMISS_OLDER_THAN_DAYS,
		NEEDS_YOU_DISMISS_OLDER_THAN_DAYS,
		NEEDS_YOU_VISIBLE,
		SECTION_IDS,
		STAT_TONES,
		ageLabel,
		authorityLabel,
		DOT_SEP,
		briefingStats,
		buildMonitoringSeed,
		buildNarrativeSeed,
		buildOnboardingSeed,
		buildTalentSeed,
		formatFuture,
		formatRelTime,
		markdownToPlainText,
		narrativeHead,
		narrativeTail,
		olderThan,
		peopleSummary,
		personStatusChip,
		scrollToAlertCard,
		scrollToFirstVisible,
		splitNarrative
	} from './briefing/briefing.js';
	import { phaseLabel } from '$lib/components/onboarding/meta.js';
	import { PIPELINE_STAGES, STAGE_META, STATUS_META } from '$lib/components/talent/stages.js';
	import { clientCountsSummary, renewalBadge } from '$lib/practice.js';
	import {
		HANDLED_REOPENABLE,
		groupHandled,
		handledAlsoLine,
		handledHeadline,
		handledKey,
		handledProofHref,
		isCloseKind,
		type HandledRow
	} from '$lib/handled.js';
	import {
		ackAlert,
		approveDecision,
		bulkAckAlerts,
		getToday,
		rejectDecision,
		reopenAlert,
		reviewAlerts,
		type ClientCockpitCard,
		type DepartmentBriefItem,
		type HandledItem,
		type InFlightItem,
		type OnboardingBriefItem,
		type PersonBriefItem,
		type ProposalItem,
		type TalentBriefItem,
		type Today
	} from '$lib/api.js';

	interface Props {
		// Called when the user clicks a briefing item to continue the thread
		// in chat. The parent (usually the root page) is expected to switch
		// its main view from briefing → chat and seed the input with `prompt`.
		// When omitted, items render as plain navigation links so the standalone
		// /today page still works.
		onContinue?: (prompt: string) => void;
		// Set to true when this Briefing is the root landing surface — adds a
		// "Here's where we are" header. The standalone /today page already
		// gets the global AppShell breadcrumb, so it omits this prop.
		showHeader?: boolean;
		// Personalises the header greeting when showHeader is true.
		firstName?: string;
	}

	let { onContinue, showHeader = false, firstName }: Props = $props();

	let today = $state<Today | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	// The healthy ("on track") and inactive departments collapse into a single
	// quiet toggle so the section has one disclosure pattern instead of three.
	let showAllDeptsOpen = $state(false);
	// Alerts the user has acted on this session. We optimistically drop
	// them from the rendered "Needs you" / "Across the team" lists so
	// the click feels instant; the canonical state will be picked up by
	// the next /today fetch. (SvelteSet, not `$state(new Set())` — it is
	// mutated in place.)
	const actedAlertIds = new SvelteSet<number>();
	// "Needs you" shows NEEDS_YOU_VISIBLE cards after "Start here"; the rest
	// sit behind one toggle so a long queue reads as a queue, not a wall.
	let showAllNeedsYou = $state(false);
	// "Re-check relevance" runs the Executive's review on demand.
	let recheckBusy = $state(false);
	// Handled-rail rows undone this session (keyed per row, see handledKey).
	const undoneRows = new SvelteSet<string>();
	// Upstream kept this flag inside `HandledOvernightPanel`; a snippet cannot
	// own state, so the disclosure is hoisted here.
	let handledDetailsOpen = $state(false);

	// Re-pull /today after a server-side mutation (e.g. a decision approve/reject)
	// so derived data — the narrative header, per-person and department counts —
	// re-syncs. The optimistic actedAlertIds set already hides the card; this
	// refreshes everything computed from it. Best-effort: a failed refresh leaves
	// the stale-but-still-usable view rather than erroring the briefing.
	function refreshToday() {
		getToday()
			.then((t) => (today = t))
			.catch(() => {
				/* keep current view on failure */
			});
	}

	async function handleApprove(proposal: ProposalItem) {
		actedAlertIds.add(proposal.alert_id);
		try {
			// Decision-backed cards (gated calendar bookings) execute server-side:
			// approveDecision books the meeting AND clears the companion alert, so
			// there's no chat handoff — the optimistic removal hides the card and
			// the next /today fetch confirms it's gone.
			if (proposal.decision_instance_id != null) {
				await approveDecision(proposal.decision_instance_id);
				refreshToday(); // re-sync narrative + counts (no chat nav to trigger it)
				return;
			}
			await ackAlert(proposal.alert_id, 'ack');
			if (onContinue) {
				const text = proposal.body || proposal.headline;
				const action = proposal.suggested_action
					? `\n\nAction to perform:\n${proposal.suggested_action}`
					: '';
				onContinue(
					`I've approved this proposal — the alert is already acked, so do not call ack_alert. ` +
						`Now actually do the work: attempt the action below yourself using your tools ` +
						`(web_search for any research, specialist consults for analysis). Reply inline ` +
						`with the deliverable — the brief, the findings, the draft, whatever the action ` +
						`produces. If the watch is time-bound (e.g. earnings tomorrow, news to recheck), ` +
						`call schedule_followup so I get a fresh check at the right time. Do NOT just ` +
						`summarize what you would do, file it for later, or assign it to someone — ` +
						`the assignment IS to you.\n\nProposal:\n${text}${action}`
				);
			}
		} catch (e) {
			// Revert the optimistic removal on failure so the user can retry.
			actedAlertIds.delete(proposal.alert_id);
			console.error('Approve failed', e);
		}
	}

	// Dismiss is a record-and-forget decision: the card disappears
	// immediately, the backend marks the alert ``dismissed`` (so the
	// Executive sees it on the next /today / alerts read and stops
	// re-surfacing the same thread), and the user stays on the briefing.
	// Unlike Approve, there is no follow-on work for the LLM to carry
	// out, so we deliberately do NOT seed a chat turn — that would
	// navigate away from the briefing for no benefit. On failure we
	// revert the optimistic removal so the user can see the card came
	// back and retry.
	async function handleDismiss(proposal: ProposalItem) {
		actedAlertIds.add(proposal.alert_id);
		try {
			// Decision-backed cards reject server-side (which also clears the
			// companion alert); ordinary alerts just get acked "dismissed".
			if (proposal.decision_instance_id != null) {
				await rejectDecision(proposal.decision_instance_id);
				refreshToday(); // re-sync narrative + counts (no chat nav to trigger it)
				return;
			}
			await ackAlert(proposal.alert_id, 'dismissed');
		} catch (e) {
			actedAlertIds.delete(proposal.alert_id);
			console.error('Dismiss failed', e);
		}
	}

	// Bulk dismiss: the footer under a lane sends explicit ids (the cards the
	// caller can see), never a server-side age sweep. Same optimistic-removal
	// + rollback pattern as the single-card handlers.
	async function handleBulkDismiss(ids: number[]) {
		if (ids.length === 0) return;
		ids.forEach((id) => actedAlertIds.add(id));
		try {
			await bulkAckAlerts({ status: 'dismissed', alert_ids: ids });
			refreshToday();
		} catch (e) {
			ids.forEach((id) => actedAlertIds.delete(id));
			console.error('Bulk dismiss failed', e);
		}
	}

	// Re-check relevance: ask the Executive to review every open alert now
	// (route / escalate / draft / merge / resolve within authority), then
	// re-pull /today so the verdicts, chips and "handled" rail refresh.
	async function handleRecheck() {
		recheckBusy = true;
		try {
			await reviewAlerts();
			refreshToday();
		} catch (e) {
			console.error('Alert review failed', e);
		} finally {
			recheckBusy = false;
		}
	}

	// Undo an autonomous close from the handled rail (HandledOvernightPanel). The
	// rail is rebuilt from the audit log on every fetch (the "closed" row persists
	// after a reopen), so a 409 "already open" after a reload counts as done.
	async function handleReopen(rowKey: string, alertId: number) {
		try {
			await reopenAlert(alertId);
			undoneRows.add(rowKey);
			refreshToday();
		} catch (e) {
			if (e instanceof Error && /409|already/i.test(e.message)) {
				undoneRows.add(rowKey);
				return;
			}
			console.error('Reopen failed', e);
		}
	}

	// Approve-with-edits: user has tweaked the draft text and wants OE to
	// send exactly what they wrote (no LLM rephrasing). Same optimistic-
	// removal + ack pattern as plain approve; the chat seed instructs the
	// Executive to use the edited body verbatim.
	async function handleApproveWithEdits(proposal: ProposalItem, editedBody: string) {
		actedAlertIds.add(proposal.alert_id);
		try {
			await ackAlert(proposal.alert_id, 'ack');
			if (onContinue) {
				onContinue(
					`I'm approving this proposal with my edits — the alert is already acked, so do not ` +
						`call ack_alert. Use the text below VERBATIM when you deliver the message: do not ` +
						`rephrase, summarize, or restructure it. Then go execute (send the DM/email, ` +
						`schedule any follow-up via schedule_followup) and tell me what you did.\n\n${editedBody}`
				);
			}
		} catch (e) {
			actedAlertIds.delete(proposal.alert_id);
			console.error('Approve-with-edits failed', e);
		}
	}

	onMount(() => {
		let cancelled = false;
		getToday()
			.then((t) => {
				if (!cancelled) today = t;
			})
			.catch((e: unknown) => {
				if (!cancelled) error = e instanceof Error ? e.message : 'Failed to load';
			})
			.finally(() => {
				if (!cancelled) loading = false;
			});
		return () => {
			cancelled = true;
		};
	});

	const dateLabel = new Date().toLocaleDateString('en-US', {
		weekday: 'long',
		month: 'long',
		day: 'numeric'
	});

	const activeDepts = $derived(
		today?.departments.filter((d) => d.goal_count > 0 || d.awaiting_count > 0) ?? []
	);
	const inactiveDepts = $derived(
		today?.departments.filter((d) => d.goal_count === 0 && d.awaiting_count === 0) ?? []
	);
	// Within active departments, only the ones with a problem (at risk /
	// off track / awaiting) earn a card at rest. Healthy departments fold
	// into a quiet "N on track" toggle so the briefing isn't a wall of
	// green "on track" cards.
	const attentionDepts = $derived(
		activeDepts.filter((d) => d.at_risk_count > 0 || d.off_track_count > 0 || d.awaiting_count > 0)
	);
	const onTrackDepts = $derived(
		activeDepts.filter(
			(d) => d.at_risk_count === 0 && d.off_track_count === 0 && d.awaiting_count === 0
		)
	);
	// Healthy + inactive departments fold into one quiet toggle. Summary text
	// reflects both buckets so the single control is self-describing.
	const quietDeptCount = $derived(onTrackDepts.length + inactiveDepts.length);
	const quietDeptSummary = $derived(
		[
			onTrackDepts.length > 0 ? `${onTrackDepts.length} on track` : null,
			inactiveDepts.length > 0 ? `${inactiveDepts.length} inactive` : null
		]
			.filter(Boolean)
			.join(' · ')
	);

	const isQuiet = $derived(
		today !== null &&
			today.proposals.length === 0 &&
			activeDepts.every(
				(d) => d.at_risk_count === 0 && d.off_track_count === 0 && d.awaiting_count === 0
			) &&
			today.people.every((p) => p.awaiting_count === 0)
	);

	const showPeopleSidebar = $derived((today?.people.length ?? 0) > 1);

	// Bucket proposals once (previously an inline IIFE in the JSX) so the
	// status strip and the section lists work off the same split. "Needs
	// you" = action proposals routed to the caller, plus unrouted catch-all
	// items when the caller is the principal. When the caller can't be
	// resolved (caller_person_id null — e.g. a direct curl), fall back to
	// the legacy single bucket so the queue still renders. Optimistically-
	// acted alerts are dropped first so counts reflect the click.
	const callerId = $derived(today?.caller_person_id ?? null);
	const isPrincipalCaller = $derived(
		callerId == null ? false : (today?.people.find((p) => p.id === callerId)?.is_principal ?? false)
	);
	const liveProposals = $derived(
		(today?.proposals ?? []).filter((p) => !actedAlertIds.has(p.alert_id))
	);
	const monitoringProposals = $derived(liveProposals.filter((p) => p.category === 'monitoring'));
	const actionProposals = $derived(liveProposals.filter((p) => p.category !== 'monitoring'));
	const mineProposals = $derived(
		callerId == null
			? actionProposals
			: actionProposals.filter(
					(p) =>
						p.routed_to_person_id === callerId ||
						(p.routed_to_person_id == null && isPrincipalCaller)
				)
	);
	// Plain array (not a Set) so the duplicate-check stays reactive without
	// tripping the autofixer's SvelteSet rule inside a `$derived`.
	const mineAlertIds = $derived(mineProposals.map((p) => p.alert_id));
	const otherProposals = $derived(
		callerId == null ? [] : actionProposals.filter((p) => !mineAlertIds.includes(p.alert_id))
	);
	// "Needs you" splits into the single highest-priority item (rendered as an
	// elevated "Start here" card so there's one obvious first action) and the
	// rest (the scrolling queue below). Backend sorts action proposals by score,
	// so mineProposals[0] is the sharpest.
	const startHereProposal = $derived(mineProposals[0] ?? null);
	const restProposals = $derived(mineProposals.slice(1));
	const staleNeedsYouIds = $derived(olderThan(mineProposals, NEEDS_YOU_DISMISS_OLDER_THAN_DAYS));
	const handledOvernight = $derived(today?.handled_overnight ?? []);

	// Status-strip inputs, all from data already computed above.
	const inFlightCount = $derived(today?.in_flight?.length ?? 0);
	const deptAtRiskCount = $derived(
		attentionDepts.filter((d) => d.at_risk_count > 0 || d.off_track_count > 0).length
	);
	const peopleNeedReply = $derived(
		(today?.people ?? []).filter((p) => p.status === 'needs_reply').length
	);
	const peopleOverdue = $derived((today?.people ?? []).filter((p) => p.overdue).length);
	// Only searches with an actionable signal earn an attention pill — mirrors the
	// narrative's `notable_searches` filter. The Executive-search card still shows
	// every active search; the pill is just the one-second "what needs a move" read.
	const searchesNeedingAttention = $derived(
		(today?.talent ?? []).filter(
			(t) =>
				(t.offers_expiring_soon ?? 0) > 0 ||
				t.offers_out > 0 ||
				t.stalled_count > 0 ||
				t.needs_screening > 0
		).length
	);
	const statPills = $derived(
		today
			? briefingStats({
					needsYou: mineProposals.length,
					handledOvernight: groupHandled(handledOvernight).length,
					peopleOverdue,
					peopleNeedReply,
					deptAtRisk: deptAtRiskCount,
					inFlight: inFlightCount,
					monitoring: monitoringProposals.length,
					searchesNeedingAttention
				})
			: []
	);

	const narrativeBlocks = $derived(splitNarrative(today?.narrative ?? ''));

	// Upstream spread `prose prose-invert prose-sm max-w-none prose-p:my-1
	// prose-ul:my-1 prose-headings:text-fg prose-strong:text-fg` onto the
	// narrative wrapper; `Markdown.svelte` supplies `prose max-w-none` itself,
	// so only the modifiers are passed through per block.
	const NARRATIVE_PROSE_CLASS =
		'prose-invert prose-sm prose-p:my-1 prose-ul:my-1 prose-headings:text-fg prose-strong:text-fg';
	const NARRATIVE_BULLET_PROSE_CLASS =
		'prose-invert prose-sm prose-p:my-0 prose-p:leading-snug prose-strong:text-fg';
</script>

<!-- Section header: optional icon, title, optional count badge (mirrors
     `SectionHeading` from the upstream memories barrel). Upstream's
     `ClickableBriefingItem` — a button that seeds chat when `onContinue` is
     provided, a plain link otherwise — is reproduced inside each section
     snippet that used it (`deptCard`, `talentCard`, `monitoringRow`). -->
{#snippet sectionHeading(title: string, count: number | null, icon: IconName | null)}
	<div class="mb-3">
		<div class="flex flex-wrap items-center gap-2">
			{#if icon}
				<Icon name={icon} size="w-4 h-4" class="text-fg-subtle" />
			{/if}
			<h3 class="text-sm font-semibold text-fg">{title}</h3>
			{#if count != null}
				<span class="text-xs font-normal text-fg-subtle tabular-nums">{count}</span>
			{/if}
		</div>
	</div>
{/snippet}

<!-- Section header label. `primaryLabel` makes a section visually dominant (the
     things that need the user's action); `ambientLabel` is the quieter
     uppercase style used for awareness sections (in flight, monitoring,
     departments, activity). Count renders inline and only when non-zero. -->
{#snippet primaryLabel(count: number | null, text: string)}
	<span class="text-sm font-semibold text-fg">
		{text}
		{#if count != null && count > 0}
			<span class="ml-1.5 font-normal text-fg-muted">{`(${count})`}</span>
		{/if}
	</span>
{/snippet}

{#snippet ambientLabel(count: number | null, text: string)}
	<span class="text-xs font-semibold tracking-wide text-fg-muted uppercase group-open:text-fg">
		{text}
		{#if count != null && count > 0}
			<span class="ml-1 font-normal tracking-normal normal-case">{`(${count})`}</span>
		{/if}
	</span>
{/snippet}

{#snippet deptCardBody(dept: DepartmentBriefItem)}
	{@const hasIssues = dept.at_risk_count > 0 || dept.off_track_count > 0}
	<!-- Problem goals beyond the inline cap fall to the department page. -->
	{@const attentionGoalOverflow =
		dept.at_risk_count + dept.off_track_count - (dept.attention_goals?.length ?? 0)}
	<div class="mb-3 flex items-start justify-between gap-2">
		<div
			class="text-sm font-semibold text-fg transition-colors group-hover:text-indigo-300"
			title={dept.title}
		>
			{dept.title}
		</div>
		<span class="shrink-0 text-[10px] text-fg-muted">
			{dept.authority_level.replace('_', ' ')}
		</span>
	</div>
	<div class="flex items-center gap-3 text-xs">
		<span class="text-fg-muted">{`${dept.goal_count} Goal${dept.goal_count !== 1 ? 's' : ''}`}</span
		>
		{#if dept.at_risk_count > 0}
			<span
				class="inline-block rounded border border-amber-500/30 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-300"
			>
				{`${dept.at_risk_count} at risk`}
			</span>
		{/if}
		{#if dept.off_track_count > 0}
			<span
				class="inline-block rounded border border-rose-500/30 bg-rose-500/20 px-1.5 py-0.5 text-[10px] font-medium text-rose-300"
			>
				{`${dept.off_track_count} off track`}
			</span>
		{/if}
		{#if !hasIssues && dept.goal_count > 0}
			<span
				class="inline-block rounded border border-emerald-500/30 bg-emerald-500/20 px-1.5 py-0.5 text-[10px] font-medium text-emerald-300"
			>
				on track
			</span>
		{/if}
		{#if dept.awaiting_count > 0}
			<span
				class="ml-auto inline-block rounded border border-sky-500/30 bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-medium text-sky-300"
			>
				{`${dept.awaiting_count} awaiting`}
			</span>
		{/if}
	</div>
	<!-- The actual off-track / at-risk goals, inline — so the card is
	     insightful at rest instead of a count you have to click into.
	     Healthy / inactive departments carry no attention_goals. -->
	{#if dept.attention_goals && dept.attention_goals.length > 0}
		<div class="mt-3 space-y-1.5 border-t border-line pt-2.5">
			{#each dept.attention_goals as goal, i (i)}
				<div class="flex items-start gap-1.5 text-[11px] leading-snug">
					<span
						aria-hidden="true"
						class={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${goal.status === 'off_track' ? 'bg-rose-400' : 'bg-amber-400'}`}
					></span>
					<span class="min-w-0">
						<span class="text-fg">{goal.key_result}</span>
						{#if goal.current || goal.target}
							<span class="text-fg-subtle">
								{` — ${goal.current || '—'} vs ${goal.target || '—'}`}
							</span>
						{/if}
					</span>
				</div>
			{/each}
			{#if attentionGoalOverflow > 0}
				<div class="pl-3 text-[10px] text-fg-subtle">{`+${attentionGoalOverflow} more`}</div>
			{/if}
		</div>
	{/if}
{/snippet}

{#snippet deptCard(dept: DepartmentBriefItem, dimmed = false)}
	{@const cls = `group block py-3 transition-colors hover:bg-surface-overlay/30${dimmed ? ' opacity-60 hover:opacity-100' : ''}`}
	{#if onContinue}
		<button
			type="button"
			onclick={() => onContinue?.(`Tell me about ${dept.title} — what's the current status?`)}
			class={`${cls} w-full cursor-pointer text-left`}
		>
			{@render deptCardBody(dept)}
		</button>
	{:else}
		<a href={`/departments/${dept.slug}`} class={cls}>
			{@render deptCardBody(dept)}
		</a>
	{/if}
{/snippet}

{#snippet personRow(person: PersonBriefItem)}
	{@const chip = personStatusChip(person)}
	{@const pills = person.authority_scope.slice(0, 2)}
	{@const extraPills = person.authority_scope.length - pills.length}
	<a
		href={`/people/${person.id}`}
		class="group block py-3 transition-colors hover:bg-surface-overlay/30"
	>
		<div class="flex items-center justify-between gap-2">
			<div class="flex min-w-0 items-center gap-2">
				<div
					class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-indigo-500 to-violet-600"
				>
					<span class="text-[9px] font-bold text-white">{person.full_name.charAt(0)}</span>
				</div>
				<div class="min-w-0">
					<div class="truncate text-xs font-medium text-fg">{person.full_name}</div>
					<div class="truncate text-[10px] text-fg-muted">{person.role}</div>
				</div>
			</div>
			<div class="shrink-0 text-right">
				{#if chip}
					<span
						class={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${chip.cls}`}
					>
						{chip.label}
					</span>
				{:else}
					<span class="text-[10px] text-fg-subtle">Clear</span>
				{/if}
				{#if chip && person.status === 'awaiting' && person.soonest_sla_at}
					<div class={`mt-0.5 text-[10px] ${person.overdue ? 'text-rose-300' : 'text-fg-muted'}`}>
						{`SLA ${person.overdue ? 'overdue' : `in ${formatRelTime(person.soonest_sla_at)}`}`}
					</div>
				{/if}
			</div>
		</div>

		{#if person.insight}
			<p class="mt-1.5 line-clamp-2 text-[10px] leading-snug text-fg-muted">{person.insight}</p>
		{/if}

		<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
			{#if person.status !== 'on_leave'}
				<span class="inline-flex items-center gap-1 text-[10px] text-fg-subtle">
					<span
						class={`h-1.5 w-1.5 rounded-full ${person.reachable_now ? 'bg-emerald-400' : 'bg-slate-500'}`}
					></span>
					{#if person.reachable_now}
						Available
					{:else if person.next_window_at}
						{`Back in ${formatRelTime(person.next_window_at)}`}
					{:else}
						Away
					{/if}
				</span>
			{/if}
			{#each pills as tok (tok)}
				<span
					class="inline-block rounded border border-line bg-surface-overlay px-1 py-px text-[9px] text-fg-subtle"
				>
					{authorityLabel(tok)}
				</span>
			{/each}
			{#if extraPills > 0}
				<span class="text-[9px] text-fg-subtle">{`+${extraPills}`}</span>
			{/if}
		</div>
	</a>
{/snippet}

<!-- In flight — what the Executive is about to do (scheduled follow-ups &
     nudges). Ambient/awareness content in the right column, always visible (no
     approval needed). Takes its anchor `id` as an argument (set by the caller). -->
{#snippet inFlightPanel(inFlight: InFlightItem[], id: string)}
	{#if inFlight.length > 0}
		<section {id} class="rounded-xl border border-line bg-surface-elevated p-4">
			<div class="mb-1 flex items-center gap-1.5">
				{@render sectionHeading('In flight', inFlight.length, 'bolt')}
				<InfoTip align="left">
					What the Executive is about to do (scheduled follow-ups &amp; nudges). Nothing here needs
					your approval — it&apos;s a heads-up.
				</InfoTip>
			</div>
			<div class="max-h-128 divide-y divide-line overflow-y-auto pr-1">
				{#each inFlight as f (f.action_id)}
					<div
						class={`group border-l-2 py-3 pl-2 transition-colors hover:bg-surface-overlay/30 ${f.overdue ? 'border-amber-500/40' : 'border-transparent'}`}
					>
						<div class="text-xs break-words text-fg" title={f.intent}>{f.intent}</div>
						<div class="mt-0.5 text-[11px] text-fg-muted">
							{#if f.target}
								<span>{`→ ${f.target}`}</span>
							{/if}
							{#if f.department}
								<span>{` · ${f.department}`}</span>
							{/if}
							{#if f.overdue}
								<span class="text-amber-400">{`${DOT_SEP}overdue`}</span>
							{:else}
								<span>{` · ${formatFuture(f.run_at)}`}</span>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}
{/snippet}

<!-- One open search as a compact card: role • department • status, the pipeline
     rollup, and attention badges (offers out / stalled / to screen). Click-to-
     discuss seeds chat; a quiet link opens the full engagement page. -->
{#snippet talentCard(item: TalentBriefItem)}
	{@const status = STATUS_META[item.status as keyof typeof STATUS_META]}
	{@const expiringSoon = item.offers_expiring_soon ?? 0}
	{@const header = ''}
	<div
		class="group border-l-2 border-transparent py-3 pl-2 transition-colors hover:bg-surface-overlay/30"
	>
		{#if onContinue}
			<button
				type="button"
				onclick={() => onContinue?.(buildTalentSeed(item))}
				class="block w-full cursor-pointer rounded text-left focus:ring-1 focus:ring-indigo-500/40 focus:outline-none"
			>
				{@render talentCardHeader(item, status)}
			</button>
		{:else}
			<a href={`/talent/engagements/${item.engagement_id}`} class="block">
				{@render talentCardHeader(item, status)}
			</a>
		{/if}
		<div class="mt-1.5 flex flex-wrap items-center gap-1">
			{#each PIPELINE_STAGES as stage (stage)}
				{@const n = item.stage_counts[stage] ?? 0}
				{#if n > 0}
					<span
						class={`inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] ${STAGE_META[stage].pill}`}
						title={`${n} ${STAGE_META[stage].label}`}
					>
						{`${STAGE_META[stage].label} ${n}`}
					</span>
				{/if}
			{/each}
			{#if item.candidate_count === 0}
				<span class="text-[10px] text-fg-subtle">No candidates yet</span>
			{/if}
		</div>
		{#if expiringSoon > 0 || item.offers_out > 0 || item.stalled_count > 0 || item.needs_screening > 0}
			<div class="mt-1 flex flex-wrap gap-1">
				<!-- Red (rejected) pill — an offer about to lapse undecided is the most
				     time-critical signal a search can carry, so it leads the badge row. -->
				{#if expiringSoon > 0}
					<span
						class={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${STAGE_META.rejected.pill}`}
					>
						{`${expiringSoon} offer${expiringSoon === 1 ? '' : 's'} expiring`}
					</span>
				{/if}
				{#if item.offers_out > 0}
					<span
						class={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${STAGE_META.offer.pill}`}
					>
						{`${item.offers_out} offer${item.offers_out === 1 ? '' : 's'} out`}
					</span>
				{/if}
				<!-- Amber (warning), not the red `rejected` pill — a stalled candidate is
				     still in play and needs a nudge, not one that was cut from the pipeline. -->
				{#if item.stalled_count > 0}
					<span
						class={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${STATUS_META.on_hold.pill}`}
					>
						{`${item.stalled_count} stalled`}
					</span>
				{/if}
				{#if item.needs_screening > 0}
					<span
						class={`inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${STAGE_META.lead.pill}`}
					>
						{`${item.needs_screening} to screen`}
					</span>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet talentCardHeader(
	item: TalentBriefItem,
	status: { label: string; pill: string } | undefined
)}
	<div class="flex items-start justify-between gap-2">
		<div class="min-w-0">
			<div
				class="truncate text-xs font-medium text-fg"
				title={item.department ? `${item.role_title} — ${item.department}` : item.role_title}
			>
				{item.role_title}
			</div>
			{#if item.department}
				<div class="truncate text-[11px] text-fg-muted">{item.department}</div>
			{/if}
		</div>
		{#if status}
			<span
				class={`inline-flex shrink-0 items-center rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${status.pill}`}
			>
				{status.label}
			</span>
		{/if}
	</div>
{/snippet}

<!-- Executive Search — active engagements rolled up by pipeline stage. Ambient
     awareness card in the right column; clicking a search hands off to chat.
     Takes its anchor `id` as an argument (set by the caller). -->
{#snippet talentPanel(talent: TalentBriefItem[], id: string)}
	{#if talent.length > 0}
		<section {id} class="rounded-xl border border-line bg-surface-elevated p-4">
			<div class="mb-1 flex items-center justify-between gap-2">
				<div class="flex items-center gap-1.5">
					{@render sectionHeading('Executive search', talent.length, 'search')}
					<InfoTip align="left">
						Active searches and where each stands across the pipeline. Click a search to pick it up
						in chat — review fit, screen a candidate, or move the next step.
					</InfoTip>
				</div>
				<a href="/talent" class="shrink-0 text-xs text-indigo-400 hover:text-indigo-300">View all</a
				>
			</div>
			<div class="max-h-128 divide-y divide-line overflow-y-auto pr-1">
				{#each talent as item (item.engagement_id)}
					{@render talentCard(item)}
				{/each}
			</div>
		</section>
	{/if}
{/snippet}

{#snippet onboardingCard(item: OnboardingBriefItem)}
	{@const startLabel =
		item.days_to_start == null
			? ''
			: item.days_to_start > 0
				? `starts in ${item.days_to_start}d`
				: item.days_to_start < 0
					? `day ${Math.abs(item.days_to_start) + 1}`
					: 'starts today'}
	<div class="py-2 first:pt-0 last:pb-0">
		<button
			type="button"
			onclick={() => onContinue?.(buildOnboardingSeed(item))}
			class="group w-full cursor-pointer text-left"
		>
			<div class="flex items-center justify-between gap-2">
				<span class="truncate text-sm text-fg group-hover:text-indigo-300">
					{item.full_name}
					{#if item.role}
						<span class="text-fg-muted">{` — ${item.role}`}</span>
					{/if}
				</span>
				<span class="shrink-0 text-xs text-fg-subtle tabular-nums">
					{`${item.completion_pct}%`}
				</span>
			</div>
			<div class="mt-1 flex items-center gap-2 text-[11px] text-fg-subtle">
				<span>{phaseLabel(item.current_phase)}</span>
				{#if item.overdue_tasks > 0}
					<span class="text-rose-300">{`${item.overdue_tasks} overdue`}</span>
				{/if}
				{#if item.open_tasks > 0}
					<span>{`${item.open_tasks} open`}</span>
				{/if}
				{#if startLabel}
					<span>{` · ${startLabel}`}</span>
				{/if}
			</div>
		</button>
	</div>
{/snippet}

{#snippet onboardingPanel(onboarding: OnboardingBriefItem[], id: string)}
	{#if onboarding.length > 0}
		<section {id} class="rounded-xl border border-line bg-surface-elevated p-4">
			<div class="mb-1 flex items-center justify-between gap-2">
				<div class="flex items-center gap-1.5">
					{@render sectionHeading('Staff onboarding', onboarding.length, 'users')}
					<InfoTip align="left">
						New hires currently ramping. Click one to pick it up in chat — check progress, mark
						tasks done, or move their plan forward.
					</InfoTip>
				</div>
				<a href="/staff-onboarding" class="shrink-0 text-xs text-indigo-400 hover:text-indigo-300">
					View all
				</a>
			</div>
			<div class="max-h-128 divide-y divide-line overflow-y-auto pr-1">
				{#each onboarding as item (item.plan_id)}
					{@render onboardingCard(item)}
				{/each}
			</div>
		</section>
	{/if}
{/snippet}

<!-- Multi-client practice mode only: rollup cards for PARKED client slots so
     the operator sees the whole practice from the active client's brief. The
     backend sends [] for single-company installs (0-1 slots), so this renders
     nothing in the default experience. -->
{#snippet practiceClientsPanel(clients: ClientCockpitCard[], id: string)}
	{#if clients.length > 0}
		<section {id} class="rounded-xl border border-line bg-surface-elevated p-4">
			<div class="mb-1 flex items-center justify-between gap-2">
				<div class="flex items-center gap-1.5">
					{@render sectionHeading('Across your clients', clients.length, 'building')}
					<InfoTip align="left">
						Your parked client companies. Counts reflect each client&apos;s last save point; switch
						to a client on the Clients page to work in it.
					</InfoTip>
				</div>
				<a href="/clients" class="shrink-0 text-xs text-indigo-400 hover:text-indigo-300">
					Manage clients
				</a>
			</div>
			<div class="max-h-128 divide-y divide-line overflow-y-auto pr-1">
				{#each clients as client (client.slug)}
					{@const badge = renewalBadge(client.days_to_renewal)}
					<div class="py-3">
						<div class="flex items-center justify-between gap-2">
							<div class="truncate text-xs font-medium text-fg">
								{client.display_name}
								{#if client.role}
									<span class="font-normal text-fg-muted">{` · ${client.role}`}</span>
								{/if}
							</div>
							{#if badge}
								<span
									class={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${
										badge.urgent
											? 'border-red-500/40 bg-red-500/10 text-red-400'
											: 'border-amber-500/40 bg-amber-500/10 text-amber-400'
									}`}
								>
									{badge.label}
								</span>
							{/if}
						</div>
						<div class="mt-0.5 text-[11px] text-fg-muted">
							{clientCountsSummary(client)}
						</div>
					</div>
				{/each}
			</div>
		</section>
	{/if}
{/snippet}

<!-- A single passive monitoring signal as a compact rail row: headline +
     optional body excerpt, click-to-discuss, and a small dismiss affordance.
     Full ProposalCard is too wide for the rail, so this is the slimmed-down
     presentation; the Discuss handoff reuses buildMonitoringSeed so it behaves
     exactly like the card did. -->
{#snippet monitoringRow(proposal: ProposalItem)}
	<div
		id={`alert-${proposal.alert_id}`}
		class="group relative py-3 transition-colors hover:bg-surface-overlay/30"
	>
		{#if onContinue}
			<button
				type="button"
				onclick={() => onContinue?.(buildMonitoringSeed(proposal))}
				class="block w-full cursor-pointer pr-8 text-left focus:ring-1 focus:ring-indigo-500/40 focus:outline-none"
			>
				{@render monitoringRowBody(proposal)}
			</button>
		{:else}
			<a href="/watchlist" class="block pr-8">
				{@render monitoringRowBody(proposal)}
			</a>
		{/if}
		<button
			type="button"
			aria-label="Dismiss signal"
			onclick={() => handleDismiss(proposal)}
			class="absolute top-1.5 right-1.5 flex h-6 w-6 cursor-pointer items-center justify-center rounded text-fg-subtle opacity-0 transition-colors group-hover:opacity-100 focus-within:opacity-100 hover:bg-surface-overlay hover:text-fg focus:opacity-100 focus:ring-1 focus:ring-indigo-500/40 focus:outline-none"
		>
			<span aria-hidden="true" class="text-sm leading-none">×</span>
		</button>
	</div>
{/snippet}

{#snippet monitoringRowBody(proposal: ProposalItem)}
	<div
		class="line-clamp-2 text-xs font-medium text-fg transition-colors group-hover:text-indigo-300"
		title={proposal.headline}
	>
		{proposal.headline}
	</div>
	{#if proposal.body && proposal.body !== proposal.headline}
		<div class="mt-0.5 line-clamp-2 text-[11px] leading-snug text-fg-muted">
			{proposal.body}
		</div>
	{/if}
{/snippet}

<!-- Monitoring — passive signals (watchlist tickers, vendor status, external
     news) the Executive is tracking. An ambient right-column card; the full
     list scrolls inside the card. Takes its anchor `id` as an argument. -->
{#snippet monitoringPanel(proposals: ProposalItem[], id: string)}
	{@const staleIds = olderThan(proposals, MONITORING_DISMISS_OLDER_THAN_DAYS)}
	{#if proposals.length > 0}
		<section {id} class="rounded-xl border border-line bg-surface-elevated p-4">
			<div class="mb-1 flex items-center gap-1.5">
				{@render sectionHeading('Monitoring', proposals.length, 'eye')}
				<InfoTip align="left">
					Passive signals (watchlist tickers, vendor status, external news) the Executive is
					tracking. Nothing here needs a decision — tap one to talk it through.
				</InfoTip>
			</div>
			<div class="max-h-128 divide-y divide-line overflow-y-auto pr-1">
				{#each proposals as p (p.alert_id)}
					{@render monitoringRow(p)}
				{/each}
			</div>
			{#if staleIds.length > 0}
				<button
					type="button"
					onclick={() => handleBulkDismiss(staleIds)}
					class="mt-2 cursor-pointer text-[11px] text-fg-muted transition-colors hover:text-rose-300"
				>
					{`✕ Dismiss ${staleIds.length} older than ${MONITORING_DISMISS_OLDER_THAN_DAYS} days`}
				</button>
			{/if}
		</section>
	{/if}
{/snippet}

<!-- Handled rail — pure logic lives in `$lib/handled`; only rendering stays
     here. -->

{#snippet handledWhy(h: HandledItem)}
	{#if h.detail}
		<span class="text-fg-subtle">{` — ${h.detail}`}</span>
	{/if}
{/snippet}

<!-- First-person sentence for one row. Falls back to the audit summary when the
     row predates the structured fields (no headline / target to compose from). -->
{#snippet handledSentence(h: HandledItem)}
	{@const headline = h.headline ?? ''}
	{@const target = h.target ?? ''}
	{#if !headline}
		{h.summary}
	{:else if h.kind === 'closed'}
		{#if h.outcome === 'dismissed'}
			<span>Dismissed</span> <span class="text-fg">{headline}</span>
			<span>as stale</span>{@render handledWhy(h)}
		{:else}
			<span>Resolved</span> <span class="text-fg">{headline}</span>{@render handledWhy(h)}
		{/if}
	{:else if h.kind === 'routed'}
		{#if !target}
			{h.summary}
		{:else if h.outcome === 'proposed'}
			<span>Proposed</span> <span class="text-fg">{headline}</span> <span>to</span>
			<span class="text-fg">{target}</span>
			<span class="text-fg-subtle">(awaiting their approval)</span>
		{:else}
			<span>Handed</span> <span class="text-fg">{headline}</span> <span>to</span>
			<span class="text-fg">{target}</span>
		{/if}
	{:else if h.kind === 'nudged'}
		{#if target}
			<span>Chased</span> <span class="text-fg">{target}</span> <span>on</span>
			<span class="text-fg">{headline}</span>
		{:else}
			{h.summary}
		{/if}
	{:else if h.kind === 'escalated'}
		{#if target}
			<span>Raised</span> <span class="text-fg">{headline}</span> <span>to</span>
			<span class="text-fg">{target}</span>{@render handledWhy(h)}
		{:else}
			<span>Raised</span> <span class="text-fg">{headline}</span>{@render handledWhy(h)}
		{/if}
	{:else if h.kind === 'drafted'}
		{#if target}
			<span>Drafted</span> <span class="text-fg">{target}</span> <span>from</span>
			<span class="text-fg">{headline}</span>
		{:else}
			{h.summary}
		{/if}
	{:else if h.kind === 'merged'}
		{#if target}
			<span>Folded</span> <span class="text-fg">{headline}</span> <span>into</span>
			<span class="text-fg">{target}</span>
		{:else}
			{h.summary}
		{/if}
	{:else if h.kind === 'suggested_workflow'}
		{#if target}
			<span>Suggested running</span> <span class="text-fg">{target}</span> <span>on</span>
			<span class="text-fg">{headline}</span>
		{:else}
			{h.summary}
		{/if}
	{:else if h.kind === 'watching'}
		<span>Started watching</span> <span class="text-fg">{headline}</span>{@render handledWhy(h)}
	{:else if h.kind === 'stopped_watching'}
		<span>Stopped watching</span> <span class="text-fg">{headline}</span>{@render handledWhy(h)}
	{:else}
		{h.summary}
	{/if}
{/snippet}

{#snippet handledTrailerLink(href: string, label: string)}
	<span aria-hidden="true">·</span>
	<a {href} class="transition-colors hover:text-indigo-300">{label}</a>
{/snippet}

{#snippet handledRowView(row: HandledRow, reverted: boolean)}
	{@const h = row.item}
	<!-- Undo only while the close still stands and the server would accept a
	     reopen (resolved / dismissed / expired / merged; "" = status unknown). -->
	{@const canUndo =
		h.alert_id != null && isCloseKind(h) && !reverted && HANDLED_REOPENABLE.has(h.status ?? '')}
	<!-- "open" means live in the queue right now — the only state with a card to
	     jump to (an acked or snoozed alert has none). -->
	{@const stillOpen = h.alert_id != null && h.status === 'open' && !isCloseKind(h)}
	{@const proofHref = handledProofHref(h)}
	{@const alsoLine = handledAlsoLine(row)}
	<div class="flex items-start justify-between gap-3 py-2">
		<div class="min-w-0">
			<p
				class={`text-xs leading-snug ${reverted ? 'text-fg-subtle line-through' : 'text-fg-muted'}`}
			>
				{@render handledSentence(h)}
			</p>
			<p class="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[10px] text-fg-subtle">
				{#if alsoLine}
					<span>{alsoLine}</span>
					<span aria-hidden="true">·</span>
				{/if}
				<span>{`${ageLabel(h.at)} ago`}</span>
				{#if proofHref}
					{@render handledTrailerLink(proofHref, h.evidence_ref || 'evidence')}
				{/if}
				{#if h.kind === 'drafted'}
					{@render handledTrailerLink('/artifacts', 'read the draft')}
				{/if}
				{#if h.kind === 'watching' || h.kind === 'stopped_watching'}
					{@render handledTrailerLink('/watchlist', 'watchlist')}
				{/if}
				{#if reverted}
					<span aria-hidden="true">·</span>
					<span class="text-sky-300">Reopened</span>
				{/if}
			</p>
		</div>
		{#if canUndo}
			<button
				type="button"
				onclick={() => handleReopen(handledKey(h), h.alert_id as number)}
				class="shrink-0 cursor-pointer text-[11px] text-fg-muted transition-colors hover:text-indigo-300"
			>
				↶ Undo
			</button>
		{/if}
		{#if stillOpen}
			<button
				type="button"
				onclick={() => scrollToAlertCard(h.alert_id as number)}
				class="shrink-0 cursor-pointer text-[11px] text-fg-muted transition-colors hover:text-indigo-300"
				title="Jump to it in your queue"
			>
				still open ↓
			</button>
		{/if}
	</div>
{/snippet}

{#snippet handledPanel(items: HandledItem[])}
	{@const rows = groupHandled(items)}
	<!-- The rail is rebuilt from the audit log on every fetch, so a close the
	     principal already undid still has its row: `status === "open"` (server
	     truth after a reload) or the in-session set marks it reverted. -->
	{@const revertedRowKeys = rows
		.filter(
			(row) =>
				isCloseKind(row.item) &&
				(row.item.status === 'open' || undoneRows.has(handledKey(row.item)))
		)
		.map((row) => handledKey(row.item))}
	{#if rows.length > 0}
		<section
			id={SECTION_IDS.handled}
			class="rounded-xl border border-line bg-surface-elevated px-4 py-2.5"
		>
			<div class="flex items-start gap-1.5">
				<p class="min-w-0 flex-1 text-sm text-fg">
					{handledHeadline(
						rows,
						(h) => isCloseKind(h) && (h.status === 'open' || undoneRows.has(handledKey(h)))
					)}
				</p>
				<InfoTip align="left">
					Moves I completed on my own since your last delivered brief — routed, chased, escalated,
					drafted, folded, or closed with cited evidence. Rewrites of open alerts show on the card
					itself, not here. Undo puts a closed item back in your queue.
				</InfoTip>
				<button
					type="button"
					onclick={() => (handledDetailsOpen = !handledDetailsOpen)}
					aria-expanded={handledDetailsOpen}
					aria-controls={HANDLED_DETAILS_ID}
					class="mt-0.5 shrink-0 cursor-pointer text-[11px] text-fg-muted transition-colors hover:text-fg"
				>
					<span>{handledDetailsOpen ? 'hide' : 'details'}</span>
					<span aria-hidden="true">{handledDetailsOpen ? '▾' : '▸'}</span>
				</button>
			</div>
			<!-- Always in the DOM so aria-controls resolves while collapsed. -->
			<div
				id={HANDLED_DETAILS_ID}
				hidden={!handledDetailsOpen}
				class="mt-1.5 divide-y divide-line border-t border-line"
			>
				{#if handledDetailsOpen}
					{#each rows as row (handledKey(row.item))}
						{@render handledRowView(row, revertedRowKeys.includes(handledKey(row.item)))}
					{/each}
				{/if}
			</div>
		</section>
	{/if}
{/snippet}

<!-- Narrative bullets. Upstream rendered the narrative with react-markdown,
     overriding `ul`/`li` so the first NARRATIVE_HEAD_BULLETS stay on screen
     (the rest fold into a "Show N more signals" disclosure) and every bullet is
     its own click target that hands the item to chat. `Markdown.svelte` renders
     sanitised HTML and cannot carry per-node behaviour, so `splitNarrative`
     reproduces the block split and each bullet's inline Markdown is rendered by
     `Markdown.svelte` inside the button. -->
{#snippet narrativeBullet(item: string)}
	{@const text = markdownToPlainText(item)}
	<li class="list-none">
		{#if text}
			<button
				type="button"
				onclick={() => onContinue?.(buildNarrativeSeed(text))}
				aria-label={`Discuss: ${text}`}
				class="group -mx-1.5 flex w-full cursor-pointer items-start gap-2 rounded px-1.5 py-0.5 text-left transition hover:bg-indigo-500/10 focus:ring-1 focus:ring-indigo-500/40 focus:outline-none"
			>
				<!-- 💬 stands in for the bullet and signals "click to discuss";
				     items-start keeps it on the first line with the text hanging
				     beside it. opacity lifts on hover as the click cue. -->
				<span
					aria-hidden="true"
					class="mt-0.5 shrink-0 opacity-70 transition select-none group-hover:opacity-100"
				>
					💬
				</span>
				<span class="min-w-0">
					<Markdown source={item} class={NARRATIVE_BULLET_PROSE_CLASS} as="span" />
				</span>
			</button>
		{:else}
			<!-- No extractable text (empty or whitespace-only bullet) → render a
			     plain, non-clickable item rather than a button that seeds an empty
			     prompt. -->
			<span>{item}</span>
		{/if}
	</li>
{/snippet}

{#snippet narrativeList(items: string[])}
	{@const tail = narrativeTail(items)}
	<ul class="my-1 list-none space-y-0.5 pl-0">
		{#each narrativeHead(items) as item, i (i)}
			{@render narrativeBullet(item)}
		{/each}
		{#if tail.length > 0}
			<li class="list-none">
				<details class="group mt-0.5">
					<summary
						class="flex cursor-pointer list-none items-center gap-1.5 rounded py-0.5 text-xs text-fg-muted transition-colors hover:text-fg focus:ring-1 focus:ring-indigo-500/40 focus:outline-none"
					>
						<span aria-hidden="true" class="text-[10px] transition-transform group-open:rotate-90">
							▸
						</span>
						<span>{`Show ${tail.length} more signal${tail.length === 1 ? '' : 's'}`}</span>
					</summary>
					<ul class="mt-1 list-none space-y-0.5 pl-0">
						{#each tail as item, i (i)}
							{@render narrativeBullet(item)}
						{/each}
					</ul>
				</details>
			</li>
		{/if}
	</ul>
{/snippet}

<div class="flex h-full flex-col bg-surface">
	<main class="flex-1 overflow-y-auto">
		<div class="mx-auto max-w-6xl px-6 py-6">
			<div class="mb-3 flex items-baseline gap-3">
				<h1 class="text-xl font-semibold text-fg">
					{showHeader
						? firstName
							? `Here's where we are, ${firstName}.`
							: "Here's where we are."
						: 'Today'}
				</h1>
				<span class="text-sm text-fg-muted">{dateLabel}</span>
			</div>

			{#if loading}
				<p class="text-sm text-fg-muted" role="status">Loading…</p>
			{/if}
			{#if error}
				<div
					class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
					role="alert"
				>
					{error}
				</div>
			{/if}

			{#if today}
				<!-- Glanceable status strip — a one-second read of what needs
				     attention, built from the buckets computed above. -->
				<div class="mb-6 flex flex-wrap items-center gap-2">
					{#if statPills.length === 0}
						<span
							class="inline-flex items-center rounded-full border border-emerald-500/30 bg-emerald-500/15 px-2.5 py-1 text-xs font-medium text-emerald-300"
						>
							All clear
						</span>
					{:else}
						{#each statPills as pill (pill.label)}
							<button
								type="button"
								onclick={() => scrollToFirstVisible(pill.targetIds)}
								class={`inline-flex cursor-pointer items-center rounded-full border px-2.5 py-1 text-xs font-medium transition hover:brightness-110 focus:ring-1 focus:ring-indigo-500/40 focus:outline-none ${STAT_TONES[pill.tone]}`}
							>
								{pill.label}
							</button>
						{/each}
					{/if}
				</div>

				{#if today.narrative}
					<section class="mb-6">
						<div class="mb-3 flex items-center gap-1.5">
							<h2 class="text-xs font-semibold tracking-wide text-fg-muted uppercase">
								What&apos;s going on
							</h2>
							<InfoTip align="left">
								The Executive&apos;s read on the company right now — synthesized from proposals,
								at-risk goals, and recent activity. Regenerates as the picture changes.
							</InfoTip>
						</div>
						<div class="rounded-xl border border-indigo-500/20 bg-indigo-500/5 px-5 py-4">
							{#each narrativeBlocks as block, i (i)}
								{#if block.kind === 'list' && onContinue}
									{@render narrativeList(block.items)}
								{:else}
									<Markdown
										source={block.kind === 'markdown' ? block.text : block.raw}
										class={NARRATIVE_PROSE_CLASS}
									/>
								{/if}
							{/each}
						</div>
					</section>
				{/if}

				{#if isQuiet && activeDepts.length > 0}
					<div
						class="mb-6 flex items-center justify-between rounded-xl border border-emerald-500/20 bg-emerald-500/5 px-4 py-3"
					>
						<span class="text-sm text-emerald-300">
							Quiet day — nothing needs your attention.
						</span>
						<a href="/departments" class="shrink-0 text-xs text-indigo-400 hover:text-indigo-300">
							Set up a check-in →
						</a>
					</div>
				{/if}

				<!-- Pulse card system — a symmetric two-column grid beneath the
				     narrative. Stacks to one column below xl, so each section
				     renders exactly once at every breakpoint (no mobile/desktop
				     duplicates). Left = action queue; right = awareness. -->
				<div class="grid gap-8 xl:grid-cols-[1.05fr_0.95fr]">
					<!-- LEFT — action queue -->
					<div class="min-w-0 space-y-8">
						<!-- Needs you — decisions routed to the caller. Primary
						     section: visually dominant so the eye lands here first.
						     Buckets (mineProposals / otherProposals / monitoring)
						     are computed once above so the status strip and these
						     lists stay in sync. -->
						<section
							id={SECTION_IDS.needsYou}
							class="rounded-xl border border-line bg-surface-elevated p-4"
						>
							<details open class="group">
								<summary
									class="mb-3 flex cursor-pointer list-none items-center gap-2 border-l-2 border-indigo-500 pl-2"
								>
									<span class="text-[10px] text-fg-muted transition-transform group-open:rotate-90">
										▸
									</span>
									{@render primaryLabel(mineProposals.length, 'Needs you')}
								</summary>
								{#if startHereProposal}
									{@const start = startHereProposal}
									<!-- Full queue inside a fixed-height scroll (like the Pulse
									     Recent activity card) — no cap, no "Show more"; the list
									     scrolls internally instead of growing the page. -->
									<div class="max-h-128 divide-y divide-line overflow-y-auto pr-1">
										<!-- Start here — the single sharpest item, emphasized
										     (indigo left accent + label) and expanded so there's
										     one obvious first move instead of a flat queue. The
										     ProposalCard supplies the row's own py-3, so this
										     wrapper adds none (avoids a double pad that would
										     break the divider-row rhythm). -->
										<div>
											<div
												class="mb-1.5 text-[10px] font-semibold tracking-wide text-indigo-300 uppercase"
											>
												Start here
											</div>
											<ProposalCard
												proposal={start}
												people={today.people}
												{onContinue}
												onApprove={handleApprove}
												onDismiss={handleDismiss}
												onApproveWithEdits={handleApproveWithEdits}
												defaultBodyExpanded
												emphasized
											/>
										</div>
										{#each showAllNeedsYou ? restProposals : restProposals.slice(0, NEEDS_YOU_VISIBLE) as p (p.alert_id)}
											<ProposalCard
												proposal={p}
												people={today.people}
												{onContinue}
												onApprove={handleApprove}
												onDismiss={handleDismiss}
												onApproveWithEdits={handleApproveWithEdits}
											/>
										{/each}
										{#if restProposals.length > NEEDS_YOU_VISIBLE}
											<button
												type="button"
												onclick={() => (showAllNeedsYou = !showAllNeedsYou)}
												class="w-full cursor-pointer py-2 text-[11px] text-fg-muted transition-colors hover:text-fg"
											>
												{showAllNeedsYou
													? 'Show fewer'
													: `Show ${restProposals.length - NEEDS_YOU_VISIBLE} more`}
											</button>
										{/if}
									</div>
								{:else if !isQuiet}
									<p class="py-3 text-sm text-fg-muted">Nothing waiting on you.</p>
								{/if}
								<!-- Relief valves: clear the old tail in one click, or ask the
								     Executive to re-judge everything right now. -->
								{#if staleNeedsYouIds.length > 0 || mineProposals.length > 0}
									<div class="mt-2 flex flex-wrap items-center gap-3">
										{#if staleNeedsYouIds.length > 0}
											<button
												type="button"
												onclick={() => handleBulkDismiss(staleNeedsYouIds)}
												class="cursor-pointer text-[11px] text-fg-muted transition-colors hover:text-rose-300"
											>
												{`✕ Dismiss ${staleNeedsYouIds.length} older than ${NEEDS_YOU_DISMISS_OLDER_THAN_DAYS} days`}
											</button>
										{/if}
										<button
											type="button"
											onclick={handleRecheck}
											disabled={recheckBusy}
											class="cursor-pointer text-[11px] text-fg-muted transition-colors hover:text-indigo-300 disabled:opacity-50"
										>
											{recheckBusy ? '⟳ Re-checking…' : '⟳ Re-check relevance'}
										</button>
									</div>
								{/if}
							</details>
						</section>

						{#if otherProposals.length > 0}
							<section class="rounded-xl border border-line bg-surface-elevated p-4">
								{@render sectionHeading('Across the team', otherProposals.length, null)}
								<div class="max-h-128 divide-y divide-line overflow-y-auto pr-1">
									{#each otherProposals as p (p.alert_id)}
										<ProposalCard
											proposal={p}
											people={today.people}
											{onContinue}
											onApprove={handleApprove}
											onDismiss={handleDismiss}
											onApproveWithEdits={handleApproveWithEdits}
										/>
									{/each}
								</div>
							</section>
						{/if}
					</div>

					<!-- RIGHT — awareness (org health + ambient signals) -->
					<div class="min-w-0 space-y-8">
						<!-- Departments — only those needing attention get a row; healthy
						     + inactive ones fold into one quiet toggle. -->
						<section
							id={SECTION_IDS.departments}
							class="rounded-xl border border-line bg-surface-elevated p-4"
						>
							<div class="mb-3 flex items-center justify-between">
								<div class="flex items-center gap-1.5">
									{@render ambientLabel(null, 'Departments')}
									<InfoTip align="left">
										<span class="text-amber-300">At risk</span>
										<span>/</span>
										<span class="text-rose-300">off track</span>
										<span>= goal health.</span>
										<span class="text-sky-300">Awaiting</span>
										<span>= items waiting on the department head.</span>
										<span class="text-fg">Inactive</span>
										<span>= no goals or check-ins set up yet.</span>
									</InfoTip>
								</div>
								<a href="/departments" class="text-xs text-indigo-400 hover:text-indigo-300">
									View all →
								</a>
							</div>

							{#if activeDepts.length === 0}
								<div class="py-3">
									<p class="mb-2 text-sm text-fg-muted">No department has a check-in set up yet.</p>
									<a href="/departments" class="text-xs text-indigo-400 hover:text-indigo-300">
										Pick one to activate →
									</a>
								</div>
							{/if}

							<!-- Attention departments (full, no cap) + the quiet toggle all
							     share one fixed-height scroll, like the Pulse cards — the
							     section never grows the page. -->
							{#if attentionDepts.length > 0 || quietDeptCount > 0}
								<div class="max-h-128 overflow-y-auto pr-1">
									{#if attentionDepts.length > 0}
										<div class="divide-y divide-line">
											{#each attentionDepts as dept (dept.slug)}
												{@render deptCard(dept)}
											{/each}
										</div>
									{/if}

									<!-- One quiet toggle for the rest — on-track and inactive
									     departments revealed together in a single column. -->
									{#if quietDeptCount > 0}
										<div class={attentionDepts.length > 0 ? 'mt-3' : ''}>
											<button
												type="button"
												onclick={() => (showAllDeptsOpen = !showAllDeptsOpen)}
												aria-expanded={showAllDeptsOpen}
												class="flex min-h-11 cursor-pointer items-center gap-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
											>
												<span aria-hidden="true">
													{showAllDeptsOpen ? '▲' : '▼'}
												</span>
												{quietDeptSummary}
											</button>
											{#if showAllDeptsOpen}
												<div class="mt-3 divide-y divide-line">
													{#each onTrackDepts as dept (dept.slug)}
														{@render deptCard(dept)}
													{/each}
													{#each inactiveDepts as dept (dept.slug)}
														{@render deptCard(dept, true)}
													{/each}
												</div>
											{/if}
										</div>
									{/if}
								</div>
							{/if}
						</section>

						<!-- People — full roster, scrolling inside the card. -->
						{#if showPeopleSidebar}
							{@const summary = peopleSummary(today.people)}
							<section
								id={SECTION_IDS.people}
								class="rounded-xl border border-line bg-surface-elevated p-4"
							>
								<div class="mb-3 flex items-start justify-between gap-2">
									<div>
										<h3 class="text-sm font-semibold text-fg">People</h3>
										<p
											class={`mt-0.5 text-xs ${summary.hasOverdue ? 'text-rose-300' : 'text-fg-muted'}`}
										>
											{summary.text}
										</p>
									</div>
									<a href="/people" class="shrink-0 text-xs text-indigo-400 hover:text-indigo-300">
										View all
									</a>
								</div>
								<div class="max-h-128 divide-y divide-line overflow-y-auto pr-1">
									{#each today.people as person (person.id)}
										{@render personRow(person)}
									{/each}
								</div>
							</section>
						{/if}

						<!-- Ambient — In flight (commitments with run times) and Monitoring
						     (live signals). Both render once; each is its own Pulse card. -->
						{@render inFlightPanel(today.in_flight ?? [], SECTION_IDS.inFlight)}
						{@render talentPanel(today.talent ?? [], SECTION_IDS.talent)}
						{@render onboardingPanel(today.onboarding ?? [], SECTION_IDS.onboarding)}
						{@render practiceClientsPanel(today.practice_clients ?? [], SECTION_IDS.practice)}
						{@render handledPanel(handledOvernight)}
						{@render monitoringPanel(monitoringProposals, SECTION_IDS.monitoring)}
					</div>
				</div>
			{/if}
		</div>
	</main>
</div>

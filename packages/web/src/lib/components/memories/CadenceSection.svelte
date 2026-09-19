<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons.js';
	import type { ActivityItem, ScheduledAction } from '$lib/api.js';
	import { getActivity, listScheduledActions } from '$lib/api.js';
	import {
		STATUS_PILL,
		TAG_TONE,
		formatRunAt,
		groupByRhythm,
		metaFor,
		type TagTone
	} from './shared.svelte.js';

	// The "how it runs" half of the Pulse page. The rhythm taxonomy (KIND_META /
	// metaFor / groupByRhythm) lives in ./shared so the header stat strip and
	// these cards agree on how raw scheduled_actions `kind`s map to human groups.
	//
	// The rhythm card shows the *pending* queue only (the upcoming cadence),
	// fetched soonest-first. Follow-ups (ad_hoc one-offs) live in their own card
	// on the Pulse page (PulsePage.svelte), rendered under Memory.

	// Over-fetch cap. The backend can't filter by `kind`, so we pull a generous
	// slice and group client-side; high-frequency system scans are capped at render
	// time (see SystemPulse) so they can't bury the user-facing groups.
	const FETCH_LIMIT = 500;

	let rows = $state.raw<ScheduledAction[]>([]);
	let loading = $state(true);

	async function refresh(signal?: AbortSignal) {
		loading = true;
		try {
			// Pending only — the upcoming cadence, soonest-first.
			const data = await listScheduledActions('pending', FETCH_LIMIT, signal, 'asc');
			if (!signal?.aborted) rows = data;
		} catch (err) {
			if ((err as Error)?.name === 'AbortError') return;
			if (!signal?.aborted) rows = [];
		} finally {
			if (!signal?.aborted) loading = false;
		}
	}

	onMount(() => {
		const controller = new AbortController();
		void refresh(controller.signal);
		return () => controller.abort();
	});

	// groupByRhythm sorts each group soonest-first and deliberately drops ad_hoc
	// (those are the Follow-ups, now their own card under Memory).
	const groups = $derived(groupByRhythm(rows));

	// Whether any rhythm group has rows to show. We gate the empty-state on this
	// rather than `rows.length`, because `rows` still contains the ad_hoc
	// follow-ups (dropped by groupByRhythm) — without this, a queue of only
	// follow-ups would render an empty padded card instead of the empty message.
	const hasRhythm = $derived(
		groups.daily.length > 0 ||
			groups.departments.length > 0 ||
			groups.awaiting.length > 0 ||
			groups.system.length > 0
	);

	// ---------------------------------------------------------------------------
	// Recent activity — the literal heartbeat. A live timeline of the most recent
	// self-initiated actions (reuses GET /today/activity). Independent of the
	// status filter — it's always the live "what just happened" feed.
	// ---------------------------------------------------------------------------

	// One-line verb + subject for an activity item — the `kind` decides the verb;
	// `subject` names who/what it was directed at. Ported from the Briefing rail
	// (now removed) so the Pulse shows the same rich rows. The full summary is
	// always rendered as the body, so no information is lost.
	function activityLine(item: ActivityItem): { verb: string; subject: string } {
		switch (item.kind) {
			case 'dm_sent':
				return { verb: "DM'd", subject: item.target ?? 'a colleague' };
			case 'email_sent':
				return { verb: 'emailed', subject: item.target ?? 'a colleague' };
			case 'nudge_sent':
				return { verb: 'nudged', subject: item.target ?? 'a stalled item' };
			case 'cadence_sent':
				return { verb: 'ran cadence for', subject: item.department ?? 'a department' };
			case 'workflow_resumed':
				return { verb: 'resumed workflow with', subject: item.target ?? 'someone' };
			case 'proposal_routed':
				// propose_only path — backend marked the action done without dispatching,
				// so describe the intent ("proposed to X") rather than implying a send.
				return { verb: 'proposed to', subject: item.target ?? 'an approver' };
			case 'decision_logged':
				return { verb: 'logged decision:', subject: item.summary };
			case 'advice_given':
				return { verb: 'advised on', subject: item.summary };
			case 'workflow_done':
				return { verb: 'completed', subject: item.summary };
			case 'initiative_started':
				return { verb: 'kicked off initiative:', subject: item.summary };
			case 'decision_resolved':
				return { verb: 'resolved decision:', subject: item.summary };
			case 'alert_raised':
				return { verb: 'raised alert:', subject: item.summary };
			default:
				return { verb: 'acted on', subject: item.summary };
		}
	}

	// Kinds whose `subject` IS the full summary: the body row renders the text, so
	// the inline subject span is suppressed to avoid repeating it (only the verb
	// shows inline). Kept beside activityLine so adding a kind is a one-place edit.
	const SUMMARY_KINDS = new Set([
		'decision_logged',
		'advice_given',
		'action',
		'workflow_done',
		'initiative_started',
		'decision_resolved',
		'alert_raised'
	]);

	// Live activity refreshes on this cadence so new events stream into the feed
	// without a reload (mirrors the departments page poll). Kept modest — the feed
	// is read-only and the payload is small.
	const ACTIVITY_POLL_INTERVAL_MS = 20_000;

	const SYSTEM_PULSE_CAP = 50;

	let activityItems = $state.raw<ActivityItem[]>([]);
	let activityLoading = $state(true);

	onMount(() => {
		let cancelled = false;

		// The Pulse is the single home for recent activity (removed from the
		// Briefing), so pull a generous slice (the list scrolls internally) and
		// then refresh on an interval so the feed stays live.
		const load = () => {
			void getActivity(100)
				.then((res) => {
					if (!cancelled) activityItems = res.items;
				})
				.catch(() => {
					// Swallow transient errors — keep the last good list and let the
					// next tick retry rather than blanking the feed.
				})
				.finally(() => {
					// Only the first load drives the skeleton; interval refreshes update
					// silently so the feed doesn't flash on every tick.
					if (!cancelled) activityLoading = false;
				});
		};

		load();
		const interval = window.setInterval(load, ACTIVITY_POLL_INTERVAL_MS);
		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	});
</script>

{#snippet skeleton(className: string)}
	<div
		class={`animate-pulse rounded-md bg-surface-input/60 motion-reduce:animate-none ${className}`}
		aria-hidden="true"
	></div>
{/snippet}

{#snippet livePulse()}
	<span class="inline-flex items-center gap-1.5">
		<span class="relative flex h-2 w-2" aria-hidden="true">
			<span
				class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75 motion-reduce:hidden"
			></span>
			<span class="relative inline-flex h-2 w-2 rounded-full bg-emerald-400"></span>
		</span>
		<span class="text-[11px] font-medium tracking-wide text-emerald-300 uppercase">Live</span>
	</span>
{/snippet}

{#snippet tag(label: string, tone: TagTone)}
	<span class={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${TAG_TONE[tone]}`}
		>{label}</span
	>
{/snippet}

{#snippet sectionHeading(
	title: string,
	count: number | null,
	icon: IconName | null,
	tagLabel: string | null,
	tagTone: TagTone,
	subtitle: string | null
)}
	<div class="mb-3">
		<div class="flex flex-wrap items-center gap-2">
			{#if icon}
				<Icon name={icon} size="w-4 h-4" class="text-fg-subtle" />
			{/if}
			<h3 class="text-sm font-semibold text-fg">{title}</h3>
			{#if count != null}
				<span class="text-xs font-normal text-fg-subtle tabular-nums">{count}</span>
			{/if}
			{#if tagLabel}
				{@render tag(tagLabel, tagTone)}
			{/if}
		</div>
		{#if subtitle}
			<p class="mt-0.5 text-xs text-fg-muted">{subtitle}</p>
		{/if}
	</div>
{/snippet}

{#snippet recentActivity()}
	{#if activityLoading}
		<div class="space-y-2 rounded-xl border border-line bg-surface-elevated p-4">
			{@render skeleton('h-4 w-32')}
			{@render skeleton('h-4 w-full')}
			{@render skeleton('h-4 w-5/6')}
		</div>
	{:else if activityItems.length > 0}
		<div class="rounded-xl border border-line bg-surface-elevated p-4">
			<div class="mb-3 flex items-center justify-between gap-2">
				<div class="flex items-center gap-2">
					<Icon name="activity" size="w-4 h-4" class="text-emerald-400" />
					<h3 class="text-sm font-semibold text-fg">Recent activity</h3>
				</div>
				{@render livePulse()}
			</div>
			<!-- Fixed-height scroll region so the feed scrolls internally instead of
			     growing the page. The timeline line lives on the inner <ol> (sized to
			     the full list) so it scrolls with the rows rather than clipping. -->
			<div class="max-h-[32rem] overflow-y-auto pr-1">
				<ol
					class="relative space-y-3 before:absolute before:top-1.5 before:bottom-1.5 before:left-[3px] before:w-px before:bg-line"
				>
					{#each activityItems as it, i (it.at + '-' + it.kind + '-' + i)}
						{@const relative = formatRunAt(it.at).relative}
						{@const line = activityLine(it)}
						<!-- For summary-style kinds the subject IS the summary, so don't
						     repeat it inline — the body row below carries the text. -->
						{@const subjectIsSummary = SUMMARY_KINDS.has(it.kind)}
						<li class="relative pl-5">
							<span
								class="absolute top-1.5 left-0 h-[7px] w-[7px] rounded-full bg-emerald-400/80 ring-2 ring-surface-elevated"
								aria-hidden="true"
							></span>
							<div class="flex flex-wrap items-baseline gap-2">
								{#if relative}
									<span class="text-[11px] text-fg-subtle tabular-nums">{relative}</span>
								{/if}
								<span class="text-xs text-fg-muted">{line.verb}</span>
								{#if !subjectIsSummary}
									<span class="text-xs text-fg" title={line.subject}>{line.subject}</span>
								{/if}
								{#if it.department}
									<span class="ml-auto hidden text-[10px] text-fg-subtle sm:inline">
										{it.department}
									</span>
								{/if}
							</div>
							{#if it.summary}
								<p
									class="mt-0.5 line-clamp-2 text-xs leading-snug break-words text-fg-muted"
									title={it.summary}
								>
									{it.summary}
								</p>
							{/if}
						</li>
					{/each}
				</ol>
			</div>
		</div>
	{/if}
{/snippet}

{#snippet rhythmCard(action: ScheduledAction, showDepartment: boolean)}
	{@const meta = metaFor(action)}
	{@const run = formatRunAt(action.run_at)}
	<div
		class="group flex items-start justify-between gap-3 py-2.5 transition-colors hover:bg-surface-overlay/30"
	>
		<div class="min-w-0">
			<div class="flex flex-wrap items-center gap-2">
				<span class="text-sm font-medium text-fg" title={meta.label}>{meta.label}</span>
				{#if showDepartment && action.department}
					<span
						class="rounded bg-surface-overlay px-2 py-0.5 text-[11px] font-medium text-fg capitalize"
					>
						{action.department}
					</span>
				{/if}
			</div>
			{#if meta.blurb}
				<div class="mt-0.5 line-clamp-2 text-xs text-fg-muted" title={meta.blurb}>
					{meta.blurb}
				</div>
			{/if}
			{#if action.last_error && action.status === 'failed'}
				<div class="mt-1 font-mono text-xs break-words text-red-400">{action.last_error}</div>
			{/if}
		</div>
		<div class="shrink-0 text-right whitespace-nowrap">
			{#if action.status === 'pending'}
				<div class="text-xs text-sky-300" title={run.absolute}>
					{run.relative ? `next ${run.relative}` : run.absolute}
				</div>
			{:else}
				<div class="flex flex-col items-end gap-1">
					<span
						class={`rounded border px-2 py-0.5 text-[10px] font-medium capitalize ${STATUS_PILL[action.status] ?? STATUS_PILL.cancelled}`}
					>
						{action.status}
					</span>
					<span class="text-xs text-fg-subtle" title={run.absolute}>
						{run.relative || run.absolute}
					</span>
				</div>
			{/if}
		</div>
	</div>
{/snippet}

{#snippet rhythmBlock(
	title: string,
	subtitle: string,
	icon: IconName,
	tagLabel: string | null,
	tagTone: TagTone,
	actions: ScheduledAction[],
	showDepartment: boolean
)}
	{#if actions.length > 0}
		<section>
			{@render sectionHeading(title, actions.length, icon, tagLabel, tagTone, subtitle)}
			<div class="divide-y divide-line">
				{#each actions as a (a.id)}
					{@render rhythmCard(a, showDepartment)}
				{/each}
			</div>
		</section>
	{/if}
{/snippet}

{#snippet systemPulse(actions: ScheduledAction[])}
	{#if actions.length > 0}
		{@const shown = actions.slice(0, SYSTEM_PULSE_CAP)}
		{@const hidden = actions.length - shown.length}
		<section>
			{@render sectionHeading(
				'System pulse',
				actions.length,
				'activity',
				'Internal · continuous',
				'muted',
				'Background scans that run every few minutes to keep the Executive aware of change. Nothing here is sent to you — findings surface later as proposals or nudges.'
			)}
			<div class="divide-y divide-line">
				{#each shown as a (a.id)}
					{@render rhythmCard(a, false)}
				{/each}
			</div>
			{#if hidden > 0}
				<div class="mt-2 text-xs text-fg-subtle">+{hidden} more not shown</div>
			{/if}
		</section>
	{/if}
{/snippet}

<div class="space-y-8">
	{@render recentActivity()}

	<div class="rounded-xl border border-line bg-surface-elevated p-4">
		{#if loading}
			<div class="space-y-2">
				{@render skeleton('h-16 w-full')}
				{@render skeleton('h-16 w-full')}
			</div>
		{:else if !hasRhythm}
			<div
				class="rounded-lg border border-line bg-surface-elevated/40 px-4 py-6 text-sm text-fg-muted"
			>
				No recurring cadence is scheduled yet. The heartbeat starts once the scheduler is running
				and a company profile is set.
			</div>
		{:else}
			<div class="max-h-[32rem] space-y-6 overflow-y-auto pr-1">
				{@render rhythmBlock(
					'Daily rhythm',
					'Your daily briefing cycle — the morning brief and end-of-day digest land in your inbox; the reflection sets up the morning brief.',
					'clipboard',
					'Once a day · for you',
					'info',
					groups.daily,
					false
				)}
				{@render rhythmBlock(
					'Department check-ins',
					"Each team's cadence — the next scheduled check-in per department.",
					'grid',
					null,
					'muted',
					groups.departments,
					true
				)}
				{@render rhythmBlock(
					'Awaiting people',
					'Paused workflows and nudges waiting on a reply.',
					'bell',
					null,
					'muted',
					groups.awaiting,
					false
				)}
				{@render systemPulse(groups.system)}
			</div>
		{/if}
	</div>
</div>

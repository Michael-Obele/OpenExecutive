<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons.js';
	import type { ScheduledAction } from '$lib/api.js';
	import { cancelScheduledAction, listScheduledActions } from '$lib/api.js';
	import { STATUS_PILL, TAG_TONE, formatRunAt, type TagTone } from './shared.svelte.js';
	import CadenceSection from './CadenceSection.svelte';
	import MemorySection from './MemorySection.svelte';
	import PulseHeader from './PulseHeader.svelte';

	// The Pulse page is the Executive's memory + heartbeat: what it knows
	// (durable episodic memory) and the rhythm it runs on (recurring briefs,
	// reflections, department check-ins, and internal scans). Both halves are
	// built from data that already exists — episodic memory rows and the
	// scheduled_actions queue grouped by `kind`.
	//
	// Layout: an at-a-glance header (stat strip + heartbeat heatmap) spans the
	// full width, then Cadence ("Heartbeat") and Memory ("What it knows") sit
	// side by side on wide screens and stack on smaller ones.

	// Over-fetch cap, matching CadenceSection: the backend can't filter by `kind`.
	const FETCH_LIMIT = 500;
	const ACTIVITY_CARD_SKELETON = ['h-4 w-32', 'h-16 w-full'];

	// ---------------------------------------------------------------------------
	// Follow-ups — one-off ad_hoc commitments, surfaced as their own card under
	// Memory on the Pulse page. Upstream this was a second component exported from
	// CadenceSection.tsx; a Svelte file holds exactly one component, so it lives
	// here (the only place that renders it) with its state in this scope.
	// Self-contained: fetches the pending queue itself (independent of the rhythm
	// card) and owns the per-row cancel. Hidden when there are no pending
	// follow-ups, like the rhythm blocks.
	// ---------------------------------------------------------------------------

	let rows = $state.raw<ScheduledAction[]>([]);
	let loading = $state(true);
	let cancellingId = $state<number | null>(null);

	// `loading` is only ever true for the first load (initial state). Refetches
	// (after a cancel) deliberately DON'T flip it back to true, so the list stays
	// visible and the cancelled row just drops out when fresh data arrives —
	// rather than flashing a skeleton mid-cancel.
	async function refresh(signal?: AbortSignal) {
		try {
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

	async function handleCancel(id: number) {
		if (!confirm("Cancel this follow-up? It won't fire.")) return;
		cancellingId = id;
		try {
			await cancelScheduledAction(id);
		} catch (err) {
			alert(err instanceof Error ? err.message : 'Failed to cancel.');
			cancellingId = null;
			return;
		}
		cancellingId = null;
		await refresh();
	}

	// ad_hoc one-offs, soonest-first (groupByRhythm deliberately drops these).
	const followups = $derived(
		rows.filter((r) => r.kind === 'ad_hoc').sort((a, b) => a.run_at.localeCompare(b.run_at))
	);
</script>

{#snippet skeleton(className: string)}
	<div
		class={`animate-pulse rounded-md bg-surface-input/60 motion-reduce:animate-none ${className}`}
		aria-hidden="true"
	></div>
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
		</div>
		{#if subtitle}
			<p class="mt-0.5 text-xs text-fg-muted">{subtitle}</p>
		{/if}
	</div>
{/snippet}

{#snippet followUpRow(action: ScheduledAction, cancelling: boolean)}
	{@const run = formatRunAt(action.run_at)}
	{@const pill = STATUS_PILL[action.status] ?? STATUS_PILL.cancelled}
	<div class="group py-3 transition-colors hover:bg-surface-overlay/30">
		<div class="mb-2 flex items-start justify-between gap-3">
			<div class="flex min-w-0 flex-wrap items-center gap-2 text-xs text-fg-muted">
				<span class={`rounded border px-2 py-0.5 font-medium capitalize ${pill}`}>
					{action.status}
				</span>
				<span class="rounded bg-surface-overlay px-2 py-0.5 font-medium text-fg">
					{action.channel}
				</span>
				<span class="text-fg-subtle">→</span>
				<span
					class="max-w-[12rem] truncate font-mono text-[11px] text-fg-muted"
					title={action.channel_ref}>{action.channel_ref}</span
				>
				<span title={run.absolute}>{run.relative || run.absolute}</span>
				{#if action.attempts > 0}
					<span class="text-amber-400"
						>{action.attempts} attempt{action.attempts === 1 ? '' : 's'}</span
					>
				{/if}
			</div>
			{#if action.status === 'pending'}
				<button
					type="button"
					onclick={() => void handleCancel(action.id)}
					disabled={cancelling}
					class="shrink-0 text-xs text-red-400 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100 hover:text-red-300 disabled:opacity-50"
				>
					{cancelling ? 'Cancelling…' : 'Cancel'}
				</button>
			{/if}
		</div>
		<div class="line-clamp-2 text-sm break-words text-fg" title={action.intent_text}>
			{action.intent_text}
		</div>
		{#if action.last_error}
			<div
				class="mt-2 line-clamp-2 font-mono text-xs break-words text-red-400"
				title={action.last_error}
			>
				{action.last_error}
			</div>
		{/if}
		{#if action.originating_session_id}
			<div
				class="mt-2 truncate font-mono text-[11px] text-fg-subtle"
				title={`session: ${action.originating_session_id}`}
			>
				session: {action.originating_session_id}
			</div>
		{/if}
	</div>
{/snippet}

<div class="mx-auto max-w-6xl space-y-10 px-6 py-8">
	<PulseHeader />

	<!-- `min-w-0` on each grid child: fr tracks default to min-width:auto, so
	     a long unbreakable line (e.g. an activity summary) would otherwise
	     force the track — and the whole page — wider than the viewport. -->
	<div class="grid gap-8 xl:grid-cols-[1.05fr_0.95fr]">
		<section class="min-w-0">
			<h2
				class="mb-4 flex items-center gap-2 text-xs font-semibold tracking-wide text-fg-subtle uppercase"
			>
				Heartbeat — the rhythm it runs on
			</h2>
			<CadenceSection />
		</section>

		<section class="min-w-0 space-y-8">
			<div>
				<h2 class="mb-4 text-xs font-semibold tracking-wide text-fg-subtle uppercase">
					Memory — what it knows
				</h2>
				<MemorySection />
			</div>

			{#if loading}
				<div class="space-y-2 rounded-xl border border-line bg-surface-elevated p-4">
					{#each ACTIVITY_CARD_SKELETON as cls (cls)}
						{@render skeleton(cls)}
					{/each}
				</div>
			{:else if followups.length > 0}
				<div class="rounded-xl border border-line bg-surface-elevated p-4">
					{@render sectionHeading(
						'Follow-ups',
						followups.length,
						'flag',
						'One-off commitments the Executive scheduled for you.'
					)}
					<div class="max-h-[32rem] divide-y divide-line overflow-y-auto pr-1">
						{#each followups as a (a.id)}
							{@render followUpRow(a, cancellingId === a.id)}
						{/each}
					</div>
				</div>
			{/if}
		</section>
	</div>
</div>

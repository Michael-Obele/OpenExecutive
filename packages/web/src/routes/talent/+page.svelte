<script lang="ts">
	import { onMount } from 'svelte';
	import type { Candidate, Engagement } from '$lib/api.js';
	import { listCandidates, listEngagements } from '$lib/api.js';
	import CandidateCard from '$lib/components/talent/CandidateCard.svelte';
	import { PIPELINE_STAGES, STAGE_META } from '$lib/components/talent/stages.js';

	let candidates = $state.raw<Candidate[]>([]);
	let engagements = $state.raw<Engagement[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let engagementFilter = $state('');

	onMount(() => {
		void Promise.all([listCandidates(), listEngagements()])
			.then(([c, e]) => {
				candidates = c;
				engagements = e;
			})
			.catch((err) => (error = err instanceof Error ? err.message : 'Failed to load'))
			.finally(() => (loading = false));
	});

	let filtered = $derived(
		engagementFilter
			? candidates.filter((c) => c.engagement_id === Number(engagementFilter))
			: candidates
	);

	let byStage = $derived.by(() => {
		const map: Record<string, Candidate[]> = {};
		for (const c of filtered) (map[c.stage] ??= []).push(c);
		return map;
	});

	let rejected = $derived(byStage['rejected'] ?? []);
</script>

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-7xl px-4 py-8 sm:px-6">
		<div class="mb-6 flex flex-wrap items-baseline justify-between gap-4">
			<div>
				<h1 class="text-xl font-semibold text-fg">Talent Pipeline</h1>
				<p class="mt-0.5 text-sm text-fg-muted">
					Candidates across all searches, by stage. Manage open roles under
					<a href="/talent/searches" class="text-indigo-300 hover:text-indigo-200">Searches</a>.
				</p>
			</div>
			<div class="flex items-center gap-2">
				<select
					bind:value={engagementFilter}
					aria-label="Filter candidates by engagement"
					class="rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
				>
					<option value="">All engagements</option>
					{#each engagements as e (e.id)}
						<option value={String(e.id)}>{e.role_title}</option>
					{/each}
				</select>
				<a
					href="/talent/searches"
					class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
				>
					Searches →
				</a>
			</div>
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
		{#if !loading && !error && candidates.length === 0}
			<div class="rounded-xl border border-line bg-surface-elevated p-8 text-center">
				<p class="mb-3 text-sm text-fg-muted">No candidates yet.</p>
				<a
					href="/talent/searches"
					class="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500"
				>
					Open a search →
				</a>
			</div>
		{/if}

		{#if !loading && !error && candidates.length > 0}
			<div class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
				{#each PIPELINE_STAGES as stage (stage)}
					{@const items = byStage[stage] ?? []}
					<div class="flex flex-col">
						<div class="mb-2 flex items-center justify-between px-1">
							<span class="text-xs font-semibold tracking-wide text-fg-muted uppercase">
								{STAGE_META[stage].label}
							</span>
							<span class="text-xs text-fg-subtle tabular-nums">{items.length}</span>
						</div>
						<div class="space-y-2">
							{#each items as c (c.id)}
								<CandidateCard candidate={c} />
							{/each}
							{#if items.length === 0}
								<div
									class="rounded-xl border border-dashed border-line p-4 text-center text-[11px] text-fg-subtle"
								>
									None
								</div>
							{/if}
						</div>
					</div>
				{/each}
			</div>

			{#if rejected.length > 0}
				<div class="mt-8">
					<div class="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
						Rejected ({rejected.length})
					</div>
					<div class="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
						{#each rejected as c (c.id)}
							<CandidateCard candidate={c} />
						{/each}
					</div>
				</div>
			{/if}
		{/if}
	</div>
</main>

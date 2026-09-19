<script lang="ts">
	import { onMount } from 'svelte';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import type { Advice, Decision, Initiative } from '$lib/api.js';
	import {
		deleteAdvice,
		deleteDecision,
		deleteInitiative,
		listAdvice,
		listDecisions,
		listInitiatives,
		updateAdvice,
		updateDecision,
		updateInitiative
	} from '$lib/api.js';
	import { DOMAINS, STATUSES, formatDate } from './shared.svelte.js';

	type MemoryTab = 'decisions' | 'initiatives' | 'advice';

	const MEMORY_TABS: MemoryTab[] = ['decisions', 'initiatives', 'advice'];

	const MEMORY_EMPTY = "No memories yet — they're extracted automatically after chats.";

	// ---------------------------------------------------------------------------
	// Section shell — the "what it knows" half of the Pulse page.
	//
	// Upstream kept all three tabs mounted (and threaded stable `onCount`
	// callbacks) purely so every tab badge could load up front. Here the three
	// lists are owned by this component and fetched on mount, so the badges are
	// derived and load up front without React's always-mounted workaround.
	// ---------------------------------------------------------------------------

	let tab = $state<MemoryTab>('decisions');

	let decisions = $state.raw<Decision[]>([]);
	let decisionsLoading = $state(true);
	let editingDecisionId = $state<number | null>(null);
	let decisionDraft = $state({ domain: '', summary: '', rationale: '', outcome: '', tags: '' });

	let initiatives = $state.raw<Initiative[]>([]);
	let initiativesLoading = $state(true);
	let editingInitiativeId = $state<number | null>(null);
	let initiativeDraft = $state({ title: '', status: '', summary: '' });

	let adviceItems = $state.raw<Advice[]>([]);
	let adviceLoading = $state(true);
	let editingAdviceId = $state<number | null>(null);
	let adviceDraft = $state({ domain: '', query_summary: '', advice_summary: '' });

	// A tab badge only renders once its list has loaded (upstream's `null` count).
	const counts: Record<MemoryTab, number | null> = $derived({
		decisions: decisionsLoading ? null : decisions.length,
		initiatives: initiativesLoading ? null : initiatives.length,
		advice: adviceLoading ? null : adviceItems.length
	});

	async function refreshDecisions() {
		decisionsLoading = true;
		try {
			decisions = await listDecisions();
		} finally {
			decisionsLoading = false;
		}
	}

	async function refreshInitiatives() {
		initiativesLoading = true;
		try {
			initiatives = await listInitiatives();
		} finally {
			initiativesLoading = false;
		}
	}

	async function refreshAdvice() {
		adviceLoading = true;
		try {
			adviceItems = await listAdvice();
		} finally {
			adviceLoading = false;
		}
	}

	onMount(() => {
		void refreshDecisions();
		void refreshInitiatives();
		void refreshAdvice();
	});

	// ---------------------------------------------------------------------------
	// Decisions
	// ---------------------------------------------------------------------------

	function startEditDecision(d: Decision) {
		editingDecisionId = d.id;
		decisionDraft = {
			domain: d.domain,
			summary: d.summary,
			rationale: d.rationale,
			outcome: d.outcome,
			tags: d.tags
		};
	}

	async function saveDecision(id: number) {
		try {
			await updateDecision(id, { ...decisionDraft });
		} catch {
			alert('Failed to save.');
			return;
		}
		editingDecisionId = null;
		void refreshDecisions();
	}

	async function removeDecision(id: number) {
		if (!confirm('Delete this memory? This cannot be undone.')) return;
		try {
			await deleteDecision(id);
		} catch {
			alert('Failed to delete.');
			return;
		}
		void refreshDecisions();
	}

	// ---------------------------------------------------------------------------
	// Initiatives
	// ---------------------------------------------------------------------------

	function startEditInitiative(it: Initiative) {
		editingInitiativeId = it.id;
		initiativeDraft = { title: it.title, status: it.status, summary: it.summary };
	}

	async function saveInitiative(id: number) {
		try {
			await updateInitiative(id, { ...initiativeDraft });
		} catch {
			alert('Failed to save.');
			return;
		}
		editingInitiativeId = null;
		void refreshInitiatives();
	}

	async function removeInitiative(id: number) {
		if (!confirm('Delete this memory? This cannot be undone.')) return;
		try {
			await deleteInitiative(id);
		} catch {
			alert('Failed to delete.');
			return;
		}
		void refreshInitiatives();
	}

	// ---------------------------------------------------------------------------
	// Advice
	// ---------------------------------------------------------------------------

	function startEditAdvice(a: Advice) {
		editingAdviceId = a.id;
		adviceDraft = {
			domain: a.domain,
			query_summary: a.query_summary,
			advice_summary: a.advice_summary
		};
	}

	async function saveAdvice(id: number) {
		try {
			await updateAdvice(id, { ...adviceDraft });
		} catch {
			alert('Failed to save.');
			return;
		}
		editingAdviceId = null;
		void refreshAdvice();
	}

	async function removeAdvice(id: number) {
		if (!confirm('Delete this memory? This cannot be undone.')) return;
		try {
			await deleteAdvice(id);
		} catch {
			alert('Failed to delete.');
			return;
		}
		void refreshAdvice();
	}
</script>

{#snippet emptyState(message: string)}
	<div class="py-16 text-center text-sm text-fg-muted">{message}</div>
{/snippet}

{#snippet decisionRow(decision: Decision)}
	{@const editing = editingDecisionId === decision.id}
	<div class="group py-3 transition-colors hover:bg-surface-overlay/30">
		<div class="mb-2 flex items-start justify-between gap-3">
			<div class="flex items-center gap-2 text-xs text-fg-muted">
				<span class="rounded bg-surface-overlay px-2 py-0.5 font-medium text-fg"
					>{editing ? decisionDraft.domain : decision.domain}</span
				>
				<span>{formatDate(decision.timestamp)}</span>
			</div>
			{#if !editing}
				<div
					class="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
				>
					<button
						type="button"
						onclick={() => startEditDecision(decision)}
						class="text-xs text-fg-muted hover:text-fg"
					>
						Edit
					</button>
					<button
						type="button"
						onclick={() => void removeDecision(decision.id)}
						class="text-xs text-red-400 hover:text-red-300"
					>
						Delete
					</button>
				</div>
			{/if}
		</div>
		{#if editing}
			<div class="space-y-2">
				<label class="sr-only" for={`decision-domain-${decision.id}`}>Domain</label>
				<select
					id={`decision-domain-${decision.id}`}
					value={decisionDraft.domain}
					onchange={(e) => (decisionDraft.domain = e.currentTarget.value)}
					class="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
				>
					{#each DOMAINS as d (d)}
						<option value={d}>{d}</option>
					{/each}
				</select>
				<label class="sr-only" for={`decision-summary-${decision.id}`}>Summary</label>
				<input
					id={`decision-summary-${decision.id}`}
					type="text"
					value={decisionDraft.summary}
					oninput={(e) => (decisionDraft.summary = e.currentTarget.value)}
					placeholder="Summary"
					class="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
				/>
				<label class="sr-only" for={`decision-rationale-${decision.id}`}>Rationale</label>
				<textarea
					id={`decision-rationale-${decision.id}`}
					value={decisionDraft.rationale}
					oninput={(e) => (decisionDraft.rationale = e.currentTarget.value)}
					placeholder="Rationale"
					rows={2}
					class="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
				></textarea>
				<label class="sr-only" for={`decision-outcome-${decision.id}`}>Outcome</label>
				<input
					id={`decision-outcome-${decision.id}`}
					type="text"
					value={decisionDraft.outcome}
					oninput={(e) => (decisionDraft.outcome = e.currentTarget.value)}
					placeholder="Outcome"
					class="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
				/>
				<label class="sr-only" for={`decision-tags-${decision.id}`}>Tags</label>
				<input
					id={`decision-tags-${decision.id}`}
					type="text"
					value={decisionDraft.tags}
					oninput={(e) => (decisionDraft.tags = e.currentTarget.value)}
					placeholder="Tags"
					class="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
				/>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						onclick={() => (editingDecisionId = null)}
						class="rounded px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={() => void saveDecision(decision.id)}
						class="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500"
					>
						Save
					</button>
				</div>
			</div>
		{:else}
			<div class="space-y-1">
				<div class="line-clamp-2 text-sm text-fg" title={decision.summary}>{decision.summary}</div>
				{#if decision.rationale}
					<div
						class="line-clamp-2 text-xs text-fg-muted"
						title={`Rationale: ${decision.rationale}`}
					>
						<span class="text-fg-muted">Rationale: </span>{decision.rationale}
					</div>
				{/if}
				{#if decision.outcome}
					<div class="line-clamp-2 text-xs text-fg-muted" title={`Outcome: ${decision.outcome}`}>
						<span class="text-fg-muted">Outcome: </span>{decision.outcome}
					</div>
				{/if}
				{#if decision.tags}
					<div class="truncate text-xs text-fg-muted" title={`Tags: ${decision.tags}`}>
						Tags: {decision.tags}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet initiativeRow(initiative: Initiative)}
	{@const editing = editingInitiativeId === initiative.id}
	<div class="group py-3 transition-colors hover:bg-surface-overlay/30">
		<div class="mb-2 flex items-start justify-between gap-3">
			<div class="flex items-center gap-2 text-xs text-fg-muted">
				<span class="rounded bg-surface-overlay px-2 py-0.5 font-medium text-fg capitalize"
					>{editing ? initiativeDraft.status : initiative.status}</span
				>
				<span>updated {formatDate(initiative.updated_at)}</span>
			</div>
			{#if !editing}
				<div
					class="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
				>
					<button
						type="button"
						onclick={() => startEditInitiative(initiative)}
						class="text-xs text-fg-muted hover:text-fg"
					>
						Edit
					</button>
					<button
						type="button"
						onclick={() => void removeInitiative(initiative.id)}
						class="text-xs text-red-400 hover:text-red-300"
					>
						Delete
					</button>
				</div>
			{/if}
		</div>
		{#if editing}
			<div class="space-y-2">
				<label class="sr-only" for={`initiative-title-${initiative.id}`}>Title</label>
				<input
					id={`initiative-title-${initiative.id}`}
					type="text"
					value={initiativeDraft.title}
					oninput={(e) => (initiativeDraft.title = e.currentTarget.value)}
					placeholder="Title"
					class="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
				/>
				<label class="sr-only" for={`initiative-status-${initiative.id}`}>Status</label>
				<select
					id={`initiative-status-${initiative.id}`}
					value={initiativeDraft.status}
					onchange={(e) => (initiativeDraft.status = e.currentTarget.value)}
					class="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
				>
					{#each STATUSES as s (s)}
						<option value={s}>{s}</option>
					{/each}
				</select>
				<label class="sr-only" for={`initiative-summary-${initiative.id}`}>Summary</label>
				<textarea
					id={`initiative-summary-${initiative.id}`}
					value={initiativeDraft.summary}
					oninput={(e) => (initiativeDraft.summary = e.currentTarget.value)}
					placeholder="Summary"
					rows={2}
					class="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
				></textarea>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						onclick={() => (editingInitiativeId = null)}
						class="rounded px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={() => void saveInitiative(initiative.id)}
						class="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500"
					>
						Save
					</button>
				</div>
			</div>
		{:else}
			<div class="space-y-1">
				<div class="line-clamp-2 text-sm font-medium text-fg" title={initiative.title}>
					{initiative.title}
				</div>
				{#if initiative.summary}
					<div class="line-clamp-2 text-xs text-fg-muted" title={initiative.summary}>
						{initiative.summary}
					</div>
				{/if}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet adviceRow(advice: Advice)}
	{@const editing = editingAdviceId === advice.id}
	<div class="group py-3 transition-colors hover:bg-surface-overlay/30">
		<div class="mb-2 flex items-start justify-between gap-3">
			<div class="flex items-center gap-2 text-xs text-fg-muted">
				<span class="rounded bg-surface-overlay px-2 py-0.5 font-medium text-fg"
					>{editing ? adviceDraft.domain : advice.domain}</span
				>
				<span>{formatDate(advice.timestamp)}</span>
			</div>
			{#if !editing}
				<div
					class="flex gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100"
				>
					<button
						type="button"
						onclick={() => startEditAdvice(advice)}
						class="text-xs text-fg-muted hover:text-fg"
					>
						Edit
					</button>
					<button
						type="button"
						onclick={() => void removeAdvice(advice.id)}
						class="text-xs text-red-400 hover:text-red-300"
					>
						Delete
					</button>
				</div>
			{/if}
		</div>
		{#if editing}
			<div class="space-y-2">
				<label class="sr-only" for={`advice-domain-${advice.id}`}>Domain</label>
				<select
					id={`advice-domain-${advice.id}`}
					value={adviceDraft.domain}
					onchange={(e) => (adviceDraft.domain = e.currentTarget.value)}
					class="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
				>
					{#each DOMAINS as d (d)}
						<option value={d}>{d}</option>
					{/each}
				</select>
				<label class="sr-only" for={`advice-query-${advice.id}`}>What the user asked</label>
				<input
					id={`advice-query-${advice.id}`}
					type="text"
					value={adviceDraft.query_summary}
					oninput={(e) => (adviceDraft.query_summary = e.currentTarget.value)}
					placeholder="What the user asked"
					class="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
				/>
				<label class="sr-only" for={`advice-summary-${advice.id}`}>Advice given</label>
				<textarea
					id={`advice-summary-${advice.id}`}
					value={adviceDraft.advice_summary}
					oninput={(e) => (adviceDraft.advice_summary = e.currentTarget.value)}
					placeholder="Advice given"
					rows={3}
					class="w-full rounded border border-line bg-surface px-2 py-1.5 text-sm text-fg"
				></textarea>
				<div class="flex justify-end gap-2">
					<button
						type="button"
						onclick={() => (editingAdviceId = null)}
						class="rounded px-3 py-1.5 text-xs text-fg-muted hover:text-fg"
					>
						Cancel
					</button>
					<button
						type="button"
						onclick={() => void saveAdvice(advice.id)}
						class="rounded bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500"
					>
						Save
					</button>
				</div>
			</div>
		{:else}
			<div class="space-y-1">
				<div class="line-clamp-2 text-xs text-fg-muted" title={`Q: ${advice.query_summary}`}>
					Q: {advice.query_summary}
				</div>
				<div class="line-clamp-2 text-sm text-fg" title={advice.advice_summary}>
					{advice.advice_summary}
				</div>
			</div>
		{/if}
	</div>
{/snippet}

<div class="rounded-xl border border-line bg-surface-elevated p-4">
	<Tabs.Root value={tab} onValueChange={(v) => (tab = v as MemoryTab)}>
		<Tabs.List
			class="mb-3 w-fit gap-1 rounded-xl border border-line-strong/50 bg-surface-overlay/60 p-1"
		>
			{#each MEMORY_TABS as t (t)}
				<Tabs.Trigger
					value={t}
					class="flex-none rounded-lg px-4 py-1.5 text-sm font-medium text-fg-muted capitalize transition-colors hover:text-fg data-active:bg-surface-input data-active:text-fg data-active:shadow-sm dark:data-active:bg-surface-input"
				>
					{t}
					{#if counts[t] != null}
						<span class="ml-1.5 text-xs font-normal text-fg-subtle tabular-nums">{counts[t]}</span>
					{/if}
				</Tabs.Trigger>
			{/each}
		</Tabs.List>

		<!-- One scroll region per (lazily rendered) tab, mirroring the Recent
			     activity card — the list scrolls instead of growing. -->
		<Tabs.Content value="decisions" class="max-h-[32rem] overflow-y-auto pr-1 outline-none">
			{#if decisionsLoading}
				<div class="text-sm text-fg-muted">Loading…</div>
			{:else if decisions.length === 0}
				{@render emptyState(MEMORY_EMPTY)}
			{:else}
				<div class="divide-y divide-line">
					{#each decisions as d (d.id)}
						{@render decisionRow(d)}
					{/each}
				</div>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="initiatives" class="max-h-[32rem] overflow-y-auto pr-1 outline-none">
			{#if initiativesLoading}
				<div class="text-sm text-fg-muted">Loading…</div>
			{:else if initiatives.length === 0}
				{@render emptyState(MEMORY_EMPTY)}
			{:else}
				<div class="divide-y divide-line">
					{#each initiatives as it (it.id)}
						{@render initiativeRow(it)}
					{/each}
				</div>
			{/if}
		</Tabs.Content>

		<Tabs.Content value="advice" class="max-h-[32rem] overflow-y-auto pr-1 outline-none">
			{#if adviceLoading}
				<div class="text-sm text-fg-muted">Loading…</div>
			{:else if adviceItems.length === 0}
				{@render emptyState(MEMORY_EMPTY)}
			{:else}
				<div class="divide-y divide-line">
					{#each adviceItems as a (a.id)}
						{@render adviceRow(a)}
					{/each}
				</div>
			{/if}
		</Tabs.Content>
	</Tabs.Root>
</div>

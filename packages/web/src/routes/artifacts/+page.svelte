<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons.js';
	import {
		archiveArtifact,
		deleteArtifact,
		listArtifacts,
		listWorkflows,
		restoreArtifact,
		type ArtifactSummary,
		type WorkflowMeta
	} from '$lib/api.js';
	import { formatRelativeTime } from '$lib/helpers.js';

	type KindFilter = 'all' | 'draft' | 'workflow';
	type View = 'active' | 'archived';

	// How long the "Archived — Undo" toast stays before auto-dismissing.
	const UNDO_TIMEOUT_MS = 6000;

	const VIEWS: View[] = ['active', 'archived'];

	let artifacts = $state.raw<ArtifactSummary[]>([]);
	let workflows = $state.raw<WorkflowMeta[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let filter = $state<KindFilter>('all');
	let view = $state<View>('active');
	let pending = new SvelteSet<string>();
	let collapsed = $state<Record<string, boolean>>({});
	let undo = $state.raw<ArtifactSummary | null>(null);
	let undoTimer: ReturnType<typeof setTimeout> | null = null;

	async function load(v: View) {
		loading = true;
		error = null;
		try {
			artifacts = await listArtifacts({ archived: v === 'archived' });
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void load(view);

		// Workflow metadata is view-independent — fetch once to map a run's raw
		// workflow_name (carried as source_label) to its pretty title for group
		// headers. Failure is non-fatal; we fall back to the raw source_label.
		listWorkflows()
			.then((v) => (workflows = v))
			.catch(() => {});

		return () => {
			if (undoTimer) clearTimeout(undoTimer);
		};
	});

	function setRowPending(id: string, on: boolean) {
		if (on) pending.add(id);
		else pending.delete(id);
	}

	function dismissUndo() {
		if (undoTimer) clearTimeout(undoTimer);
		undoTimer = null;
		undo = null;
	}

	function showUndo(item: ArtifactSummary) {
		if (undoTimer) clearTimeout(undoTimer);
		undo = item;
		undoTimer = setTimeout(() => (undo = null), UNDO_TIMEOUT_MS);
	}

	// The view toggle is the user action that drives the reload, so the fetch
	// lives here rather than in an $effect watching `view`.
	function selectView(v: View) {
		view = v;
		dismissUndo();
		void load(v);
	}

	async function handleArchive(item: ArtifactSummary) {
		setRowPending(item.id, true);
		artifacts = artifacts.filter((a) => a.id !== item.id); // optimistic
		try {
			await archiveArtifact(item.id);
			showUndo(item);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			void load(view); // resync on failure
		} finally {
			setRowPending(item.id, false);
		}
	}

	async function handleRestore(item: ArtifactSummary) {
		setRowPending(item.id, true);
		artifacts = artifacts.filter((a) => a.id !== item.id); // optimistic
		try {
			await restoreArtifact(item.id);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			void load(view);
		} finally {
			setRowPending(item.id, false);
		}
	}

	async function handleDelete(item: ArtifactSummary) {
		if (
			!confirm(
				`Permanently delete "${item.title}"? This removes it everywhere and cannot be undone.`
			)
		)
			return;
		setRowPending(item.id, true);
		artifacts = artifacts.filter((a) => a.id !== item.id); // optimistic
		try {
			await deleteArtifact(item.id);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			void load(view);
		} finally {
			setRowPending(item.id, false);
		}
	}

	async function handleUndo() {
		if (!undo) return;
		const { id } = undo;
		dismissUndo();
		try {
			await restoreArtifact(id);
			// Resync the current view rather than optimistically guessing — the
			// restored item belongs in Active, and may need to leave Archived.
			void load(view);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			void load(view);
		}
	}

	function toggleCollapsed(key: string) {
		collapsed = { ...collapsed, [key]: !collapsed[key] };
	}

	const counts = $derived.by(() => {
		const c = { all: artifacts.length, draft: 0, workflow: 0 };
		for (const a of artifacts) {
			if (a.kind === 'draft') c.draft++;
			else c.workflow++;
		}
		return c;
	});

	const visible = $derived(
		filter === 'all' ? artifacts : artifacts.filter((a) => a.kind === filter)
	);

	const workflowTitleMap = $derived(new Map(workflows.map((w) => [w.name, w.title] as const)));

	// Group by source, mirroring the Jobs → Runs view: each workflow becomes its
	// own group (keyed by source_label = workflow_name, titled via workflowTitleMap),
	// and every draft collapses into one "Drafts" group. `visible` arrives
	// newest-first from the API, so first-seen order surfaces the group with the
	// most recent artifact first.
	const groups = $derived.by(() => {
		const map = new Map<string, { key: string; label: string; items: ArtifactSummary[] }>();
		for (const a of visible) {
			// Namespace the workflow key so a workflow literally named "drafts"
			// can never collide with the drafts bucket.
			const key = a.kind === 'draft' ? 'drafts' : `wf:${a.source_label}`;
			const existing = map.get(key);
			if (existing) {
				existing.items.push(a);
			} else {
				const label =
					a.kind === 'draft' ? 'Drafts' : (workflowTitleMap.get(a.source_label) ?? a.source_label);
				map.set(key, { key, label, items: [a] });
			}
		}
		return Array.from(map.values());
	});

	const emptyMessage = $derived(
		view === 'archived'
			? 'Nothing archived. Artifacts you archive will collect here, ready to restore.'
			: 'No artifacts yet. Reports and memos the Executive produces will collect here.'
	);
</script>

{#snippet FilterButton(active: boolean, onClick: () => void, label: string, count: number)}
	<button
		type="button"
		onclick={onClick}
		class={`cursor-pointer rounded-md px-3 py-1.5 text-xs ring-1 transition ${
			active
				? 'bg-surface-elevated text-fg ring-indigo-500/40'
				: 'text-fg-muted ring-line hover:text-fg hover:ring-line-strong'
		}`}
	>
		{label}
		<span class="ml-1.5 text-fg-muted">{count}</span>
	</button>
{/snippet}

{#snippet RowAction(
	icon: IconName,
	label: string,
	onClick: () => void,
	disabled: boolean,
	danger: boolean
)}
	<button
		type="button"
		onclick={onClick}
		{disabled}
		aria-label={label}
		title={label}
		class={`flex min-h-8 min-w-8 cursor-pointer items-center justify-center rounded-md transition disabled:cursor-not-allowed disabled:opacity-40 ${
			danger
				? 'text-fg-muted hover:bg-red-500/10 hover:text-red-400'
				: 'text-fg-muted hover:bg-surface-elevated hover:text-fg'
		}`}
	>
		<Icon name={icon} size="w-4 h-4" />
	</button>
{/snippet}

{#snippet ArtifactRow(item: ArtifactSummary, rowPending: boolean)}
	<div
		class="group flex items-center gap-3 rounded-md px-3 py-2.5 transition hover:bg-surface-elevated/50"
	>
		<a
			href={`/artifacts/${encodeURIComponent(item.id)}`}
			class="flex min-w-0 flex-1 items-center gap-3 rounded focus:ring-2 focus:ring-indigo-500/40 focus:outline-none"
		>
			<span class="truncate text-sm font-medium text-fg">{item.title}</span>
		</a>

		<span class="hidden text-xs whitespace-nowrap text-fg-muted tabular-nums sm:block">
			{formatRelativeTime(item.created_at)}
		</span>

		<div
			class="flex items-center gap-0.5 opacity-100 transition-opacity sm:opacity-0 sm:group-focus-within:opacity-100 sm:group-hover:opacity-100"
		>
			{#if view === 'active'}
				{@render RowAction('archive', 'Archive', () => void handleArchive(item), rowPending, false)}
			{:else}
				{@render RowAction('restore', 'Restore', () => void handleRestore(item), rowPending, false)}
			{/if}
			{@render RowAction(
				'trash',
				'Delete permanently',
				() => void handleDelete(item),
				rowPending,
				true
			)}
		</div>
	</div>
{/snippet}

<main class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
	<div class="mx-auto max-w-5xl">
		<div class="mb-6">
			<h1 class="mb-1 text-2xl font-semibold text-fg">Executive Artifacts</h1>
			<p class="text-sm text-fg-muted">
				Every Markdown deliverable the Executive has produced — drafted memos and market research
				alongside completed workflow outputs. Archive what you're done with; delete clears it for
				good.
			</p>
		</div>

		<!-- Active / Archived view toggle -->
		<div
			class="mb-4 inline-flex items-center gap-1 rounded-lg bg-surface/40 p-0.5 ring-1 ring-line"
		>
			{#each VIEWS as v (v)}
				<button
					type="button"
					onclick={() => selectView(v)}
					class={`cursor-pointer rounded-md px-3 py-1.5 text-xs capitalize transition ${
						view === v ? 'bg-surface-elevated text-fg' : 'text-fg-muted hover:text-fg'
					}`}
				>
					{v}
				</button>
			{/each}
		</div>

		{#if loading}
			<div class="text-sm text-fg-muted" role="status">Loading artifacts…</div>
		{/if}

		{#if error}
			<div class="mb-4 text-sm text-red-400" role="alert">Error: {error}</div>
		{/if}

		{#if !loading && !error && artifacts.length === 0}
			<div class="text-sm text-fg-muted">{emptyMessage}</div>
		{/if}

		{#if !loading && !error && artifacts.length > 0}
			<div class="mb-5 flex items-center gap-1">
				{@render FilterButton(filter === 'all', () => (filter = 'all'), 'All', counts.all)}
				{@render FilterButton(filter === 'draft', () => (filter = 'draft'), 'Drafts', counts.draft)}
				{@render FilterButton(
					filter === 'workflow',
					() => (filter = 'workflow'),
					'Workflows',
					counts.workflow
				)}
			</div>

			<div class="space-y-5">
				{#each groups as group (group.key)}
					{@const isCollapsed = !!collapsed[group.key]}
					<div>
						<button
							type="button"
							onclick={() => toggleCollapsed(group.key)}
							class="mb-2 flex w-full cursor-pointer items-center gap-2 text-left"
						>
							<span
								class={`text-xs text-fg-muted transition-transform ${
									isCollapsed ? '' : 'rotate-90'
								}`}
							>
								▶
							</span>
							<span class="text-sm font-semibold text-fg">{group.label}</span>
							<span class="text-xs text-fg-muted">
								{`${group.items.length} ${group.items.length === 1 ? 'artifact' : 'artifacts'}`}
							</span>
						</button>
						{#if !isCollapsed}
							<div class="divide-y divide-line/60 rounded-lg border border-line bg-surface/40">
								{#each group.items as a (a.id)}
									{@render ArtifactRow(a, pending.has(a.id))}
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
</main>

<!-- Undo toast after archive -->
{#if undo}
	<div class="fixed right-4 bottom-4 z-50 motion-safe:animate-in motion-safe:slide-in-from-right">
		<div
			class="flex items-center gap-3 rounded-xl border border-line-strong bg-surface-overlay px-4 py-3 shadow-xl shadow-black/40 backdrop-blur"
		>
			<span class="text-sm text-fg" role="status">
				Archived <span class="font-medium">{undo.title}</span>
			</span>
			<button
				type="button"
				onclick={() => void handleUndo()}
				class="cursor-pointer text-sm font-medium text-indigo-400 hover:text-indigo-300"
			>
				Undo
			</button>
			<button
				type="button"
				onclick={dismissUndo}
				aria-label="Dismiss"
				class="-mr-1 flex min-h-8 min-w-8 cursor-pointer items-center justify-center rounded text-fg-muted hover:text-fg"
			>
				<Icon name="close" size="w-3.5 h-3.5" />
			</button>
		</div>
	</div>
{/if}

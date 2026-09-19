<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteMap } from 'svelte/reactivity';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import { formatRelativeTime } from '$lib/helpers.js';
	import {
		deleteCustomWorkflow,
		deleteWorkflowRun,
		listWorkflowRuns,
		listWorkflows,
		type WorkflowMeta,
		type WorkflowRunSummary,
		type WorkflowSection
	} from '$lib/api.js';

	const SECTION_ORDER: WorkflowSection[] = [
		'Board',
		'Capital & Investors',
		'Growth & GTM',
		'Product',
		'People',
		'Risk, Legal & Crisis',
		'Operating Cadence'
	];

	const SECTION_BLURB: Record<WorkflowSection, string> = {
		Board: 'Decks, memos, and talking points for your board meetings.',
		'Capital & Investors': 'Materials for raising capital and reporting to investors.',
		'Growth & GTM': 'Positioning, launches, pricing, and competitive plays.',
		Product: 'Strategy memos, retention and product decisions.',
		People: 'Hiring, performance, org design, and compensation.',
		'Risk, Legal & Crisis': 'Risk register, M&A diligence, and crisis-comms preparation.',
		'Operating Cadence': 'The monthly, quarterly, and annual rhythm of running the company.'
	};

	type Tab = 'catalog' | 'runs';
	type RunStatus = 'active' | 'done' | 'error';

	interface CatalogSection {
		key: string;
		blurb: string;
		items: WorkflowMeta[];
		custom: boolean;
	}

	function isTab(v: string | null): v is Tab {
		return v === 'catalog' || v === 'runs';
	}

	function isStatus(v: string | null): v is RunStatus {
		return v === 'active' || v === 'done' || v === 'error';
	}

	/** Ring + text colour for the run-status badge, per upstream `statusBadge`. */
	function badgeTone(status: string): string {
		return status === 'done'
			? 'bg-emerald-500/10 text-emerald-400 ring-emerald-500/30'
			: status === 'error'
				? 'bg-red-500/10 text-red-400 ring-red-500/30'
				: 'bg-amber-500/10 text-amber-400 ring-amber-500/30';
	}

	function matchesQuery(q: string, ...fields: (string | undefined)[]): boolean {
		if (!q) return true;
		const needle = q.toLowerCase();
		return fields.some((f) => (f ?? '').toLowerCase().includes(needle));
	}

	function groupBy<T, K extends string>(arr: T[], keyFn: (item: T) => K): Map<K, T[]> {
		const out = new SvelteMap<K, T[]>();
		for (const item of arr) {
			const k = keyFn(item);
			const bucket = out.get(k);
			if (bucket) bucket.push(item);
			else out.set(k, [item]);
		}
		return out;
	}

	function runStatusBucket(s: WorkflowRunSummary['status']): RunStatus {
		if (s === 'running') return 'active';
		if (s === 'done' || s === 'error') return s;
		// Defensive: unknown future statuses surface under Active so they're not lost.
		return 'active';
	}

	const tabParam = $derived(page.url.searchParams.get('tab'));
	const statusParam = $derived(page.url.searchParams.get('status'));
	let tab = $derived<Tab>(isTab(tabParam) ? tabParam : 'catalog');
	let status = $derived<RunStatus | null>(isStatus(statusParam) ? statusParam : null);
	// Runs default to whichever bucket has content; see `defaultedStatus` below.
	let activeStatus = $derived<RunStatus>(status ?? 'active');

	let workflows = $state<WorkflowMeta[]>([]);
	let runs = $state<WorkflowRunSummary[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let catalogQuery = $state('');
	let runsQuery = $state('');
	let collapsed = $state<Record<string, boolean>>({});

	// Guards the one-shot "pick a sensible runs sub-tab" navigation (upstream
	// used a ref for the same reason): without it, returning to `?tab=runs`
	// with no `?status` would keep re-writing the URL mid-interaction.
	let defaultedStatus = false;

	const runCounts = $derived.by(() => {
		const c = { active: 0, done: 0, error: 0 };
		for (const r of runs) c[runStatusBucket(r.status)]++;
		return c;
	});

	const workflowTitleMap = $derived(new Map(workflows.map((w) => [w.name, w.title] as const)));

	const catalogSections = $derived.by((): CatalogSection[] => {
		const filtered = workflows.filter((w) => matchesQuery(catalogQuery, w.title, w.description));
		// User-created workflows are grouped together under "Custom" regardless of
		// their declared section, so they're easy to find, edit, and delete.
		const custom = filtered.filter((w) => w.is_custom);
		const builtin = filtered.filter((w) => !w.is_custom);
		const known = new Set<string>(SECTION_ORDER);
		const others = builtin.filter((w) => !known.has(w.section));

		const out: CatalogSection[] = [];
		if (custom.length > 0) {
			out.push({
				key: 'Custom',
				blurb: 'Workflows you created. Edit or delete them anytime.',
				items: custom,
				custom: true
			});
		}
		for (const section of SECTION_ORDER) {
			const items = builtin.filter((w) => w.section === section);
			if (items.length === 0) continue;
			out.push({ key: section, blurb: SECTION_BLURB[section], items, custom: false });
		}
		if (others.length > 0) {
			out.push({
				key: 'Other',
				blurb: 'Workflows not yet assigned to a known section.',
				items: others,
				custom: false
			});
		}
		return out;
	});

	const visibleRuns = $derived(
		runs.filter(
			(r) =>
				runStatusBucket(r.status) === activeStatus &&
				matchesQuery(runsQuery, r.title, r.workflow_name)
		)
	);

	const runGroups = $derived(groupBy(visibleRuns, (r) => r.workflow_name));

	const runsEmptyMessage = $derived(
		activeStatus === 'active'
			? 'No active runs.'
			: activeStatus === 'done'
				? 'No completed runs yet.'
				: 'No errors.'
	);

	onMount(() => {
		void refresh();
	});

	async function refresh() {
		error = null;
		try {
			const [wfs, rs] = await Promise.all([listWorkflows(), listWorkflowRuns()]);
			workflows = wfs;
			runs = rs;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
			// Default the runs sub-tab once data is loaded and ?status is missing
			// or invalid.
			if (!defaultedStatus && tab === 'runs' && status === null) {
				defaultedStatus = true;
				setParam({ status: runCounts.active > 0 ? 'active' : 'done' });
			}
		}
	}

	function setParam(updates: Record<string, string | null>) {
		const sp = new URLSearchParams(page.url.searchParams.toString());
		for (const [k, v] of Object.entries(updates)) {
			if (v === null) sp.delete(k);
			else sp.set(k, v);
		}
		const qs = sp.toString();
		const pathname = page.url.pathname;
		void goto(qs ? `${pathname}?${qs}` : pathname, {
			replaceState: true,
			noScroll: true,
			keepFocus: true
		});
	}

	function selectTab(next: Tab) {
		// Switching to Runs without a status picks one in the same navigation,
		// so the sub-tab never renders with an ambiguous filter.
		if (next === 'runs' && status === null && !defaultedStatus) {
			defaultedStatus = true;
			setParam({ tab: next, status: runCounts.active > 0 ? 'active' : 'done' });
			return;
		}
		setParam({ tab: next });
	}

	function toggleCollapsed(key: string) {
		collapsed = { ...collapsed, [key]: !collapsed[key] };
	}

	async function handleDelete(runId: string) {
		if (!confirm('Delete this run?')) return;
		// Upstream has no error handling here either — a failed delete leaves the
		// list as-is.
		await deleteWorkflowRun(runId);
		void refresh();
	}

	async function handleDeleteCustom(name: string) {
		if (!confirm(`Delete the custom workflow “${name}”? This cannot be undone.`)) return;
		await deleteCustomWorkflow(name);
		void refresh();
	}
</script>

{#snippet searchInput(value: string, placeholder: string, onInput: (v: string) => void)}
	<input
		type="search"
		{value}
		{placeholder}
		aria-label={placeholder}
		oninput={(e) => onInput(e.currentTarget.value)}
		class="w-full rounded-md border border-line bg-surface/60 px-3 py-1.5 text-sm text-fg placeholder:text-fg-subtle focus:border-line-strong focus:ring-1 focus:ring-indigo-500/40 focus:outline-none sm:w-80"
	/>
{/snippet}

{#snippet statusBadge(status: string)}
	<span
		class={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium ring-1 ${badgeTone(
			status
		)}`}
	>
		{status}
	</span>
{/snippet}

{#snippet statusSegment(
	label: string,
	count: number,
	tone: 'amber' | 'emerald' | 'red',
	active: boolean,
	onClick: () => void
)}
	<button
		type="button"
		aria-pressed={active}
		onclick={onClick}
		class={`rounded-md px-3 py-1.5 text-xs ring-1 transition ${
			active
				? `bg-surface-elevated ${
						tone === 'amber'
							? 'text-amber-300 ring-amber-500/40'
							: tone === 'emerald'
								? 'text-emerald-300 ring-emerald-500/40'
								: 'text-red-300 ring-red-500/40'
					}`
				: 'text-fg-muted ring-line hover:text-fg hover:ring-line-strong'
		}`}
	>
		{label}
		<span class="ml-1.5 text-fg-muted">{count}</span>
	</button>
{/snippet}

{#snippet catalogCard(w: WorkflowMeta)}
	<a
		href={`/jobs/${encodeURIComponent(w.name)}`}
		class="block rounded-lg border border-line bg-surface/40 p-5 transition hover:border-line-strong hover:bg-surface-elevated/40"
	>
		<h3 class="mb-2 text-base font-semibold text-fg">{w.title}</h3>
		<p class="mb-3 text-sm leading-relaxed text-fg-muted">{w.description}</p>
		<div class="flex items-center justify-between text-xs text-fg-muted">
			<span>{w.steps.length} steps</span>
			<span>~{w.estimated_minutes} min</span>
		</div>
	</a>
{/snippet}

{#snippet customCard(w: WorkflowMeta)}
	<div class="rounded-lg border border-line bg-surface/40 p-5 transition hover:border-line-strong">
		<a href={`/jobs/${encodeURIComponent(w.name)}`} class="block">
			<h3 class="mb-2 text-base font-semibold text-fg">{w.title}</h3>
			<p class="mb-3 text-sm leading-relaxed text-fg-muted">{w.description}</p>
			<div class="flex items-center justify-between text-xs text-fg-muted">
				<span>{w.steps.length} steps</span>
				<span>~{w.estimated_minutes} min</span>
			</div>
		</a>
		<div class="mt-3 flex items-center gap-3 border-t border-line pt-3 text-xs">
			<a
				href={`/jobs/new?edit=${encodeURIComponent(w.name)}`}
				class="text-indigo-400 hover:text-indigo-300"
			>
				Edit
			</a>
			<button
				type="button"
				onclick={() => void handleDeleteCustom(w.name)}
				class="text-fg-muted transition hover:text-red-400"
			>
				Delete
			</button>
		</div>
	</div>
{/snippet}

{#snippet catalogView()}
	<div>
		<div class="mb-6 flex items-center justify-between gap-4">
			{@render searchInput(
				catalogQuery,
				'Search workflows by title or description…',
				(v) => (catalogQuery = v)
			)}
			<a
				href="/jobs/new"
				class="shrink-0 rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white transition hover:bg-indigo-500"
			>
				+ New workflow
			</a>
		</div>

		{#if workflows.length === 0}
			<div class="text-sm text-fg-muted">No jobs registered yet.</div>
		{:else if catalogSections.length === 0}
			<div class="text-sm text-fg-muted">No jobs match “{catalogQuery}”.</div>
		{:else}
			<div class="space-y-10">
				{#each catalogSections as section (section.key)}
					<div>
						<div class="mb-3 flex items-baseline gap-3">
							<h2 class="text-base font-semibold text-fg">{section.key}</h2>
							<span class="text-xs text-fg-muted">
								{section.items.length}
								{section.items.length === 1 ? 'job' : 'jobs'}
							</span>
						</div>
						<p class="mb-3 text-xs leading-relaxed text-fg-muted">{section.blurb}</p>
						<div class="grid gap-4 sm:grid-cols-2">
							{#each section.items as w (w.name)}
								{#if section.custom}
									{@render customCard(w)}
								{:else}
									{@render catalogCard(w)}
								{/if}
							{/each}
						</div>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet runsView()}
	<div>
		<div class="mb-4 flex items-center gap-1">
			{@render statusSegment('Active', runCounts.active, 'amber', activeStatus === 'active', () =>
				setParam({ status: 'active' })
			)}
			{@render statusSegment('Done', runCounts.done, 'emerald', activeStatus === 'done', () =>
				setParam({ status: 'done' })
			)}
			{@render statusSegment('Error', runCounts.error, 'red', activeStatus === 'error', () =>
				setParam({ status: 'error' })
			)}
		</div>

		<div class="mb-4">
			{@render searchInput(runsQuery, 'Search runs by title or workflow…', (v) => (runsQuery = v))}
		</div>

		{#if visibleRuns.length === 0}
			<div class="text-sm text-fg-muted">
				{runsQuery ? `No runs match “${runsQuery}”.` : runsEmptyMessage}
			</div>
		{:else}
			<div class="space-y-5">
				{#each Array.from(runGroups.entries()) as [workflowName, items] (workflowName)}
					{@const title = workflowTitleMap.get(workflowName) ?? workflowName}
					{@const isCollapsed = !!collapsed[workflowName]}
					<div>
						<button
							type="button"
							aria-expanded={!isCollapsed}
							onclick={() => toggleCollapsed(workflowName)}
							class="mb-2 flex w-full items-center gap-2 text-left"
						>
							<span
								aria-hidden="true"
								class={`text-xs text-fg-muted transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
							>
								▶
							</span>
							<span class="text-sm font-semibold text-fg">{title}</span>
							<span class="text-xs text-fg-muted">
								{items.length}
								{items.length === 1 ? 'run' : 'runs'}
							</span>
						</button>
						{#if !isCollapsed}
							<div class="space-y-2">
								{#each items as r (r.run_id)}
									<div
										class="flex items-center justify-between gap-4 rounded-md border border-line bg-surface/30 px-4 py-3"
									>
										<a href={`/jobs/runs/${encodeURIComponent(r.run_id)}`} class="min-w-0 flex-1">
											<div class="mb-1 flex items-center gap-2">
												<span class="truncate text-sm font-medium text-fg">{r.title}</span>
												{@render statusBadge(r.status)}
											</div>
											<div class="text-xs text-fg-muted">
												updated {formatRelativeTime(r.updated_at)}
											</div>
										</a>
										<button
											type="button"
											onclick={() => void handleDelete(r.run_id)}
											aria-label="Delete run"
											class="text-xs text-fg-muted transition hover:text-red-400"
										>
											Delete
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<main class="flex min-h-0 flex-1 flex-col text-fg">
	<div class="mx-auto w-full max-w-5xl px-4 py-8 sm:px-6">
		<div class="mb-6">
			<h1 class="mb-1 text-2xl font-semibold text-fg">Executive Jobs</h1>
			<p class="text-sm text-fg-muted">
				Structured executive workflows that produce a deliverable — not a conversation. Each job
				orchestrates the relevant specialists and knowledge to draft a complete artifact.
			</p>
		</div>

		<Tabs.Root value={tab} onValueChange={(v) => selectTab(v as Tab)}>
			<Tabs.List variant="line" class="mb-6 w-full justify-start gap-1 border-b border-line pb-1">
				<Tabs.Trigger
					value="catalog"
					class="flex-none px-4 text-sm font-medium text-fg-muted transition-colors after:bg-indigo-500 hover:text-fg data-active:text-fg"
				>
					Catalog
					<span class="ml-2 text-xs text-fg-muted">{workflows.length}</span>
				</Tabs.Trigger>
				<Tabs.Trigger
					value="runs"
					class="flex-none px-4 text-sm font-medium text-fg-muted transition-colors after:bg-indigo-500 hover:text-fg data-active:text-fg"
				>
					Runs
					<span class="ml-2 text-xs text-fg-muted">{runs.length}</span>
				</Tabs.Trigger>
			</Tabs.List>

			{#if loading}
				<div class="text-sm text-fg-muted" role="status">Loading jobs…</div>
			{/if}
			{#if error}
				<div class="mb-4 text-sm text-red-400" role="alert">Error: {error}</div>
			{/if}

			{#if !loading}
				<Tabs.Content value="catalog" class="outline-none">
					{@render catalogView()}
				</Tabs.Content>
				<Tabs.Content value="runs" class="outline-none">
					{@render runsView()}
				</Tabs.Content>
			{/if}
		</Tabs.Root>
	</div>
</main>

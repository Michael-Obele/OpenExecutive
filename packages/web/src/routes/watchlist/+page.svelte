<script lang="ts">
	import { onMount } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';

	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as DropdownMenu from '$lib/components/ui/dropdown-menu/index.js';
	import {
		approveWatchSuggestion,
		createWatchlistItem,
		declineWatchSuggestion,
		deleteWatchlistItem,
		listDepartments,
		listWatchlist,
		patchWatchlistItem,
		type WatchDeclineReason,
		type WatchlistCadence,
		type WatchlistItem,
		type WatchlistSeverity,
		type WatchlistSignalType
	} from '$lib/api.js';

	// A research suggestion: the Executive wanted to watch this but was not sure
	// enough to add it on its own. Sits in dry_run (polls, never alerts) until
	// approved or declined here.
	function isSuggestion(item: WatchlistItem): boolean {
		return item.origin === 'research_proposed' && item.mode === 'dry_run';
	}

	const DECLINE_REASONS: { value: WatchDeclineReason; label: string; hint: string }[] = [
		{
			value: 'not_relevant',
			label: 'Not relevant',
			hint: 'Never suggest this company/topic again'
		},
		{ value: 'too_noisy', label: 'Too noisy', hint: 'Keep it, but only high-severity signals' },
		{
			value: 'wrong_source',
			label: 'Wrong source',
			hint: 'Right topic, drop only this feed/page'
		}
	];

	// Rationale + provenance stamp the research policy left on the row.
	function policyStamp(item: WatchlistItem): {
		entity?: string;
		score?: number;
		source_url?: string;
	} {
		const raw = (item.config_json as Record<string, unknown> | undefined)?._policy;
		return raw && typeof raw === 'object'
			? (raw as { entity?: string; score?: number; source_url?: string })
			: {};
	}

	const CADENCES: WatchlistCadence[] = ['real_time', '15min', 'hourly', 'daily', 'weekly'];
	const SEVERITIES: WatchlistSeverity[] = ['low', 'medium', 'high', 'urgent'];
	const SIGNAL_TYPES: { value: WatchlistSignalType; label: string; hint: string }[] = [
		{ value: 'stock', label: 'Stock', hint: 'Yahoo Finance ticker — e.g. AAPL' },
		{ value: 'rss', label: 'RSS / Atom', hint: 'Feed URL — e.g. competitor changelog' },
		{ value: 'vendor_status', label: 'Vendor status', hint: 'Statuspage atom/RSS feed URL' },
		{ value: 'edgar', label: 'SEC EDGAR', hint: 'Ticker or CIK — e.g. AAPL or 320193' },
		{
			value: 'page_watch',
			label: 'Page change',
			hint: 'Public page URL to watch for content changes — e.g. a pricing or careers page'
		},
		{
			value: 'query',
			label: 'Web search (billed)',
			hint: 'Standing search query — e.g. Acme Corp layoffs OR restructuring OR funding'
		}
	];

	// query runs an LLM web search every poll, so it bills per tick — unlike the
	// keyless feed/EDGAR/page adapters. Surfaced as a warning in the add modal.
	const BILLED_SIGNAL_TYPES: ReadonlySet<string> = new Set(['query']);

	// Pretty group-header label per signal type, derived from the add-modal's
	// SIGNAL_TYPES so the two never drift. Unknown types fall back to the raw value.
	const SIGNAL_TYPE_LABELS: Record<string, string> = Object.fromEntries(
		SIGNAL_TYPES.map((s) => [s.value, s.label])
	);

	// Group display order: known types in SIGNAL_TYPES order; unknown types sort last.
	const SIGNAL_TYPE_ORDER: string[] = SIGNAL_TYPES.map((s) => s.value);

	// Turn a kebab-case slug into a readable title: "stock-aapl" → "stock aapl".
	// The full slug stays the identity (used for routing + shown on hover).
	function humanizeSlug(slug: string): string {
		return slug.replace(/-+/g, ' ').trim();
	}

	// Relative time. Kept inline so the watchlist page is self-contained;
	// Briefing.tsx has its own copy with the same formula.
	function formatRelTime(iso: string | null): string {
		if (!iso) return 'never';
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

	// The "Added by the Executive" suffix. Built as one string because the
	// upstream JSX concatenated three expressions with no separator text
	// between them.
	function researchSuffix(item: WatchlistItem, departmentTitle: string | undefined): string {
		const stamp = policyStamp(item);
		return `${stamp.entity ? ` · about ${stamp.entity}` : ''}${
			item.route_to_department ? ` · for ${departmentTitle ?? item.route_to_department}` : ''
		}${item.notes ? ` · ${item.notes}` : ''}`;
	}

	let items = $state.raw<WatchlistItem[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let showAdd = $state(false);
	let busySlugs = new SvelteSet<string>();
	let collapsed = $state<Record<string, boolean>>({});
	// slug → title for the "for: <department>" label on routed watches.
	let departmentTitles = $state.raw<Record<string, string>>({});

	function toggleCollapsed(key: string) {
		collapsed = { ...collapsed, [key]: !collapsed[key] };
	}

	async function refresh() {
		loading = true;
		try {
			items = await listWatchlist();
			error = null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load';
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
		listDepartments()
			.then(
				(states) =>
					(departmentTitles = Object.fromEntries(
						states.map((d) => [d.config.slug, d.config.title])
					))
			)
			.catch(() => {});
	});

	function markBusy(slug: string, busy: boolean) {
		if (busy) busySlugs.add(slug);
		else busySlugs.delete(slug);
	}

	async function approve(slug: string) {
		markBusy(slug, true);
		try {
			const updated = await approveWatchSuggestion(slug);
			items = items.map((it) => (it.slug === slug ? updated : it));
		} catch (e) {
			error = e instanceof Error ? e.message : 'Approve failed';
		} finally {
			markBusy(slug, false);
		}
	}

	async function decline(slug: string, reason: WatchDeclineReason) {
		markBusy(slug, true);
		try {
			const res = await declineWatchSuggestion(slug, reason);
			if (res.result === 'removed') {
				items = items.filter((it) => it.slug !== slug);
			} else {
				// too_noisy: the row went live with a high floor — reload it.
				void refresh();
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Decline failed';
		} finally {
			markBusy(slug, false);
		}
	}

	async function stopWatching(slug: string, reason: WatchDeclineReason) {
		markBusy(slug, true);
		try {
			if (reason === 'too_noisy') {
				// Same remedy the decline route applies: keep the source, only
				// high-severity signals surface.
				const updated = await patchWatchlistItem(slug, { severity_floor: 'high' });
				items = items.map((it) => (it.slug === slug ? updated : it));
			} else {
				await deleteWatchlistItem(slug, reason);
				items = items.filter((it) => it.slug !== slug);
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Remove failed';
		} finally {
			markBusy(slug, false);
		}
	}

	async function toggle(slug: string, enabled: boolean) {
		// Optimistic. The disabled prop on the input prevents a second
		// click landing while the PATCH is in flight, so the revert path
		// can safely flip back to the prior value.
		busySlugs.add(slug);
		items = items.map((it) => (it.slug === slug ? { ...it, enabled } : it));
		try {
			const updated = await patchWatchlistItem(slug, { enabled });
			items = items.map((it) => (it.slug === slug ? updated : it));
		} catch (e) {
			items = items.map((it) => (it.slug === slug ? { ...it, enabled: !enabled } : it));
			error = e instanceof Error ? e.message : 'Toggle failed';
		} finally {
			busySlugs.delete(slug);
		}
	}

	// --- Add-monitor dialog state (the upstream modal's own useState) --------

	let addSlug = $state('');
	let addSignalType = $state<WatchlistSignalType>('stock');
	let addTarget = $state('');
	let addTrigger = $state('');
	let addCadence = $state<WatchlistCadence>('15min');
	let addSeverityFloor = $state<WatchlistSeverity>('low');
	let addSeverityCeiling = $state<WatchlistSeverity>('urgent');
	let addMode = $state<'active' | 'dry_run'>('active');
	let addNotes = $state('');
	let addSaving = $state(false);
	let addErr = $state<string | null>(null);
	let slugInput = $state<HTMLInputElement | null>(null);

	// Upstream unmounted the modal on close, which reset its fields; the dialog
	// now lives in this component, so resetting explicitly keeps that behaviour.
	function openAdd() {
		addSlug = '';
		addSignalType = 'stock';
		addTarget = '';
		addTrigger = '';
		addCadence = '15min';
		addSeverityFloor = 'low';
		addSeverityCeiling = 'urgent';
		addMode = 'active';
		addNotes = '';
		addSaving = false;
		addErr = null;
		showAdd = true;
	}

	async function submitAdd() {
		addSaving = true;
		addErr = null;
		let parsedTrigger: Record<string, unknown> = {};
		if (addTrigger.trim()) {
			try {
				parsedTrigger = JSON.parse(addTrigger);
			} catch {
				addErr = 'Trigger must be valid JSON, e.g. {"abs_change_pct_gte": 5}';
				addSaving = false;
				return;
			}
		}
		try {
			const created = await createWatchlistItem({
				slug: addSlug.trim(),
				signal_type: addSignalType,
				target: addTarget.trim(),
				trigger: parsedTrigger,
				cadence: addCadence,
				severity_floor: addSeverityFloor,
				severity_ceiling: addSeverityCeiling,
				mode: addMode,
				notes: addNotes.trim()
			});
			items = [...items, created];
			showAdd = false;
		} catch (e) {
			addErr = e instanceof Error ? e.message : 'Create failed';
		} finally {
			addSaving = false;
		}
	}

	const addTargetHint = $derived(SIGNAL_TYPES.find((s) => s.value === addSignalType)?.hint ?? '');

	// Group monitors by signal type, mirroring the artifacts/runs collapsible
	// groups. Known types render in SIGNAL_TYPES order; any unknown type sorts
	// last (alphabetically) so a new backend adapter never silently vanishes.
	const suggestions = $derived(items.filter(isSuggestion));

	const groups = $derived.by(() => {
		const map = new Map<string, WatchlistItem[]>();
		for (const it of items) {
			if (isSuggestion(it)) continue;
			const bucket = map.get(it.signal_type);
			if (bucket) bucket.push(it);
			else map.set(it.signal_type, [it]);
		}
		const keys = Array.from(map.keys()).sort((a, b) => {
			const ia = SIGNAL_TYPE_ORDER.indexOf(a);
			const ib = SIGNAL_TYPE_ORDER.indexOf(b);
			if (ia !== -1 && ib !== -1) return ia - ib;
			if (ia !== -1) return -1;
			if (ib !== -1) return 1;
			return a.localeCompare(b);
		});
		return keys.map((k) => ({
			key: k,
			label: SIGNAL_TYPE_LABELS[k] ?? k,
			items: map.get(k) ?? []
		}));
	});
</script>

{#snippet ModePill(mode: string)}
	{@const isDry = mode === 'dry_run'}
	<span
		class={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${
			isDry
				? 'border-zinc-500/30 bg-zinc-500/20 text-zinc-300'
				: 'border-indigo-500/30 bg-indigo-500/20 text-indigo-300'
		}`}
	>
		{mode}
	</span>
{/snippet}

{#snippet DeclineMenu(
	slug: string,
	busy: boolean,
	onPick: (slug: string, reason: WatchDeclineReason) => void,
	label: string
)}
	<DropdownMenu.Root>
		<DropdownMenu.Trigger
			disabled={busy}
			class="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-surface-overlay disabled:opacity-50"
		>
			{label}
		</DropdownMenu.Trigger>
		<DropdownMenu.Content align="end" class="min-w-56">
			{#each DECLINE_REASONS as r (r.value)}
				<DropdownMenu.Item
					onSelect={() => onPick(slug, r.value)}
					class="flex-col items-start gap-0"
				>
					<div class="text-xs text-fg">{r.label}</div>
					<div class="text-[10px] text-fg-subtle">{r.hint}</div>
				</DropdownMenu.Item>
			{/each}
		</DropdownMenu.Content>
	</DropdownMenu.Root>
{/snippet}

{#snippet SuggestionCard(item: WatchlistItem, busy: boolean, departmentTitle: string | undefined)}
	{@const stamp = policyStamp(item)}
	<div class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
		<div class="mb-1 flex items-start justify-between gap-2">
			<div class="min-w-0">
				<div class="truncate text-sm font-semibold text-fg" title={item.slug}>
					{humanizeSlug(item.slug)}
				</div>
				<div class="truncate text-xs text-fg-muted" title={item.target}>
					{item.signal_type} · {item.target}
				</div>
			</div>
			<span
				class="inline-block shrink-0 rounded border border-amber-500/30 bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-medium text-amber-200"
			>
				suggested
			</span>
		</div>
		{#if item.notes}
			<p class="mt-2 text-xs text-fg">{item.notes}</p>
		{/if}
		<div class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-muted">
			{#if stamp.entity}
				<span>about: {stamp.entity}</span>
			{/if}
			{#if item.route_to_department}
				<span title="This department's head was asked to review it">
					for: {departmentTitle ?? item.route_to_department}
				</span>
			{/if}
			<span>suggested {formatRelTime(item.created_at)} ago</span>
			<span>{`seen in shadow: ${item.fired_count} signal${item.fired_count === 1 ? '' : 's'}`}</span
			>
			{#if stamp.source_url}
				<a
					href={stamp.source_url}
					target="_blank"
					rel="noreferrer"
					class="text-indigo-300 hover:text-indigo-200"
				>
					source ↗
				</a>
			{/if}
		</div>
		<div class="mt-3 flex items-center justify-end gap-2 border-t border-line pt-2">
			{@render DeclineMenu(item.slug, busy, decline, 'Decline…')}
			<button
				type="button"
				disabled={busy}
				onclick={() => void approve(item.slug)}
				class="cursor-pointer rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
			>
				{busy ? '…' : 'Approve'}
			</button>
		</div>
	</div>
{/snippet}

{#snippet WatchCard(item: WatchlistItem, toggleBusy: boolean, departmentTitle: string | undefined)}
	{@const isResearch = item.origin === 'research'}
	<div
		class="group rounded-xl border border-line bg-surface-elevated p-4 transition-colors hover:bg-surface-overlay"
	>
		<div class="mb-2 flex items-start justify-between gap-2">
			<a href={`/watchlist/${encodeURIComponent(item.slug)}`} class="min-w-0 flex-1">
				<div
					class="truncate text-sm font-semibold text-fg transition-colors group-hover:text-indigo-300"
					title={item.slug}
				>
					{humanizeSlug(item.slug)}
				</div>
				<div class="mt-0.5 truncate text-xs text-fg-muted" title={item.target}>
					{item.target}
				</div>
			</a>
			<div class="flex shrink-0 items-center gap-2">
				{@render ModePill(item.mode)}
			</div>
		</div>
		{#if isResearch}
			<p class="mb-2 text-[11px] text-fg-muted">
				<span class="text-indigo-300">Added by the Executive</span>
				{researchSuffix(item, departmentTitle)}
			</p>
		{/if}
		<div class="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-fg-muted">
			<span>cadence: {item.cadence}</span>
			<span>severity: {`${item.severity_floor}→${item.severity_ceiling}`}</span>
			<span>fired: {item.fired_count}</span>
			{#if item.dismiss_count > 0}
				<span>dismissed: {item.dismiss_count}</span>
			{/if}
			<span>last: {formatRelTime(item.last_fired_at)}</span>
		</div>
		<div class="flex items-center justify-between gap-2 border-t border-line pt-2">
			<label class="flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted">
				<input
					type="checkbox"
					checked={item.enabled}
					disabled={toggleBusy}
					onchange={(e) => void toggle(item.slug, e.currentTarget.checked)}
					class="accent-indigo-500 disabled:opacity-50"
				/>
				enabled
			</label>
			<div class="flex items-center gap-2">
				{#if isResearch}
					{@render DeclineMenu(item.slug, toggleBusy, stopWatching, 'Stop watching…')}
				{/if}
				<a
					href={`/watchlist/${encodeURIComponent(item.slug)}`}
					class="text-xs text-indigo-300 hover:text-indigo-200"
				>
					inspect →
				</a>
			</div>
		</div>
	</div>
{/snippet}

{#snippet AddWatchDialog()}
	<Dialog.Root bind:open={showAdd}>
		<Dialog.Content
			class="max-h-[90vh] overflow-y-auto border border-line bg-surface-elevated sm:max-w-lg"
			onInteractOutside={(e: PointerEvent) => {
				if (addSaving) e.preventDefault();
			}}
			onEscapeKeydown={(e: KeyboardEvent) => {
				if (addSaving) e.preventDefault();
			}}
			onOpenAutoFocus={(e: Event) => {
				e.preventDefault();
				slugInput?.focus();
			}}
		>
			<Dialog.Header>
				<Dialog.Title>Add monitor</Dialog.Title>
			</Dialog.Header>
			<div class="space-y-3">
				<div>
					<label class="mb-1 block text-xs text-fg-muted" for="add-watch-slug">
						Slug (kebab-case)
					</label>
					<input
						id="add-watch-slug"
						bind:this={slugInput}
						bind:value={addSlug}
						placeholder="stock-aapl"
						class="w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm text-fg"
					/>
				</div>
				<div>
					<label class="mb-1 block text-xs text-fg-muted" for="add-watch-signal-type">
						Signal type
					</label>
					<select
						id="add-watch-signal-type"
						value={addSignalType}
						onchange={(e) => (addSignalType = e.currentTarget.value as WatchlistSignalType)}
						class="w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm text-fg"
					>
						{#each SIGNAL_TYPES as s (s.value)}
							<option value={s.value}>{s.label}</option>
						{/each}
					</select>
				</div>
				<div>
					<label class="mb-1 block text-xs text-fg-muted" for="add-watch-target">Target</label>
					<input
						id="add-watch-target"
						bind:value={addTarget}
						placeholder={addTargetHint}
						class="w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm text-fg"
					/>
					<p class="mt-1 text-[10px] text-fg-subtle">{addTargetHint}</p>
					{#if BILLED_SIGNAL_TYPES.has(addSignalType)}
						<p class="mt-1 text-[10px] text-amber-300/90">
							⚠ Billed: runs an LLM web search on every poll. Prefer a slower cadence (daily /
							weekly) and a tight query.
						</p>
					{/if}
				</div>
				<div>
					<label class="mb-1 block text-xs text-fg-muted" for="add-watch-trigger">
						Trigger (JSON, optional)
					</label>
					<textarea
						id="add-watch-trigger"
						bind:value={addTrigger}
						placeholder={addSignalType === 'stock'
							? '{"abs_change_pct_gte": 5}'
							: addSignalType === 'edgar'
								? '{"forms": ["8-K", "10-K"]}'
								: addSignalType === 'rss' ||
									  addSignalType === 'query' ||
									  addSignalType === 'page_watch'
									? '{"keywords": ["layoffs", "downtime"]}'
									: '{}'}
						rows={3}
						class="w-full rounded-lg border border-line bg-surface-input px-3 py-2 font-mono text-sm text-fg"
					></textarea>
				</div>
				<div class="grid grid-cols-2 gap-3">
					<div>
						<label class="mb-1 block text-xs text-fg-muted" for="add-watch-cadence">
							Cadence
						</label>
						<select
							id="add-watch-cadence"
							value={addCadence}
							onchange={(e) => (addCadence = e.currentTarget.value as WatchlistCadence)}
							class="w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm text-fg"
						>
							{#each CADENCES as c (c)}
								<option value={c}>{c}</option>
							{/each}
						</select>
					</div>
					<div>
						<label class="mb-1 block text-xs text-fg-muted" for="add-watch-mode">Mode</label>
						<select
							id="add-watch-mode"
							value={addMode}
							onchange={(e) => (addMode = e.currentTarget.value as 'active' | 'dry_run')}
							class="w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm text-fg"
						>
							<option value="active">active</option>
							<option value="dry_run">dry_run</option>
						</select>
					</div>
					<div>
						<label class="mb-1 block text-xs text-fg-muted" for="add-watch-severity-floor">
							Severity floor
						</label>
						<select
							id="add-watch-severity-floor"
							value={addSeverityFloor}
							onchange={(e) => (addSeverityFloor = e.currentTarget.value as WatchlistSeverity)}
							class="w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm text-fg"
						>
							{#each SEVERITIES as s (s)}
								<option value={s}>{s}</option>
							{/each}
						</select>
					</div>
					<div>
						<label class="mb-1 block text-xs text-fg-muted" for="add-watch-severity-ceiling">
							Severity ceiling
						</label>
						<select
							id="add-watch-severity-ceiling"
							value={addSeverityCeiling}
							onchange={(e) => (addSeverityCeiling = e.currentTarget.value as WatchlistSeverity)}
							class="w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm text-fg"
						>
							{#each SEVERITIES as s (s)}
								<option value={s}>{s}</option>
							{/each}
						</select>
					</div>
				</div>
				<div>
					<label class="mb-1 block text-xs text-fg-muted" for="add-watch-notes">Notes</label>
					<input
						id="add-watch-notes"
						bind:value={addNotes}
						maxlength={500}
						class="w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm text-fg"
					/>
				</div>
			</div>

			{#if addErr}
				<div
					class="mt-3 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
					role="alert"
				>
					{addErr}
				</div>
			{/if}

			<div class="mt-4 flex justify-end gap-2">
				<button
					type="button"
					disabled={addSaving}
					onclick={() => (showAdd = false)}
					class="cursor-pointer rounded-lg border border-line px-4 py-2 text-sm hover:bg-surface-overlay disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					type="button"
					disabled={addSaving || !addSlug.trim() || !addTarget.trim()}
					onclick={() => void submitAdd()}
					class="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
				>
					{addSaving ? 'Adding…' : 'Add monitor'}
				</button>
			</div>
		</Dialog.Content>
	</Dialog.Root>
{/snippet}

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-5xl px-6 py-6">
		<div class="mb-6 flex items-baseline justify-between">
			<div>
				<h1 class="text-xl font-semibold text-fg">Watch list</h1>
				<p class="mt-0.5 text-sm text-fg-muted">
					External conditions the Executive is monitoring. Signals that survive severity + triage
					become proposals in your briefing.
				</p>
			</div>
			<button
				type="button"
				onclick={openAdd}
				class="shrink-0 cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
			>
				+ Add monitor
			</button>
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

		{#if !loading && !error && items.length === 0}
			<div class="rounded-xl border border-line bg-surface-elevated p-8 text-center">
				<p class="mb-3 text-sm text-fg-muted">Nothing being watched yet.</p>
				<p class="mb-4 text-xs text-fg-subtle">
					Ask the Executive in chat: <span class="italic"
						>Watch Apple stock, alert me on 5% moves.</span
					>
				</p>
				<button
					type="button"
					onclick={openAdd}
					class="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500"
				>
					Add a monitor →
				</button>
			</div>
		{/if}

		{#if suggestions.length > 0}
			<div class="mb-8">
				<div class="mb-1 flex items-baseline gap-2">
					<span class="text-sm font-semibold text-fg">Suggested by the Executive</span>
					<span class="text-xs text-fg-muted">{suggestions.length} waiting for you</span>
				</div>
				<p class="mb-3 text-xs text-fg-subtle">
					Sources the research council thought worth monitoring but couldn't tie firmly enough to
					your company data to add on its own. They poll in shadow mode and never alert until you
					approve. Declines are remembered.
				</p>
				<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
					{#each suggestions as item (item.id)}
						{@render SuggestionCard(
							item,
							busySlugs.has(item.slug),
							departmentTitles[item.route_to_department]
						)}
					{/each}
				</div>
			</div>
		{/if}

		<div class="space-y-6">
			{#each groups as group (group.key)}
				{@const isCollapsed = !!collapsed[group.key]}
				<div>
					<button
						type="button"
						onclick={() => toggleCollapsed(group.key)}
						class="mb-3 flex w-full cursor-pointer items-center gap-2 text-left"
					>
						<span
							class={`text-xs text-fg-muted transition-transform ${isCollapsed ? '' : 'rotate-90'}`}
						>
							▶
						</span>
						<span class="text-sm font-semibold text-fg">{group.label}</span>
						<span class="text-xs text-fg-muted">
							{`${group.items.length} ${group.items.length === 1 ? 'monitor' : 'monitors'}`}
						</span>
					</button>
					{#if !isCollapsed}
						<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
							{#each group.items as item (item.id)}
								{@render WatchCard(
									item,
									busySlugs.has(item.slug),
									departmentTitles[item.route_to_department]
								)}
							{/each}
						</div>
					{/if}
				</div>
			{/each}
		</div>
	</div>
</main>

{#if showAdd}
	{@render AddWatchDialog()}
{/if}

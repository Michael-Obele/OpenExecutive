<script lang="ts" module>
	import type { UsageTotals } from '$lib/api.js';

	function fmtInt(n: number): string {
		return (n ?? 0).toLocaleString();
	}

	// Cost spans wide ranges (sub-cent per call up to dollars in aggregate), so
	// show more precision when small to avoid a misleading "$0.00".
	function fmtCost(n: number): string {
		const v = n ?? 0;
		if (v === 0) return '$0';
		return `$${v.toFixed(v < 1 ? 4 : 2)}`;
	}

	// Cache-hit ratio: prompt input served from cache as a fraction of ALL prompt
	// input (fresh + cache reads + cache writes). cache_creation tokens are billed
	// prompt input too, so they belong in the denominator. The whole system is
	// designed around prompt caching, so this is the key cost signal.
	function cacheHitPct(
		u: Pick<UsageTotals, 'cache_read_input_tokens' | 'input_tokens' | 'cache_creation_input_tokens'>
	): number {
		const denom = u.cache_read_input_tokens + u.input_tokens + u.cache_creation_input_tokens;
		if (denom <= 0) return 0;
		return Math.round((u.cache_read_input_tokens / denom) * 100);
	}

	const COL_HEADERS = [
		'Calls',
		'Input',
		'Cache read',
		'Cache write',
		'Output',
		'Searches',
		'Cached',
		'Cost'
	];

	// Debounce window for refetching as the date-range filter changes (matches
	// the /audit list page).
	const DEBOUNCE_MS = 250;
</script>

<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { getAuditUsage, type UsageSummary } from '$lib/api.js';

	let data = $state.raw<UsageSummary | null>(null);
	let loading = $state<boolean>(true);
	let error = $state<string | null>(null);
	let since = $state<string>('');
	let until = $state<string>('');

	const params = $derived.by<{ since?: string; until?: string }>(() => ({
		// `datetime-local` returns naive strings; the backend `ts` column is ISO
		// with offset and filters by string comparison, so normalize to ISO.
		since: since ? new Date(since).toISOString() : undefined,
		until: until ? new Date(until).toISOString() : undefined
	}));

	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleRefresh() {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void refresh();
		}, DEBOUNCE_MS);
	}

	onMount(() => {
		scheduleRefresh();
	});

	onDestroy(() => {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
	});

	async function refresh() {
		loading = true;
		error = null;
		try {
			data = await getAuditUsage(params);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load';
		} finally {
			loading = false;
		}
	}

	function handleSince(value: string) {
		since = value;
		scheduleRefresh();
	}

	function handleUntil(value: string) {
		until = value;
		scheduleRefresh();
	}

	function handleClearFilters() {
		since = '';
		until = '';
		scheduleRefresh();
	}

	let totals = $derived(data?.totals);
	let maxDayInput = $derived(
		Math.max(1, ...(data?.by_day ?? []).map((d) => d.input_tokens + d.cache_read_input_tokens))
	);
</script>

{#snippet statCard(label: string, value: string, hint?: string)}
	<div class="rounded-xl border border-line bg-surface-elevated/40 px-4 py-3">
		<div class="text-xs text-fg-muted">{label}</div>
		<div class="mt-1 text-lg font-semibold text-fg tabular-nums">{value}</div>
		{#if hint}
			<div class="mt-0.5 text-[11px] text-fg-subtle">{hint}</div>
		{/if}
	</div>
{/snippet}

{#snippet usageRowCells(u: UsageTotals)}
	<td class="px-3 py-1.5 text-right tabular-nums">{fmtInt(u.calls)}</td>
	<td class="px-3 py-1.5 text-right tabular-nums">{fmtInt(u.input_tokens)}</td>
	<td class="px-3 py-1.5 text-right tabular-nums">{fmtInt(u.cache_read_input_tokens)}</td>
	<td class="px-3 py-1.5 text-right tabular-nums">{fmtInt(u.cache_creation_input_tokens)}</td>
	<td class="px-3 py-1.5 text-right tabular-nums">{fmtInt(u.output_tokens)}</td>
	<td class="px-3 py-1.5 text-right tabular-nums">{fmtInt(u.web_search_requests ?? 0)}</td>
	<td class="px-3 py-1.5 text-right tabular-nums">{cacheHitPct(u)}%</td>
	<td class="px-3 py-1.5 text-right tabular-nums">{fmtCost(u.cost_usd)}</td>
{/snippet}

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-6xl px-6 py-6">
		<div class="flex items-center justify-between gap-4">
			<h1 class="text-xl font-semibold text-fg">Token usage</h1>
			<a
				href="/audit"
				class="text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
			>
				← Audit log
			</a>
		</div>
		<p class="mt-1 text-sm text-fg-muted">
			Aggregate token usage and cost across all sessions, summed from the audit log. Days are UTC.
			Cost is the actual OpenRouter charge captured per call — it accrues from when cost tracking
			went live, so calls logged before then count tokens but $0.
		</p>

		<!-- Date-range filter -->
		<div class="mt-5 grid grid-cols-1 gap-3 md:grid-cols-4">
			<label class="flex flex-col gap-1 text-xs text-fg-muted">
				From
				<input
					type="datetime-local"
					value={since}
					oninput={(e) => handleSince(e.currentTarget.value)}
					class="rounded-lg border border-line bg-surface-elevated px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none"
				/>
			</label>
			<label class="flex flex-col gap-1 text-xs text-fg-muted">
				Until
				<input
					type="datetime-local"
					value={until}
					oninput={(e) => handleUntil(e.currentTarget.value)}
					class="rounded-lg border border-line bg-surface-elevated px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none"
				/>
			</label>
			<div class="flex items-end">
				<button
					type="button"
					onclick={handleClearFilters}
					class="rounded-lg border border-line-strong bg-surface-overlay px-3 py-1.5 text-sm hover:bg-surface-input"
				>
					Clear filters
				</button>
			</div>
			<div class="flex items-end pb-1.5 text-xs text-fg-muted" role="status">
				{loading ? 'Loading…' : `${fmtInt(totals?.calls ?? 0)} calls`}
			</div>
		</div>

		{#if error}
			<div
				class="mt-6 rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-sm text-rose-300"
				role="alert"
			>
				{error}
			</div>
		{/if}

		<!-- Totals -->
		{#if totals}
			<div class="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
				{@render statCard('Cost (USD)', fmtCost(totals.cost_usd), 'actual charged')}
				{@render statCard('Calls', fmtInt(totals.calls))}
				{@render statCard(
					'Cache hit',
					`${cacheHitPct(totals)}%`,
					'of prompt input served from cache'
				)}
				{@render statCard('Output tokens', fmtInt(totals.output_tokens))}
				{@render statCard('Fresh input', fmtInt(totals.input_tokens))}
				{@render statCard('Cache read', fmtInt(totals.cache_read_input_tokens))}
				{@render statCard('Cache write', fmtInt(totals.cache_creation_input_tokens))}
				{@render statCard(
					'Searches',
					fmtInt(totals.web_search_requests ?? 0),
					'server-side web searches'
				)}
			</div>
		{/if}

		<!-- By source -->
		{#if data && data.by_source && data.by_source.length > 0}
			<section class="mt-8">
				<h2 class="mb-2 text-sm font-medium text-fg">By source</h2>
				<p class="mb-2 text-xs text-fg-muted">
					Which part of the system made the calls: chat turns, research specialists, the research
					routing and watchlist passes, triage, memory extraction.
				</p>
				<div class="overflow-hidden rounded-xl border border-line">
					<table class="w-full text-sm">
						<thead>
							<tr class="bg-surface-elevated/60 text-xs text-fg-muted">
								<th scope="col" class="px-3 py-2 text-left font-medium">Source</th>
								{#each COL_HEADERS as h (h)}
									<th scope="col" class="px-3 py-2 text-right font-medium">{h}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each data.by_source as s (s.source)}
								<tr class="border-t border-line/60">
									<td class="px-3 py-1.5 font-mono text-xs text-fg">{s.source}</td>
									{@render usageRowCells(s)}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}

		<!-- By model -->
		{#if data && data.by_model.length > 0}
			<section class="mt-8">
				<h2 class="mb-2 text-sm font-medium text-fg">By model</h2>
				<div class="overflow-hidden rounded-xl border border-line">
					<table class="w-full text-sm">
						<thead>
							<tr class="bg-surface-elevated/60 text-xs text-fg-muted">
								<th scope="col" class="px-3 py-2 text-left font-medium">Model</th>
								{#each COL_HEADERS as h (h)}
									<th scope="col" class="px-3 py-2 text-right font-medium">{h}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each data.by_model as m (m.model)}
								<tr class="border-t border-line/60">
									<td class="px-3 py-1.5 font-mono text-xs text-fg">{m.model}</td>
									{@render usageRowCells(m)}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}

		<!-- By day -->
		{#if data && data.by_day.length > 0}
			<section class="mt-8">
				<h2 class="mb-2 text-sm font-medium text-fg">By day (UTC)</h2>
				<div class="overflow-hidden rounded-xl border border-line">
					<table class="w-full text-sm">
						<thead>
							<tr class="bg-surface-elevated/60 text-xs text-fg-muted">
								<th scope="col" class="px-3 py-2 text-left font-medium">Day</th>
								{#each COL_HEADERS as h (h)}
									<th scope="col" class="px-3 py-2 text-right font-medium">{h}</th>
								{/each}
							</tr>
						</thead>
						<tbody>
							{#each data.by_day as d (d.day)}
								{@const pct = ((d.input_tokens + d.cache_read_input_tokens) / maxDayInput) * 100}
								<tr class="border-t border-line/60">
									<td class="px-3 py-1.5">
										<div class="text-xs text-fg tabular-nums">{d.day}</div>
										<div class="mt-1 h-1 overflow-hidden rounded bg-surface-input/60">
											<div class="h-full bg-indigo-500/60" style="width: {pct}%"></div>
										</div>
									</td>
									{@render usageRowCells(d)}
								</tr>
							{/each}
						</tbody>
					</table>
				</div>
			</section>
		{/if}

		{#if !loading && data && data.by_model.length === 0}
			<div class="mt-8 text-sm text-fg-muted">No token usage recorded for this range yet.</div>
		{/if}
	</div>
</main>

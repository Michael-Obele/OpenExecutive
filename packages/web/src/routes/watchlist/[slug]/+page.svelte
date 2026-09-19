<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';

	import {
		deleteWatchlistItem,
		getWatchlistItem,
		getWatchlistSignals,
		patchWatchlistItem,
		type WatchlistItem,
		type WatchlistSignal
	} from '$lib/api.js';

	/** Relative time for display, e.g. "3h ago", "just now", "never". */
	function formatRelTime(iso: string | null): string {
		if (!iso) return 'never';
		try {
			const diff = new Date(iso).getTime() - Date.now();
			// new Date("garbage") yields NaN rather than throwing; every comparison
			// below would be false and fall through to "NaNd ago".
			if (!Number.isFinite(diff)) return '—';
			// A timestamp slightly ahead of the browser clock (published_at within
			// the server's skew tolerance) reads as "just now", never a fabricated
			// past.
			// A value well ahead of the browser clock is reported as such rather
			// than dressed up as recent (the source controls published_at). The
			// tolerance absorbs ordinary browser/server clock drift, so our own
			// timestamps don't read as tampered with.
			if (diff > 300_000) return 'in the future';
			if (diff > -60_000) return 'just now';
			const abs = Math.abs(diff);
			if (abs < 3_600_000) return `${Math.round(abs / 60_000)}m ago`;
			if (abs < 86_400_000) return `${Math.round(abs / 3_600_000)}h ago`;
			return `${Math.round(abs / 86_400_000)}d ago`;
		} catch {
			return '—';
		}
	}

	function outcomeStyle(outcome: string | null): string {
		if (outcome === 'alerted') return 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30';
		if (outcome === 'failed') return 'bg-rose-500/20 text-rose-300 border-rose-500/30';
		if (outcome === null) return 'bg-amber-500/20 text-amber-300 border-amber-500/30';
		// suppressed_* variants
		return 'bg-zinc-500/20 text-zinc-400 border-zinc-500/30';
	}

	function outcomeLabel(outcome: string | null): string {
		if (outcome === null) return 'pending';
		return outcome.replace(/^suppressed_/, 'suppressed: ');
	}

	// Next.js already decoded dynamic params; SvelteKit likewise hands us the
	// decoded slug, so no second decode is needed.
	const slug = page.params.slug;

	let item = $state.raw<WatchlistItem | null>(null);
	let signals = $state.raw<WatchlistSignal[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let notes = $state('');
	let savingNotes = $state(false);
	let confirming = $state(false);
	// Single in-flight slot per mutation type. Prevents the optimistic
	// toggle-revert race where two clicks land in the wrong final state.
	let toggling = $state(false);
	let modeChanging = $state(false);

	onMount(() => {
		if (!slug) return;
		Promise.all([getWatchlistItem(slug), getWatchlistSignals(slug, 50)])
			.then(([w, s]) => {
				item = w;
				notes = w.notes;
				signals = s;
			})
			.catch((e) => (error = e instanceof Error ? e.message : 'Failed to load'))
			.finally(() => (loading = false));
	});

	// `slug` is always present on this route; the guard is for the type checker,
	// which only knows it is `string | undefined`.
	async function toggleEnabled() {
		if (!item || !slug || toggling) return;
		const next = !item.enabled;
		toggling = true;
		item = { ...item, enabled: next };
		try {
			item = await patchWatchlistItem(slug, { enabled: next });
		} catch (e) {
			item = { ...item, enabled: !next };
			error = e instanceof Error ? e.message : 'Toggle failed';
		} finally {
			toggling = false;
		}
	}

	async function toggleMode() {
		if (!item || !slug || modeChanging) return;
		const nextMode = item.mode === 'active' ? 'dry_run' : 'active';
		modeChanging = true;
		try {
			item = await patchWatchlistItem(slug, { mode: nextMode });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Mode change failed';
		} finally {
			modeChanging = false;
		}
	}

	async function saveNotes() {
		if (!item || !slug || notes === item.notes) return;
		savingNotes = true;
		try {
			item = await patchWatchlistItem(slug, { notes });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Save failed';
		} finally {
			savingNotes = false;
		}
	}

	async function remove() {
		if (!slug) return;
		try {
			await deleteWatchlistItem(slug);
			void goto('/watchlist');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Delete failed';
			confirming = false;
		}
	}
</script>

{#snippet SignalRow(signal: WatchlistSignal)}
	<li class="rounded-lg border border-line bg-surface-elevated p-3">
		<div class="mb-1 flex items-start justify-between gap-2">
			<div class="min-w-0 flex-1">
				<div class="truncate text-sm text-fg" title={signal.normalized_summary}>
					{signal.normalized_summary}
				</div>
				<div class="mt-0.5 text-[11px] text-fg-muted">
					{signal.published_at
						? `published ${formatRelTime(signal.published_at)} · seen ${formatRelTime(signal.captured_at)}`
						: formatRelTime(signal.captured_at)}
					· severity {signal.severity_hint}
				</div>
			</div>
			<span
				class={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${outcomeStyle(signal.processed_outcome)}`}
			>
				{outcomeLabel(signal.processed_outcome)}
			</span>
		</div>
		<div class="flex items-center gap-3 text-[11px]">
			{#if signal.provenance_url}
				<a
					href={signal.provenance_url}
					target="_blank"
					rel="noreferrer"
					class="max-w-xs truncate text-indigo-300 hover:text-indigo-200"
				>
					source ↗
				</a>
			{/if}
			{#if signal.promoted_alert_id != null}
				<span class="text-fg-subtle">alert #{signal.promoted_alert_id}</span>
			{/if}
		</div>
	</li>
{/snippet}

{#if loading}
	<div class="p-6">
		<p class="text-sm text-fg-muted" role="status">Loading…</p>
	</div>
{:else if error && !item}
	<div class="p-6">
		<a href="/watchlist" class="text-xs text-indigo-300 hover:text-indigo-200">← Back</a>
		<div
			class="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
			role="alert"
		>
			{error}
		</div>
	</div>
{:else if item}
	<main class="min-h-0 flex-1 overflow-y-auto">
		<div class="mx-auto max-w-3xl px-6 py-6">
			<a href="/watchlist" class="mb-4 inline-block text-xs text-indigo-300 hover:text-indigo-200">
				← Watch list
			</a>

			<div class="mb-4 flex items-baseline justify-between gap-4">
				<div class="min-w-0">
					<h1 class="truncate font-mono text-xl font-semibold text-fg">{item.slug}</h1>
					<p class="mt-0.5 truncate text-sm text-fg-muted" title={item.target}>
						{item.signal_type} · {item.target}
					</p>
				</div>
				<div class="flex items-center gap-2">
					<button
						type="button"
						onclick={() => void toggleEnabled()}
						disabled={toggling}
						class={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs disabled:opacity-60 ${
							item.enabled
								? 'border-indigo-500/30 bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30'
								: 'border-zinc-500/30 bg-zinc-500/20 text-zinc-400 hover:bg-zinc-500/30'
						}`}
					>
						{item.enabled ? 'Enabled' : 'Disabled'}
					</button>
					<button
						type="button"
						onclick={() => void toggleMode()}
						disabled={modeChanging}
						class="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted hover:bg-surface-overlay disabled:opacity-60"
					>
						mode: {item.mode}
					</button>
				</div>
			</div>

			{#if error}
				<div
					class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
					role="alert"
				>
					{error}
				</div>
			{/if}

			<div class="mb-4 rounded-xl border border-line bg-surface-elevated p-4">
				<h2 class="mb-3 text-xs tracking-wide text-fg-subtle uppercase">Configuration</h2>
				<dl class="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
					<dt class="text-fg-muted">Cadence</dt>
					<dd class="text-fg">{item.cadence}</dd>
					<dt class="text-fg-muted">Severity range</dt>
					<dd class="text-fg">{`${item.severity_floor} → ${item.severity_ceiling}`}</dd>
					<dt class="text-fg-muted">Specialist</dt>
					<dd class="text-fg">{item.route_to_specialist || '—'}</dd>
					<dt class="text-fg-muted">Fired count</dt>
					<dd class="text-fg">{item.fired_count}</dd>
					<dt class="text-fg-muted">Dismissed</dt>
					<dd class="text-fg">{item.dismiss_count}</dd>
					<dt class="text-fg-muted">Trust score</dt>
					<dd class="text-fg">{item.trust_score.toFixed(2)}</dd>
					<dt class="text-fg-muted">Last polled</dt>
					<dd class="text-fg">{formatRelTime(item.last_polled_at)}</dd>
					<dt class="text-fg-muted">Last fired</dt>
					<dd class="text-fg">{formatRelTime(item.last_fired_at)}</dd>
				</dl>
				<div class="mt-3">
					<div class="mb-1 text-xs text-fg-muted">Trigger</div>
					<pre
						class="overflow-x-auto rounded border border-line bg-surface-input/40 p-2 font-mono text-[11px]">{JSON.stringify(
							item.trigger_json,
							null,
							2
						)}</pre>
				</div>
			</div>

			<div class="mb-4 rounded-xl border border-line bg-surface-elevated p-4">
				<h2 class="mb-2 text-xs tracking-wide text-fg-subtle uppercase">Notes</h2>
				<textarea
					bind:value={notes}
					onblur={() => void saveNotes()}
					rows={3}
					maxlength={500}
					placeholder="Why are we watching this?"
					aria-label="Notes"
					class="w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm text-fg"
				></textarea>
				{#if savingNotes}
					<p class="mt-1 text-[10px] text-fg-subtle" role="status">Saving…</p>
				{/if}
			</div>

			<div class="mb-4 rounded-xl border border-line bg-surface-elevated p-4">
				<h2 class="mb-3 text-xs tracking-wide text-fg-subtle uppercase">
					Recent signals ({signals.length})
				</h2>
				{#if signals.length === 0}
					<p class="text-xs text-fg-muted">
						No signals yet. The next poll runs on cadence: {item.cadence}.
					</p>
				{:else}
					<ul class="space-y-2">
						{#each signals as s (s.id)}
							{@render SignalRow(s)}
						{/each}
					</ul>
				{/if}
			</div>

			<div class="rounded-xl border border-rose-500/30 bg-rose-500/5 p-4">
				<h2 class="mb-2 text-xs tracking-wide text-rose-300 uppercase">Danger zone</h2>
				{#if confirming}
					<div class="flex items-center gap-2">
						<span class="text-xs text-fg-muted">
							Delete this monitor? Historical signals stay in the audit log.
						</span>
						<button
							type="button"
							onclick={() => void remove()}
							class="cursor-pointer rounded-lg bg-rose-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-rose-500"
						>
							Delete
						</button>
						<button
							type="button"
							onclick={() => (confirming = false)}
							class="cursor-pointer rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-surface-overlay"
						>
							Cancel
						</button>
					</div>
				{:else}
					<button
						type="button"
						onclick={() => (confirming = true)}
						class="cursor-pointer rounded-lg border border-rose-500/30 px-3 py-1.5 text-xs text-rose-300 hover:bg-rose-500/10"
					>
						Delete monitor
					</button>
				{/if}
			</div>
		</div>
	</main>
{/if}

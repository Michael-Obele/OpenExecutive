<script lang="ts">
	// Read-only list of the open-licensed reference library, with a chunk peek.
	// Ported from `packages/ui/src/components/knowledge/ReferencePanel.tsx`.
	import { onMount } from 'svelte';
	import {
		listExternalSources,
		peekExternalSource,
		type ExternalPeekChunk,
		type ExternalSourceInfo
	} from '$lib/api.js';

	let sources = $state.raw<ExternalSourceInfo[] | null>(null);
	let totalChunks = $state(0);
	let error = $state<string | null>(null);
	let peeking = $state<string | null>(null);
	let peekChunks = $state.raw<ExternalPeekChunk[]>([]);
	let peekError = $state<string | null>(null);

	onMount(() => {
		listExternalSources()
			.then((data) => {
				sources = data.sources;
				totalChunks = data.total_chunks;
			})
			.catch(() => (error = 'Failed to load reference library'));
	});

	async function handlePeek(id: string) {
		peeking = id;
		peekChunks = [];
		peekError = null;
		try {
			const data = await peekExternalSource(id, 5);
			peekChunks = data.chunks;
			if (data.chunks.length === 0) {
				peekError =
					'No indexed chunks yet — run `openexecutive ingest-oer` to populate this source.';
			}
		} catch {
			peekError = 'Failed to load chunks';
		}
	}

	let ingested = $derived((sources ?? []).filter((s) => s.is_ingested));
	let pending = $derived((sources ?? []).filter((s) => !s.is_ingested));
</script>

{#snippet sourceCard({
	source,
	isExpanded,
	chunks,
	peekError,
	onPeek,
	onCollapse
}: {
	source: ExternalSourceInfo;
	isExpanded: boolean;
	chunks: ExternalPeekChunk[];
	peekError: string | null;
	onPeek: () => void;
	onCollapse: () => void;
})}
	<div class="overflow-hidden rounded-xl border border-line-strong/50 bg-surface-overlay/60">
		<div class="flex items-start justify-between gap-4 px-4 py-3">
			<div class="min-w-0 flex-1">
				<div class="flex flex-wrap items-center gap-2">
					<p class="text-sm font-medium text-fg">{source.title}</p>
					<span
						class={`rounded px-1.5 py-0.5 text-[10px] tracking-wide uppercase ${
							source.is_ingested
								? 'border border-emerald-900/60 bg-emerald-950/60 text-emerald-400'
								: 'border border-line-strong/60 bg-surface-input/60 text-fg-muted'
						}`}
					>
						{source.is_ingested ? 'ingested' : 'pending'}
					</span>
					<span
						class="rounded border border-line-strong px-1.5 py-0.5 text-[10px] tracking-wide text-fg-muted uppercase"
					>
						phase {source.phase}
					</span>
				</div>
				<p class="mt-1 text-xs text-fg-muted">
					{source.publisher} · {source.license} ·
					<a
						href={source.url}
						target="_blank"
						rel="noopener noreferrer"
						class="text-fg-muted underline-offset-2 hover:text-fg hover:underline"
					>
						source ↗
					</a>
				</p>
				<div class="mt-2 flex flex-wrap items-center gap-1.5">
					{#each source.domains as d (d)}
						<span
							class="rounded border border-line-strong/60 bg-surface-input/60 px-1.5 py-0.5 text-[10px] text-fg-muted"
						>
							{d}
						</span>
					{/each}
				</div>
				<p class="mt-2 text-xs text-fg-muted">
					{source.chunks.toLocaleString()} chunks · {source.files} file{source.files === 1
						? ''
						: 's'} · fetched {source.last_fetched_at
						? new Date(source.last_fetched_at * 1000).toLocaleString()
						: 'never'}
				</p>
			</div>
			<button
				type="button"
				onclick={isExpanded ? onCollapse : onPeek}
				disabled={!source.is_ingested}
				class="shrink-0 rounded-lg border border-line-strong/60 bg-surface-input/60 px-3 py-1.5 text-xs text-fg transition-colors hover:bg-surface-input disabled:cursor-not-allowed disabled:opacity-40"
			>
				{isExpanded ? 'Hide' : 'Peek'}
			</button>
		</div>
		{#if isExpanded}
			<div class="space-y-2 border-t border-line-strong/50 bg-surface-elevated/40 px-4 py-3">
				{#if peekError}
					<p class="text-xs text-fg-muted">{peekError}</p>
				{/if}
				{#each chunks as c (`${c.filename}-${c.chunk_index}-${c.domain}`)}
					<div
						class="rounded-lg border border-line-strong/50 bg-surface-overlay/60 px-3 py-2 text-xs text-fg"
					>
						<p class="mb-1 text-[10px] text-fg-muted">
							{c.domain} · {c.filename} · chunk #{c.chunk_index}
						</p>
						<p class="leading-relaxed whitespace-pre-wrap">
							{c.text.length > 600 ? c.text.slice(0, 600) + '…' : c.text}
						</p>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

{#if error}
	<div
		class="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-400"
		role="alert"
	>
		{error}
	</div>
{:else if sources === null}
	<p class="text-sm text-fg-muted" role="status">Loading…</p>
{:else}
	<div class="space-y-6">
		<div>
			<h2 class="text-base font-semibold text-fg">Reference Library</h2>
			<p class="mt-1 text-sm text-fg-muted">
				Open-licensed textbooks and handbooks the Executive draws on. Declared in
				<code class="text-fg">knowledge/sources.yaml</code>. To add or refresh: run
				<code class="text-fg">openexecutive ingest-oer</code>.
			</p>
			<p class="mt-2 text-xs text-fg-muted">
				{ingested.length} ingested · {pending.length} pending ·
				{totalChunks.toLocaleString()} indexed chunks
			</p>
		</div>

		<div class="space-y-2">
			{#each sources as src (src.id)}
				{@render sourceCard({
					source: src,
					isExpanded: peeking === src.id,
					chunks: peeking === src.id ? peekChunks : [],
					peekError: peeking === src.id ? peekError : null,
					onPeek: () => void handlePeek(src.id),
					onCollapse: () => {
						peeking = null;
						peekChunks = [];
						peekError = null;
					}
				})}
			{/each}
		</div>
	</div>
{/if}

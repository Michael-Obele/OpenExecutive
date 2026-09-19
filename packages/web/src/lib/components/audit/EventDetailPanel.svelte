<script lang="ts">
	// Event detail panel — type-specific renderers. Falls back to a JSON dump for
	// unknown event types so new instrumentation surfaces without code changes.
	// Ported from `EventDetailPanel` (and its helper components) in
	// `packages/ui/src/app/audit/session/[id]/page.tsx`; each React helper is
	// now a template snippet below.
	import type { AuditEvent, AuditEventDetail } from '$lib/api.js';
	import { deriveKind, formatTs, kindStyle } from './session-graph.js';

	type Chunk = {
		source?: string;
		domain?: string;
		distance?: number;
		text_preview?: string;
	};

	type Critique = {
		reviewer?: string;
		severity?: string;
		critique?: string;
		suggested_edits?: string;
	};

	let {
		event,
		detail,
		onOpenDrawer
	}: {
		event: AuditEvent;
		detail: AuditEventDetail | null;
		onOpenDrawer: () => void;
	} = $props();

	let d = $derived((event.details ?? {}) as Record<string, unknown>);
	let full = $derived(detail?.full ?? null);
	let style = $derived(kindStyle(deriveKind(event.event_type)));

	let systemBlocks = $derived.by<string[] | null>(() => {
		const v = d.system_blocks;
		return Array.isArray(v) ? (v as string[]) : null;
	});

	let activePromptBlocks = $derived.by<string[] | null>(() => {
		const v = full?.active_prompt_blocks;
		return Array.isArray(v) ? (v as string[]) : null;
	});

	// `full` arrives as an untyped drill-down payload, so the chunk arrays are
	// cast exactly where the Next.js source cast them.
	let builtinChunks = $derived.by<Chunk[]>(
		() => (full?.builtin_chunks as Chunk[] | undefined) ?? []
	);
	let companyChunks = $derived.by<Chunk[]>(
		() => (full?.company_chunks as Chunk[] | undefined) ?? []
	);
	let critiques = $derived.by<Critique[]>(() => (d.critiques as Critique[] | undefined) ?? []);

	let cacheTokens = $derived.by(() => {
		const cr = Number(d.cache_read_input_tokens ?? 0);
		const cc = Number(d.cache_creation_input_tokens ?? 0);
		const inp = Number(d.input_tokens ?? 0);
		const out = Number(d.output_tokens ?? 0);
		return { cr, cc, inp, out, total: cr + cc + inp };
	});

	function tokenPct(n: number, total: number): number {
		return total > 0 ? Math.round((n / total) * 100) : 0;
	}
</script>

{#snippet label(text: string)}
	<div class="mb-1 text-[10px] tracking-wide text-fg-muted uppercase">{text}</div>
{/snippet}

{#snippet kvList(obj: Record<string, unknown>)}
	{#each Object.entries(obj).filter(([, v]) => v !== undefined && v !== null) as [k, v] (k)}
		<div class="contents">
			<dt class="font-mono text-fg-muted">{k}</dt>
			<dd class="font-mono break-all">
				{typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
					? String(v)
					: JSON.stringify(v)}
			</dd>
		</div>
	{/each}
{/snippet}

{#snippet tokenBar(text: string, value: number, pct: number, color: string)}
	<div class="text-[10px]">
		<div class="flex justify-between">
			<span class="text-fg-muted">{text}</span>
			<span class="font-mono">{value} ({pct}%)</span>
		</div>
		<div class="mt-0.5 h-1.5 overflow-hidden rounded bg-surface-input">
			<div class={`${color} h-full`} style="width: {pct}%"></div>
		</div>
	</div>
{/snippet}

{#snippet chunkRow(chunk: Chunk)}
	<li class="rounded bg-black/30 p-2">
		<div class="mb-1 flex items-center gap-2 text-[10px] text-fg-muted">
			<span class="font-mono text-fg">{chunk.source ?? '?'}</span>
			{#if chunk.domain}
				<span>· {chunk.domain}</span>
			{/if}
			{#if typeof chunk.distance === 'number'}
				<span>· dist={chunk.distance.toFixed(3)}</span>
			{/if}
		</div>
		<div class="text-[11px] break-words whitespace-pre-wrap text-fg">
			{chunk.text_preview ?? ''}
		</div>
	</li>
{/snippet}

<div class="h-full overflow-y-auto p-4 text-fg">
	<!-- Header -->
	<div class="mb-3 border-b border-line pb-3">
		<div class="mb-1 flex items-center gap-2">
			<span
				class={`inline-block rounded-full border border-line px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}
			>
				{event.event_type}
			</span>
			<span class="text-xs text-fg-muted">@ {formatTs(event.ts)}</span>
			<span class="text-xs text-fg-muted">·</span>
			<span class="text-xs text-fg-muted">actor: {event.actor ?? '—'}</span>
		</div>
		<div class="text-sm break-words text-fg">{event.summary}</div>
	</div>

	<!-- Type-specific body -->
	{#if event.event_type === 'memory_snapshot'}
		<div class="space-y-3 text-xs">
			<div>
				{@render label('Summary')}
				<dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
					{@render kvList({
						model: d.model,
						committee_review: d.committee_review,
						history_len: d.history_len,
						episodic_chars: d.episodic_chars,
						retrieved_chars: d.retrieved_chars,
						company_profile_hash: d.company_profile_hash
					})}
				</dl>
			</div>
			<div>
				{@render label('System prompt blocks (live this turn)')}
				{#if systemBlocks}
					<ul class="space-y-1">
						{#each systemBlocks as b, i (i)}
							<li class="font-mono text-fg">· {b}</li>
						{/each}
					</ul>
				{:else}
					<div class="text-fg-muted italic">none</div>
				{/if}
			</div>
			{#if full?.episodic_context}
				<div>
					{@render label('Episodic context (what the agent remembered)')}
					<pre
						class="max-h-48 overflow-y-auto rounded bg-black/30 p-2 text-[11px] break-words whitespace-pre-wrap">{String(
							full.episodic_context
						)}</pre>
				</div>
			{/if}
			{#if full?.retrieved_context}
				<div>
					{@render label('RAG context (chunks injected into the user turn)')}
					<pre
						class="max-h-48 overflow-y-auto rounded bg-black/30 p-2 text-[11px] break-words whitespace-pre-wrap">{String(
							full.retrieved_context
						)}</pre>
				</div>
			{/if}
			<!-- company profile is hashed-only by design — see _emit_memory_snapshot.
			     The hash is shown in the summary KVList above. -->
		</div>
	{:else if event.event_type === 'knowledge_retrieval'}
		<div class="space-y-3 text-xs">
			<div>
				{@render label('Query')}
				<pre class="rounded bg-black/30 p-2 text-[11px] break-words whitespace-pre-wrap">{String(
						d.query ?? full?.query ?? ''
					)}</pre>
			</div>
			<div>
				{@render label(`Built-in chunks (${builtinChunks.length})`)}
				{#if builtinChunks.length === 0}
					<div class="text-fg-muted italic">none</div>
				{:else}
					<ul class="space-y-2">
						{#each builtinChunks as c, i (i)}
							{@render chunkRow(c)}
						{/each}
					</ul>
				{/if}
			</div>
			<div>
				{@render label(`Company chunks (${companyChunks.length})`)}
				{#if companyChunks.length === 0}
					<div class="text-fg-muted italic">none</div>
				{:else}
					<ul class="space-y-2">
						{#each companyChunks as c, i (i)}
							{@render chunkRow(c)}
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	{:else if event.event_type === 'specialist_consult'}
		<div class="space-y-3 text-xs">
			<div>
				{@render label('Routing')}
				<dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
					{@render kvList({
						iteration: d.iteration,
						duration_ms: d.duration_ms,
						context_preview: d.context_preview
					})}
				</dl>
			</div>
			{#if full?.query}
				<div>
					{@render label('Query sent to specialist')}
					<pre class="rounded bg-black/30 p-2 text-[11px] break-words whitespace-pre-wrap">{String(
							full.query
						)}</pre>
				</div>
			{/if}
			{#if full?.context}
				<div>
					{@render label('Routing context')}
					<pre class="rounded bg-black/30 p-2 text-[11px] break-words whitespace-pre-wrap">{String(
							full.context
						)}</pre>
				</div>
			{/if}
			{#if full?.response}
				<div>
					{@render label('Specialist response')}
					<pre
						class="max-h-72 overflow-y-auto rounded bg-black/30 p-2 text-[11px] break-words whitespace-pre-wrap">{String(
							full.response
						)}</pre>
				</div>
			{/if}
			{#if activePromptBlocks}
				<div>
					{@render label('Active system blocks')}
					<ul class="space-y-1 font-mono text-fg">
						{#each activePromptBlocks as b, i (i)}
							<li>· {b}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	{:else if event.event_type === 'tool_invocation'}
		<div class="space-y-3 text-xs">
			<div>
				{@render label('Tool')}
				<dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
					{@render kvList({ tool: d.tool, kind: d.kind, iteration: d.iteration })}
				</dl>
			</div>
			{#if full?.input !== undefined}
				<div>
					{@render label('Input')}
					<pre
						class="max-h-48 overflow-y-auto rounded bg-black/30 p-2 text-[11px] break-words whitespace-pre-wrap">{JSON.stringify(
							full.input,
							null,
							2
						)}</pre>
				</div>
			{/if}
			{#if full?.result !== undefined}
				<div>
					{@render label('Result')}
					<pre
						class="max-h-72 overflow-y-auto rounded bg-black/30 p-2 text-[11px] break-words whitespace-pre-wrap">{typeof full.result ===
						'string'
							? full.result
							: JSON.stringify(full.result, null, 2)}</pre>
				</div>
			{/if}
			{#if activePromptBlocks}
				<div>
					{@render label('Active system blocks')}
					<ul class="space-y-1 font-mono text-fg">
						{#each activePromptBlocks as b, i (i)}
							<li>· {b}</li>
						{/each}
					</ul>
				</div>
			{/if}
		</div>
	{:else if event.event_type === 'cache_event'}
		<div class="space-y-3 text-xs">
			<div>
				{@render label('Token usage')}
				<dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
					{@render kvList({
						model: d.model,
						iteration: d.iteration,
						stop_reason: d.stop_reason
					})}
				</dl>
			</div>
			<div>
				{@render label('Input token breakdown')}
				<div class="space-y-1">
					{@render tokenBar(
						'cache read',
						cacheTokens.cr,
						tokenPct(cacheTokens.cr, cacheTokens.total),
						'bg-emerald-500'
					)}
					{@render tokenBar(
						'cache create',
						cacheTokens.cc,
						tokenPct(cacheTokens.cc, cacheTokens.total),
						'bg-amber-500'
					)}
					{@render tokenBar(
						'fresh input',
						cacheTokens.inp,
						tokenPct(cacheTokens.inp, cacheTokens.total),
						'bg-sky-500'
					)}
				</div>
				<div class="mt-2 text-[10px] text-fg-muted">
					{cacheTokens.cr > 0
						? `Cache hit — ${cacheTokens.cr} tokens served from cache (saved ~${Math.round(
								(cacheTokens.cr / Math.max(cacheTokens.total, 1)) * 100
							)}% of input cost)`
						: 'Cache miss — no tokens served from cache this iteration'}
				</div>
			</div>
			<div>
				{@render label('Output')}
				<div class="font-mono text-fg">{cacheTokens.out} tokens</div>
			</div>
		</div>
	{:else if event.event_type === 'committee_review'}
		<div class="space-y-3 text-xs">
			<div>
				{@render label('Committee')}
				<dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
					{@render kvList({
						consulted: d.consulted,
						draft_length: d.draft_length,
						final_length: d.final_length,
						review_ms: d.review_ms,
						revision_ms: d.revision_ms
					})}
				</dl>
			</div>
			<div>
				{@render label(`Critiques (${critiques.length})`)}
				{#if critiques.length === 0}
					<div class="text-fg-muted italic">none</div>
				{:else}
					<ul class="space-y-2">
						{#each critiques as c, i (i)}
							<li class="rounded bg-black/30 p-2">
								<div class="mb-1 flex gap-2 text-[10px]">
									<span class="font-mono text-fg">@{c.reviewer ?? '?'}</span>
									<span class="text-fg-muted">· {c.severity ?? '?'}</span>
								</div>
								{#if c.critique}
									<div class="text-[11px] break-words whitespace-pre-wrap text-fg">
										{c.critique}
									</div>
								{/if}
							</li>
						{/each}
					</ul>
				{/if}
			</div>
		</div>
	{:else}
		<div class="text-xs text-fg">
			<dl class="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1">
				{@render kvList(d)}
			</dl>
		</div>
	{/if}

	<button
		type="button"
		onclick={onOpenDrawer}
		class="mt-4 w-full rounded-lg border border-line-strong bg-surface-overlay px-3 py-1.5 text-xs hover:bg-surface-input"
	>
		View full payload →
	</button>
</div>

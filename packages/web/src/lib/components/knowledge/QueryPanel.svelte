<script lang="ts" module>
	import type { KnowledgeSourceType } from '$lib/api.js';

	const SPECIALISTS = [
		{ id: '', label: 'All specialists' },
		{ id: 'cso', label: 'CSO (Strategy)' },
		{ id: 'cfo', label: 'CFO (Finance)' },
		{ id: 'chro', label: 'CHRO (HR)' },
		{ id: 'gc', label: 'GC (Legal)' },
		{ id: 'coo', label: 'COO (Operations)' },
		{ id: 'cmo', label: 'CMO (Marketing)' },
		{ id: 'cpo', label: 'CPO (Product + Strategy)' },
		{ id: 'board_comms', label: 'Board Comms (Board + Finance)' }
	];

	const ALL_SOURCES: KnowledgeSourceType[] = ['builtin', 'company', 'failures', 'external'];

	type Accent = 'indigo' | 'rose' | 'emerald' | 'amber';

	const ACCENT_CLASS: Record<Accent, string> = {
		indigo: 'text-indigo-400 border-l-indigo-500/40',
		rose: 'text-rose-400 border-l-rose-500/50',
		emerald: 'text-emerald-400 border-l-emerald-500/40',
		amber: 'text-amber-400 border-l-amber-500/40'
	};
</script>

<script lang="ts">
	// "What would RAG retrieve" diagnostic panel.
	// Ported from `packages/ui/src/components/knowledge/QueryPanel.tsx`.
	import {
		searchKnowledge,
		type KnowledgeSearchHit,
		type KnowledgeSearchResponse,
		type KnowledgeSourceType as SourceType
	} from '$lib/api.js';
	import { SvelteSet } from 'svelte/reactivity';

	interface Props {
		domains: string[];
		onOpenFile?: (kind: 'builtin' | 'failures', domain: string, filename: string) => void;
	}

	let { domains, onOpenFile }: Props = $props();

	let query = $state('');
	let specialist = $state('');
	// SvelteSet rather than `$state(new Set())` — Svelte's reactive Set primitive.
	const includes = new SvelteSet<SourceType>(ALL_SOURCES);
	const selectedDomains = new SvelteSet<string>();
	let running = $state(false);
	let result = $state.raw<KnowledgeSearchResponse | null>(null);
	let error = $state<string | null>(null);

	async function run() {
		if (!query.trim()) return;
		running = true;
		error = null;
		try {
			const res = await searchKnowledge({
				query: query.trim(),
				specialist: specialist || undefined,
				domain_filter: selectedDomains.size > 0 ? Array.from(selectedDomains) : undefined,
				include: Array.from(includes)
			});
			result = res;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Search failed';
		} finally {
			running = false;
		}
	}

	function toggleInclude(t: SourceType) {
		if (includes.has(t)) includes.delete(t);
		else includes.add(t);
	}

	function toggleDomain(d: string) {
		if (selectedDomains.has(d)) selectedDomains.delete(d);
		else selectedDomains.add(d);
	}
</script>

{#snippet resultGroup({
	title,
	kind,
	hits,
	accent,
	onOpenFile
}: {
	title: string;
	kind: 'builtin' | 'failures' | 'company' | 'external';
	hits: KnowledgeSearchHit[];
	accent: Accent;
	onOpenFile?: (kind: 'builtin' | 'failures', domain: string, filename: string) => void;
})}
	<div>
		<div class="mb-2 flex items-baseline justify-between">
			<h3
				class={`text-xs font-semibold tracking-widest uppercase ${ACCENT_CLASS[accent].split(' ')[0]}`}
			>
				{title}
			</h3>
			<span class="text-[10px] text-fg-subtle">{hits.length} hit{hits.length === 1 ? '' : 's'}</span
			>
		</div>
		{#if hits.length === 0}
			<p class="text-xs text-fg-subtle">No matches.</p>
		{:else}
			<div class="space-y-2">
				{#each hits as h, i (`${kind}-${h.filename}-${h.chunk_index ?? i}`)}
					<div
						class={`rounded-lg border border-l-2 border-line bg-surface-elevated/60 px-3 py-2 ${ACCENT_CLASS[accent]}`}
					>
						<div class="flex flex-wrap items-baseline justify-between gap-3">
							<div class="flex flex-wrap items-baseline gap-2 text-xs">
								<span class="font-medium text-fg">{h.filename}</span>
								<span class="text-fg-muted">·</span>
								<span class="text-fg-muted">{h.domain}</span>
								{#if h.publisher}
									<span class="text-fg-muted">·</span>
									<span class="text-fg-muted">{h.publisher}</span>
								{/if}
								<span class="text-fg-muted">·</span>
								<span class="text-fg-muted">dist {h.distance.toFixed(3)}</span>
							</div>
							{#if (kind === 'builtin' || kind === 'failures') && onOpenFile}
								<button
									type="button"
									onclick={() => onOpenFile(kind, h.domain, h.filename)}
									class="text-[10px] text-fg-muted transition-colors hover:text-fg"
								>
									open →
								</button>
							{/if}
						</div>
						<p class="mt-1.5 text-xs leading-relaxed whitespace-pre-wrap text-fg">{h.text}</p>
					</div>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

<div class="flex max-w-4xl flex-col gap-5">
	<div>
		<h2 class="text-base font-semibold text-fg">Query mode</h2>
		<p class="mt-1 text-xs text-fg-muted">
			Test what the Executive would retrieve for a given question. Distances are cosine — lower is
			closer.
		</p>
	</div>

	<div class="space-y-3 rounded-xl border border-line bg-surface-elevated/40 p-4">
		<div class="flex gap-2">
			<input
				value={query}
				oninput={(e) => (query = e.currentTarget.value)}
				onkeydown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault();
						void run();
					}
				}}
				aria-label="Query"
				placeholder="e.g. how should we think about pricing for a new SaaS product?"
				class="flex-1 rounded-lg border border-line-strong bg-surface-elevated px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
			/>
			<button
				type="button"
				onclick={() => void run()}
				disabled={!query.trim() || running}
				class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-400 disabled:opacity-40"
			>
				{running ? 'Running…' : 'Run'}
			</button>
		</div>

		<div class="flex flex-wrap gap-4">
			<div class="flex items-center gap-2">
				<label for="query-specialist" class="text-[11px] tracking-widest text-fg-muted uppercase"
					>Specialist</label
				>
				<select
					id="query-specialist"
					value={specialist}
					onchange={(e) => (specialist = e.currentTarget.value)}
					class="rounded-lg border border-line-strong bg-surface-elevated px-2 py-1 text-xs text-fg focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
				>
					{#each SPECIALISTS as s (s.id || 'all')}
						<option value={s.id}>{s.label}</option>
					{/each}
				</select>
			</div>

			<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Include sources">
				<span class="text-[11px] tracking-widest text-fg-muted uppercase">Include</span>
				{#each ALL_SOURCES as t (t)}
					<button
						type="button"
						onclick={() => toggleInclude(t)}
						aria-pressed={includes.has(t)}
						class={`rounded border px-2 py-1 text-xs transition-colors ${
							includes.has(t)
								? 'border-indigo-500/40 bg-indigo-500/15 text-indigo-300'
								: 'border-line-strong bg-surface-overlay/40 text-fg-muted'
						}`}
					>
						{t}
					</button>
				{/each}
			</div>
		</div>

		<div class="flex flex-wrap items-center gap-2" role="group" aria-label="Domains">
			<span class="text-[11px] tracking-widest text-fg-muted uppercase">Domains</span>
			{#each domains as d (d)}
				<button
					type="button"
					onclick={() => toggleDomain(d)}
					aria-pressed={selectedDomains.has(d)}
					class={`rounded border px-2 py-1 text-xs transition-colors ${
						selectedDomains.has(d)
							? 'border-line-strong bg-surface-input text-fg'
							: 'border-line-strong bg-surface-overlay/40 text-fg-muted hover:text-fg'
					}`}
				>
					{d}
				</button>
			{/each}
			{#if selectedDomains.size > 0}
				<button
					type="button"
					onclick={() => selectedDomains.clear()}
					class="text-xs text-fg-muted underline-offset-2 hover:text-fg hover:underline"
				>
					clear
				</button>
			{/if}
		</div>
	</div>

	{#if error}
		<div
			class="rounded-xl border border-red-900/60 bg-red-950/40 px-4 py-3 text-sm text-red-400"
			role="alert"
		>
			{error}
		</div>
	{/if}

	{#if result}
		<div class="space-y-5">
			<div class="space-y-1 text-xs text-fg-muted">
				{#if result.effective_domains && result.effective_domains.length > 0}
					<p>
						<span class="text-fg-muted">Domain filter:</span>
						{result.effective_domains.join(', ')}
					</p>
				{:else}
					<p><span class="text-fg-muted">Domain filter:</span> none (all domains)</p>
				{/if}
				<p>
					<span class="text-fg-muted">Specialists that would see these chunks:</span>
					{result.specialists_that_would_see_this.join(', ') || '—'}
				</p>
			</div>

			{@render resultGroup({
				title: 'Playbooks',
				kind: 'builtin',
				hits: result.builtin,
				accent: 'indigo',
				onOpenFile
			})}
			{@render resultGroup({
				title: 'Failures',
				kind: 'failures',
				hits: result.failures,
				accent: 'rose',
				onOpenFile
			})}
			{@render resultGroup({
				title: 'Company documents',
				kind: 'company',
				hits: result.company,
				accent: 'emerald'
			})}
			{@render resultGroup({
				title: 'Reference Library',
				kind: 'external',
				hits: result.external,
				accent: 'amber'
			})}
		</div>
	{/if}
</div>

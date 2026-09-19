<script lang="ts">
	// One lazily-fetched documentation section (architecture or user guide).
	// Ported from `packages/ui/src/components/architecture/DynamicSection.tsx`.
	import { onMount } from 'svelte';
	import MermaidDiagram from './MermaidDiagram.svelte';
	import Markdown from '$lib/components/Markdown.svelte';

	interface SectionContent {
		section_id: string;
		markdown: string;
		mermaid: string | null;
		generated_at: string;
	}

	interface Props {
		id: string;
		title: string;
		sub: string;
		/**
		 * Backend resource these sections are served from. Defaults to
		 * `architecture`; the user guide passes `guide`. Both expose the same
		 * `/{basePath}/sections/{id}` shape.
		 */
		basePath?: string;
	}

	let { id, title, sub, basePath = 'architecture' }: Props = $props();

	let content = $state.raw<SectionContent | null>(null);
	let status = $state<'idle' | 'loading' | 'ready' | 'error'>('idle');
	let error = $state<string | null>(null);

	// Every section reads its own static file. Plain flag rather than state — it
	// only guards against writing after unmount, it is never rendered.
	let destroyed = false;

	onMount(() => {
		void load();
		return () => {
			destroyed = true;
		};
	});

	async function load() {
		status = 'loading';
		error = null;
		try {
			const res = await fetch(`/api/backend/${basePath}/sections/${id}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data: SectionContent = await res.json();
			if (destroyed) return;
			content = data;
			status = 'ready';
		} catch (e) {
			if (destroyed) return;
			error = e instanceof Error ? e.message : String(e);
			status = 'error';
		}
	}
</script>

<section class="space-y-4">
	<div class="mb-6 flex items-start justify-between gap-4" {id}>
		<div>
			<h2 class="text-lg font-semibold text-fg">{title}</h2>
			<p class="mt-1 text-sm text-fg-muted">{sub}</p>
		</div>
	</div>

	{#if status === 'loading' && !content}
		<div
			class="animate-pulse rounded-lg border border-line bg-surface px-4 py-8 text-center text-xs text-fg-muted"
			role="status"
		>
			Loading…
		</div>
	{/if}

	{#if status === 'error'}
		<div
			class="rounded-lg border border-red-900 bg-red-950/40 px-4 py-3 text-xs text-red-300"
			role="alert"
		>
			<div class="mb-1 font-medium">Failed to load</div>
			<div class="font-mono">{error}</div>
			<button
				type="button"
				onclick={() => void load()}
				class="mt-2 text-red-200 underline hover:text-red-100"
			>
				Retry
			</button>
		</div>
	{/if}

	{#if content && content.mermaid}
		<MermaidDiagram {id} definition={content.mermaid} />
	{/if}

	{#if content}
		<Markdown
			source={content.markdown}
			class="prose-sm prose-invert prose-headings:text-fg prose-p:text-fg prose-a:text-indigo-400 prose-code:rounded prose-code:bg-surface-elevated prose-code:px-1 prose-code:py-0.5 prose-code:text-amber-300 prose-code:before:content-none prose-code:after:content-none prose-li:text-fg prose-table:text-xs prose-th:text-fg-muted prose-td:text-fg-muted"
		/>
	{/if}
</section>

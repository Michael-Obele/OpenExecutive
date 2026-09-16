<script lang="ts">
	import type { ActionTaken } from '$lib/api.js';
	import BrandMark from '$lib/components/BrandMark.svelte';

	interface Props {
		role: 'user' | 'assistant';
		content: string;
		isStreaming?: boolean;
		actions?: ActionTaken[];
	}

	let { role, content, isStreaming = false, actions = [] }: Props = $props();

	// Minimal markdown-ish rendering — preserves whitespace and links.
	// Full ReactMarkdown is a React dependency; Svelte port uses a lightweight
	// pass. Upgrade to `@tanstack/svelte-markdown` or `marked` when needed.
	function escapeHtml(s: string): string {
		return s
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/"/g, '&quot;');
	}

	function renderMarkdown(src: string): string {
		// Block javascript:/data:/vbscript: in links (XSS via prompt injection).
		const safe = escapeHtml(src)
			.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, text: string, url: string) => {
				if (/^(javascript|data|vbscript):/i.test(url.trim())) return text;
				return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="text-accent no-underline hover:underline">${text}</a>`;
			})
			.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
			.replace(/\*([^*]+)\*/g, '<em>$1</em>')
			.replace(
				/`([^`]+)`/g,
				'<code class="rounded bg-surface-overlay px-1.5 py-0.5 text-xs">$1</code>'
			);
		return safe;
	}
</script>

{#if role === 'user'}
	<div class="mb-6 flex justify-end">
		<div
			class="max-w-xl rounded-2xl rounded-tr-sm bg-surface-overlay px-4 py-3 text-sm leading-relaxed text-fg"
		>
			<p class="whitespace-pre-wrap">{content}</p>
		</div>
	</div>
{:else}
	<div class="mb-8 flex gap-3 sm:gap-4">
		<div class="mt-1 shrink-0">
			<BrandMark size="md" />
		</div>
		<div class="min-w-0 flex-1">
			<div class="mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase">Executive</div>
			<div class="prose prose-invert prose-sm max-w-none">
				<!-- eslint-disable-next-line svelte/no-at-html-tags -->
				<p class="text-sm leading-relaxed whitespace-pre-wrap text-fg">
					{@html renderMarkdown(content)}
				</p>
				{#if isStreaming}
					<span
						class="cursor-blink ml-0.5 inline-block h-4 w-0.5 rounded-full bg-accent align-text-bottom"
					></span>
				{/if}
			</div>
			{#if actions.length > 0}
				<div class="mt-3 flex flex-wrap gap-1.5" aria-label={`${actions.length} actions taken`}>
					{#each actions as action (action.tool + action.summary)}
						{#if action.link}
							<a href={action.link} class="transition-opacity hover:opacity-80">
								<span
									class="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300"
								>
									<span aria-hidden="true" class="text-[10px]">✓</span>
									<span>{action.summary}</span>
								</span>
							</a>
						{:else}
							<span
								class="inline-flex items-center gap-1.5 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2.5 py-1 text-[11px] text-emerald-300"
							>
								<span aria-hidden="true" class="text-[10px]">✓</span>
								<span>{action.summary}</span>
							</span>
						{/if}
					{/each}
				</div>
			{/if}
		</div>
	</div>
{/if}

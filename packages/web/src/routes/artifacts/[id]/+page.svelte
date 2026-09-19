<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import Icon from '$lib/components/Icon.svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import {
		archiveArtifact,
		deleteArtifact,
		getArtifact,
		restoreArtifact,
		type ArtifactDetail
	} from '$lib/api.js';

	// SvelteKit decodes dynamic params before exposing them on `page.params`,
	// so the extra `decodeURIComponent` the Next.js source applied (Next.js also
	// pre-decodes) is not repeated here.
	const id = page.params.id;

	let art = $state.raw<ArtifactDetail | null>(null);
	let error = $state<string | null>(null);
	let copied = $state(false);
	let busy = $state(false);

	function formatTimestamp(iso: string): string {
		return new Date(iso).toLocaleString();
	}

	onMount(() => {
		if (!id) return;
		getArtifact(id)
			.then((v) => (art = v))
			.catch((e) => (error = e instanceof Error ? e.message : String(e)));
	});

	async function handleCopy() {
		if (!art?.body) return;
		try {
			await navigator.clipboard.writeText(art.body);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// ignore — clipboard API may be unavailable
		}
	}

	function handleDownload() {
		if (!art?.body) return;
		const blob = new Blob([art.body], { type: 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${art.id.replace(':', '-')}.md`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}

	async function handleToggleArchive() {
		if (!art) return;
		const archiving = !art.archived_at;
		busy = true;
		try {
			if (archiving) await archiveArtifact(art.id);
			else await restoreArtifact(art.id);
			// Reflect new state locally (timestamp is illustrative — the list is the
			// source of truth on next load).
			art = { ...art, archived_at: archiving ? new Date().toISOString() : null };
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}

	async function handleDelete() {
		if (!art) return;
		if (
			!confirm(
				`Permanently delete "${art.title}"? This removes it everywhere and cannot be undone.`
			)
		)
			return;
		busy = true;
		try {
			await deleteArtifact(art.id);
			void goto('/artifacts');
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			busy = false;
		}
	}
</script>

{#if error}
	<div class="flex min-h-0 flex-1 flex-col items-center justify-center bg-surface text-fg">
		<div class="mb-4 text-sm text-red-400" role="alert">Error: {error}</div>
		<a href="/artifacts" class="text-sm text-fg-muted hover:text-fg">← Back to artifacts</a>
	</div>
{:else if !art}
	<div
		class="flex min-h-0 flex-1 flex-col items-center justify-center bg-surface text-sm text-fg-muted"
		role="status"
	>
		Loading…
	</div>
{:else}
	<main class="min-h-0 flex-1 overflow-y-auto px-6 py-8">
		<div class="mx-auto max-w-4xl space-y-6">
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0">
					<h1 class="mb-1 text-2xl font-semibold text-fg">{art.title}</h1>
					<div class="text-xs text-fg-muted">
						{art.source_label} · created {formatTimestamp(art.created_at)}
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<button
						type="button"
						onclick={() => void handleCopy()}
						class="min-h-touch cursor-pointer rounded-md border border-line px-3 py-1.5 text-xs text-fg-muted transition hover:bg-surface-overlay hover:text-fg"
					>
						{copied ? 'Copied!' : 'Copy'}
					</button>
					<button
						type="button"
						onclick={handleDownload}
						class="min-h-touch cursor-pointer rounded-md border border-line px-3 py-1.5 text-xs text-fg-muted transition hover:bg-surface-overlay hover:text-fg"
					>
						Download .md
					</button>
					<button
						type="button"
						onclick={() => void handleToggleArchive()}
						disabled={busy}
						class="min-h-touch inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-fg-muted transition hover:bg-surface-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-40"
					>
						<Icon name={art.archived_at ? 'restore' : 'archive'} size="w-3.5 h-3.5" />
						{art.archived_at ? 'Restore' : 'Archive'}
					</button>
					<button
						type="button"
						onclick={() => void handleDelete()}
						disabled={busy}
						aria-label="Delete permanently"
						class="min-h-touch inline-flex cursor-pointer items-center gap-1.5 rounded-md border border-line px-3 py-1.5 text-xs text-fg-muted transition hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
					>
						<Icon name="trash" size="w-3.5 h-3.5" />
						Delete
					</button>
				</div>
			</div>

			{#if art.rationale}
				<div class="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3">
					<div class="mb-1 text-xs font-medium text-amber-300">Why this is worth your time</div>
					<div class="text-sm text-fg">{art.rationale}</div>
				</div>
			{/if}

			<!-- The box lives on <article> so it still renders for a body-less
			     artifact; `Markdown.svelte` supplies `prose max-w-none` itself, so
			     only the typography modifiers are passed through to it. -->
			<article class="rounded-lg border border-line bg-surface/40 p-6">
				<Markdown
					source={art.body}
					class="prose-sm prose-invert prose-headings:font-semibold prose-headings:text-fg prose-p:leading-relaxed prose-p:text-fg prose-a:text-indigo-400 prose-a:no-underline hover:prose-a:underline prose-blockquote:border-line-strong prose-blockquote:text-fg-muted prose-strong:text-fg prose-code:rounded prose-code:bg-surface-overlay prose-code:px-1.5 prose-code:py-0.5 prose-code:text-indigo-300 prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-line-strong prose-pre:bg-surface-overlay prose-ol:text-fg prose-ul:text-fg prose-li:marker:text-fg-muted prose-table:text-fg prose-th:border-line-strong prose-th:text-fg prose-td:border-line-strong prose-hr:border-line-strong"
				/>
			</article>
		</div>
	</main>
{/if}

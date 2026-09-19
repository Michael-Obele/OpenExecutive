<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import Markdown from '$lib/components/Markdown.svelte';
	import { getWorkflowRun, type WorkflowRunDetail } from '$lib/api.js';

	function formatTimestamp(iso: string): string {
		return new Date(iso).toLocaleString();
	}

	// Verbatim from `packages/ui/src/app/jobs/runs/[id]/page.tsx` — the upstream
	// page relies on the app's typography config, which `Markdown.svelte`'s
	// `prose` wrapper already maps onto the OE theme.
	const ARTIFACT_PROSE_CLASS =
		'prose prose-invert prose-sm max-w-none rounded-lg border border-line bg-surface/40 p-6 ' +
		'prose-headings:text-fg prose-headings:font-semibold ' +
		'prose-p:text-fg prose-p:leading-relaxed ' +
		'prose-strong:text-fg ' +
		'prose-code:text-indigo-300 prose-code:bg-surface-overlay prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:before:content-none prose-code:after:content-none ' +
		'prose-pre:bg-surface-overlay prose-pre:border prose-pre:border-line-strong ' +
		'prose-blockquote:border-line-strong prose-blockquote:text-fg-muted ' +
		'prose-ul:text-fg prose-ol:text-fg ' +
		'prose-li:marker:text-fg-muted ' +
		'prose-hr:border-line-strong ' +
		'prose-a:text-indigo-400 prose-a:no-underline hover:prose-a:underline ' +
		'prose-table:text-fg prose-th:text-fg prose-th:border-line-strong prose-td:border-line-strong';

	let run = $state<WorkflowRunDetail | null>(null);
	let error = $state<string | null>(null);
	let copied = $state(false);

	onMount(() => {
		let cancelled = false;
		const runId = page.params.id;
		if (!runId) return;
		getWorkflowRun(runId)
			.then((r) => {
				if (!cancelled) run = r;
			})
			.catch((e: unknown) => {
				if (!cancelled) error = e instanceof Error ? e.message : String(e);
			});
		return () => {
			cancelled = true;
		};
	});

	async function handleCopy() {
		if (!run?.artifact) return;
		try {
			await navigator.clipboard.writeText(run.artifact);
			copied = true;
			setTimeout(() => (copied = false), 1500);
		} catch {
			// ignore — clipboard API may be unavailable
		}
	}

	function handleDownload() {
		if (!run?.artifact) return;
		const blob = new Blob([run.artifact], { type: 'text/markdown' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `${run.workflow_name}-${run.run_id.slice(0, 8)}.md`;
		document.body.appendChild(a);
		a.click();
		document.body.removeChild(a);
		URL.revokeObjectURL(url);
	}
</script>

{#snippet statusPill(status: string)}
	<span
		class={`font-medium ${
			status === 'done'
				? 'text-emerald-400'
				: status === 'error'
					? 'text-red-400'
					: 'text-amber-400'
		}`}
	>
		{status}
	</span>
{/snippet}

{#if error}
	<main class="flex flex-1 flex-col items-center justify-center text-fg">
		<div class="mb-4 text-sm text-red-400" role="alert">Error: {error}</div>
		<a href="/jobs" class="text-sm text-fg-muted hover:text-fg">← Back to jobs</a>
	</main>
{:else if !run}
	<main class="flex flex-1 flex-col items-center justify-center text-sm text-fg-muted">
		<span role="status">Loading…</span>
	</main>
{:else}
	<main class="flex min-h-0 flex-1 flex-col text-fg">
		<div class="mx-auto w-full max-w-4xl space-y-6 px-4 py-8 sm:px-6">
			<div class="flex items-start justify-between gap-4">
				<div class="min-w-0">
					<h1 class="mb-1 text-2xl font-semibold text-fg">{run.title}</h1>
					<div class="text-xs text-fg-muted">
						{run.workflow_name} · created {formatTimestamp(run.created_at)} · status
						{@render statusPill(run.status)}
					</div>
				</div>
				{#if run.artifact}
					<div class="flex shrink-0 items-center gap-2">
						<button
							type="button"
							onclick={() => void handleCopy()}
							class="min-h-touch rounded-md border border-line px-3 py-1.5 text-xs text-fg-muted transition hover:bg-surface-overlay hover:text-fg"
						>
							{copied ? 'Copied!' : 'Copy'}
						</button>
						<button
							type="button"
							onclick={handleDownload}
							class="min-h-touch rounded-md border border-line px-3 py-1.5 text-xs text-fg-muted transition hover:bg-surface-overlay hover:text-fg"
						>
							Download .md
						</button>
					</div>
				{/if}
			</div>

			{#if run.status === 'running'}
				<div
					class="rounded-md border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-300"
					role="status"
				>
					This run is still in progress. Refresh in a moment.
				</div>
			{/if}

			{#if run.status === 'error'}
				<div
					class="rounded-md border border-red-500/30 bg-red-500/5 px-4 py-3 text-sm text-red-300"
					role="alert"
				>
					<div class="mb-1 font-medium">Run failed</div>
					<div class="text-xs">{run.error}</div>
				</div>
			{/if}

			{#if run.artifact}
				<article>
					<Markdown source={run.artifact} class={ARTIFACT_PROSE_CLASS} />
				</article>
			{/if}

			<details class="rounded-md border border-line bg-surface/30 px-4 py-3 text-sm">
				<summary class="cursor-pointer text-xs text-fg-muted">Inputs</summary>
				<pre class="mt-3 font-mono text-xs whitespace-pre-wrap text-fg">{JSON.stringify(
						run.inputs,
						null,
						2
					)}</pre>
			</details>
		</div>
	</main>
{/if}

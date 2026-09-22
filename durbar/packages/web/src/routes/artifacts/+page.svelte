<script lang="ts">
	import { onMount } from 'svelte';
	import { listArtifacts, archiveArtifact, restoreArtifact } from '$lib/remote/artifacts.remote.js';
	import type { ArtifactSummary } from '$lib/remote/artifacts.remote.js';

	let items = $state<ArtifactSummary[]>([]);
	let err = $state<string | null>(null);
	let loading = $state(true);
	let showArchived = $state(false);

	async function load() {
		loading = true;
		err = null;
		try {
			const { listArchivedArtifacts } = await import('$lib/remote/artifacts.remote.js');
			items = showArchived ? await listArchivedArtifacts() : await listArtifacts();
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	onMount(load);

	$effect(() => {
		void showArchived;
		load();
	});

	async function toggleArchive(a: ArtifactSummary) {
		try {
			if (a.archived_at) await restoreArtifact(a.id);
			else await archiveArtifact(a.id);
			await load();
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		}
	}
</script>

<div class="mx-auto max-w-5xl px-6 py-8">
	<div class="flex items-center justify-between">
		<div>
			<h1 class="text-xl font-semibold text-zinc-100">Artifacts</h1>
			<p class="mt-1 text-sm text-zinc-400">
				Workflow outputs. <code class="text-zinc-300">GET /artifacts</code>
			</p>
		</div>
		<label class="flex items-center gap-2 text-sm text-zinc-400">
			<input type="checkbox" bind:checked={showArchived} class="rounded border-zinc-700 bg-zinc-800" />
			Archived
		</label>
	</div>

	{#if err}
		<div class="mt-4 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300" role="alert">
			{err}
		</div>
	{/if}

	{#if loading}
		<p class="mt-6 text-sm text-zinc-500">Loading…</p>
	{:else if items.length === 0}
		<p class="mt-6 text-sm text-zinc-500">No artifacts yet.</p>
	{:else}
		<ul class="mt-6 space-y-3">
			{#each items as a (a.id)}
				<li class="rounded border border-zinc-800 bg-zinc-900 p-4">
					<div class="flex items-start justify-between gap-4">
						<div class="min-w-0 flex-1">
							<a href="/artifacts/{encodeURIComponent(a.id)}" class="text-sm font-medium text-zinc-100 hover:text-indigo-300">
								{a.title}
							</a>
							<div class="mt-1 flex flex-wrap items-center gap-2 text-xs text-zinc-500">
								<span class="rounded bg-zinc-800 px-1.5 py-0.5">{a.kind}</span>
								<span>{a.source_label}</span>
								<span>{new Date(a.created_at).toLocaleString()}</span>
								{#if a.severity}<span class="rounded bg-amber-500/10 px-1.5 py-0.5 text-amber-300">{a.severity}</span>{/if}
							</div>
							{#if a.preview}<p class="mt-2 line-clamp-2 text-sm text-zinc-400">{a.preview}</p>{/if}
						</div>
						<button
							onclick={() => toggleArchive(a)}
							class="shrink-0 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
						>
							{a.archived_at ? 'Restore' : 'Archive'}
						</button>
					</div>
				</li>
			{/each}
		</ul>
	{/if}
</div>

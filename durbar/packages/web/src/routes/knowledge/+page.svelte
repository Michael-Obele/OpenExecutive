<script lang="ts">
	import { onMount } from 'svelte';
	import { searchKnowledge, listBuiltinFiles } from '$lib/remote/knowledge.remote.js';

	let q = $state('');
	let results = $state<import('$lib/remote/knowledge.remote.js').KnowledgeSearchResult | null>(null);
	let files = $state<import('$lib/remote/knowledge.remote.js').BuiltinFile[]>([]);
	let err = $state<string | null>(null);
	let loading = $state(false);

	onMount(async () => {
		try {
			files = await listBuiltinFiles();
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		}
	});

	async function doSearch() {
		if (!q.trim()) return;
		loading = true;
		err = null;
		try {
			results = await searchKnowledge({ query: q.trim() });
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}
</script>

<div class="mx-auto max-w-5xl px-6 py-8">
	<h1 class="text-xl font-semibold text-zinc-100">Knowledge</h1>
	<p class="mt-1 text-sm text-zinc-400">
		Curated MBA docs + uploaded company docs + research. Search via
		<code class="text-zinc-300">POST /knowledge/search</code>.
	</p>

	{#if err}
		<div class="mt-4 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300" role="alert">
			{err}
		</div>
	{/if}

	<form
		onsubmit={(e) => {
			e.preventDefault();
			doSearch();
		}}
		class="mt-6 flex gap-2"
	>
		<input
			bind:value={q}
			placeholder="Search knowledge (e.g. pricing, hiring, board)"
			class="flex-1 rounded border border-zinc-700 bg-zinc-800 px-3 py-2 text-sm text-zinc-100 placeholder:text-zinc-500"
		/>
		<button
			type="submit"
			disabled={loading || !q.trim()}
			class="rounded bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
		>
			{loading ? 'Searching…' : 'Search'}
		</button>
	</form>

	{#if results}
		<div class="mt-6 space-y-6">
			<p class="text-xs text-zinc-500">
				Query: <span class="text-zinc-300">{results.query}</span> · Effective domains:
				<span class="text-zinc-300">{results.effective_domains?.join(', ') ?? 'all'}</span>
			</p>
			{#each [{ label: 'Builtin', items: results.builtin }, { label: 'Company', items: results.company }, { label: 'Failures', items: results.failures }] as section (section.label)}
				<div>
					<h2 class="text-sm font-medium text-zinc-200">
						{section.label}
						<span class="font-normal text-zinc-500">({section.items.length})</span>
					</h2>
					{#if section.items.length === 0}
						<p class="mt-1 text-sm text-zinc-500">No hits.</p>
					{:else}
						<ul class="mt-2 space-y-2">
							{#each section.items as hit (hit.source + hit.distance)}
								<li class="rounded border border-zinc-800 bg-zinc-900 p-3">
									<div class="flex items-center gap-2 text-xs text-zinc-500">
										<span class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{hit.domain}</span>
										<span>{hit.filename}</span>
										<span class="ml-auto">score {hit.distance.toFixed(2)}</span>
									</div>
									<p class="mt-2 line-clamp-3 text-sm text-zinc-300">{hit.text}</p>
								</li>
							{/each}
						</ul>
					{/if}
				</div>
			{/each}
		</div>
	{:else if !loading}
		<div class="mt-6">
			<h2 class="text-sm font-medium text-zinc-200">Builtin files ({files.length})</h2>
			{#if files.length === 0}
				<p class="mt-1 text-sm text-zinc-500">No files indexed.</p>
			{:else}
				<ul class="mt-2 grid gap-2 sm:grid-cols-2">
					{#each files as f (f.domain + '/' + f.filename)}
						<li class="rounded border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
							<span class="text-zinc-400">{f.domain}/</span><span class="text-zinc-200">{f.filename}</span>
							<span class="ml-2 text-xs text-zinc-500">{(f.size_bytes / 1024).toFixed(1)} KB</span>
						</li>
					{/each}
				</ul>
			{/if}
		</div>
	{/if}
</div>

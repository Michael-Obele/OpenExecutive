<script lang="ts">
	import { onMount } from "svelte";
	import { listWorkflows, listWorkflowRuns } from "$lib/remote/workflows.remote.js";
	let workflows = $state<unknown[]>([]);
	let runs = $state<unknown[]>([]);
	let err = $state<string | null>(null);
	onMount(async () => { try { const [w, r] = await Promise.all([listWorkflows() as Promise<unknown[]>, listWorkflowRuns() as Promise<unknown[]>]); workflows=w; runs=r; } catch (e) { err = e instanceof Error ? e.message : String(e); } });
</script>
<div class="mx-auto max-w-5xl px-6 py-8">
	<h1 class="text-xl font-semibold text-zinc-100">Workflows</h1>
	<p class="mt-1 text-sm text-zinc-400">Catalog + runs. SSE streams for live runs (<code class="text-zinc-300">POST /workflows/{"{name}"}/runs → text/event-stream</code>).</p>
	{#if err}<div class="mt-4 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{err}</div>{/if}
	<h2 class="mt-6 text-sm font-medium text-zinc-200">Catalog</h2>
	<ul class="mt-2 space-y-2">{#each workflows as w ((w as Record<string, unknown>).name ?? JSON.stringify(w))}<li class="rounded border border-zinc-800 bg-zinc-900 p-3 text-sm"><pre class="text-xs text-zinc-400">{JSON.stringify(w, null, 2)}</pre></li>{/each}</ul>
	<h2 class="mt-6 text-sm font-medium text-zinc-200">Recent runs</h2>
	<ul class="mt-2 space-y-2">{#each runs as r ((r as Record<string, unknown>).id ?? JSON.stringify(r))}<li class="rounded border border-zinc-800 bg-zinc-900 p-3 text-sm"><pre class="text-xs text-zinc-400">{JSON.stringify(r, null, 2)}</pre></li>{/each}</ul>
</div>

<script lang="ts">
	import { page } from "$app/state";
	import { onMount } from "svelte";
	import { getWorkflow } from "$lib/remote/workflows.remote.js";
	let data = $state<unknown>(null); let err = $state<string | null>(null);
	let wfName = $derived(page.params.name ?? "");
	onMount(async () => { try { data = await getWorkflow(wfName); } catch (e) { err = e instanceof Error ? e.message : String(e); } });
</script>
<div class="mx-auto max-w-3xl px-6 py-8">
	<h1 class="text-xl font-semibold text-zinc-100">Workflow: {page.params.name}</h1>
	{#if err}<div class="mt-4 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{err}</div>{/if}
	{#if data}<pre class="mt-4 overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-400">{JSON.stringify(data, null, 2)}</pre>{:else if !err}<p class="mt-4 text-sm text-zinc-500">Loading…</p>{/if}
</div>

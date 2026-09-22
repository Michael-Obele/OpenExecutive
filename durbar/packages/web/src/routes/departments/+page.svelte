<script lang="ts">
	import { onMount } from "svelte";
	import { listDepartments, createDepartment } from "$lib/remote/departments.remote.js";
	let depts = $state<unknown[]>([]); let err = $state<string | null>(null); let title = $state("");
	onMount(async () => { try { depts = await listDepartments() as unknown[]; } catch (e) { err = e instanceof Error ? e.message : String(e); } });
</script>
<div class="mx-auto max-w-5xl px-6 py-8">
	<h1 class="text-xl font-semibold text-zinc-100">Departments</h1>
	<p class="mt-1 text-sm text-zinc-400">Each department wraps a specialist agent. Demonstrates remote <code class="text-zinc-300">command</code> for create.</p>
	{#if err}<div class="mt-4 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{err}</div>{/if}
	<div class="mt-4 flex gap-2">
		<input bind:value={title} placeholder="New department title" class="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100" />
		<button onclick={async () => { if (!title.trim()) return; await createDepartment({ title: title.trim() }); title=""; depts = await listDepartments() as unknown[]; }} class="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500">Create</button>
	</div>
	{#if depts.length===0 && !err}<p class="mt-4 text-sm text-zinc-500">No departments yet.</p>{/if}
	<ul class="mt-4 space-y-2">{#each depts as d (JSON.stringify(d))}<li class="rounded border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300"><pre class="text-xs text-zinc-400">{JSON.stringify(d, null, 2)}</pre></li>{/each}</ul>
</div>

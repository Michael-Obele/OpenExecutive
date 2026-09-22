<script lang="ts">
	import { onMount } from "svelte";
	import { listPeople, createPerson } from "$lib/remote/people.remote.js";
	let people = $state<unknown[]>([]); let err = $state<string | null>(null); let name = $state("");
	onMount(async () => { try { people = await listPeople() as unknown[]; } catch (e) { err = e instanceof Error ? e.message : String(e); } });
</script>
<div class="mx-auto max-w-5xl px-6 py-8">
	<h1 class="text-xl font-semibold text-zinc-100">People</h1>
	<p class="mt-1 text-sm text-zinc-400">Roster + authority levels.</p>
	{#if err}<div class="mt-4 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{err}</div>{/if}
	<div class="mt-4 flex gap-2">
		<input bind:value={name} placeholder="Full name" class="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100" />
		<button onclick={async () => { if (!name.trim()) return; await createPerson({ full_name: name.trim() }); name=""; people = await listPeople() as unknown[]; }} class="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500">Add</button>
	</div>
	<ul class="mt-4 space-y-2">{#each people as p ((p as Record<string, unknown>).id ?? (p as Record<string, unknown>).full_name ?? JSON.stringify(p))}<li class="rounded border border-zinc-800 bg-zinc-900 p-3 text-sm text-zinc-300"><pre class="text-xs text-zinc-400">{JSON.stringify(p, null, 2)}</pre></li>{/each}</ul>
</div>

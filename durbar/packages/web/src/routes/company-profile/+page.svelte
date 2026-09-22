<script lang="ts">
	import { onMount } from "svelte";
	import { getCompanyProfile, updateCompanyProfile } from "$lib/remote/company.remote.js";
	let profile = $state<Record<string, unknown> | null>(null); let err = $state<string | null>(null);
	onMount(async () => { try { profile = await getCompanyProfile() as Record<string, unknown>; } catch (e) { err = e instanceof Error ? e.message : String(e); } });
</script>
<div class="mx-auto max-w-3xl px-6 py-8">
	<h1 class="text-xl font-semibold text-zinc-100">Company Profile</h1>
	<p class="mt-1 text-sm text-zinc-400">Structured profile the Executive grounds every answer in. Demonstrates remote <code class="text-zinc-300">form</code> (Valibot) for PATCH.</p>
	{#if err}<div class="mt-4 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300">{err}</div>{/if}
	{#if profile}<pre class="mt-4 overflow-auto rounded bg-zinc-900 p-3 text-xs text-zinc-400">{JSON.stringify(profile, null, 2)}</pre>{/if}
	<form {...updateCompanyProfile} class="mt-6 space-y-3 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
		<h2 class="text-sm font-medium text-zinc-200">Update (demo form)</h2>
		<label class="block text-sm"><span class="text-zinc-400">Name</span><input {...updateCompanyProfile.fields.name.as("text")} class="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100" placeholder="Company name" /></label>
		<label class="block text-sm"><span class="text-zinc-400">Mission</span><textarea {...updateCompanyProfile.fields.mission.as("text")} class="mt-1 w-full rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100" rows="3" placeholder="Mission"></textarea></label>
		<button type="submit" class="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500">Save</button>
	</form>
</div>

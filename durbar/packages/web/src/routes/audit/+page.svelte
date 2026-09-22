<script lang="ts">
	import { onMount } from 'svelte';
	import { listAuditLogs, getUsage } from '$lib/remote/audit.remote.js';
	import type { AuditEvent } from '$lib/remote/audit.remote.js';

	let events = $state<AuditEvent[]>([]);
	let total = $state(0);
	let err = $state<string | null>(null);
	let loading = $state(true);
	let eventType = $state('');
	let q = $state('');

	async function load() {
		loading = true;
		err = null;
		try {
			const res = await listAuditLogs({
				...(eventType ? { event_type: eventType } : {}),
				...(q.trim() ? { q: q.trim() } : {}),
				limit: 50
			});
			events = res.items as AuditEvent[];
			total = res.total;
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	onMount(load);

	let usage = $state<unknown>(null);
	onMount(async () => {
		try {
			usage = await getUsage();
		} catch {
			// optional
		}
	});
</script>

<div class="mx-auto max-w-5xl px-6 py-8">
	<h1 class="text-xl font-semibold text-zinc-100">Audit</h1>
	<p class="mt-1 text-sm text-zinc-400">
		Event log + session timelines. <code class="text-zinc-300">GET /audit/*</code>
		<a href="/audit/usage" class="ml-2 text-indigo-400 hover:text-indigo-300">Usage →</a>
	</p>

	{#if err}
		<div class="mt-4 rounded border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300" role="alert">
			{err}
		</div>
	{/if}

	<form
		onsubmit={(e) => {
			e.preventDefault();
			load();
		}}
		class="mt-6 flex flex-wrap gap-2"
	>
		<input
			bind:value={eventType}
			placeholder="event_type (e.g. chat_turn)"
			class="w-48 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500"
		/>
		<input
			bind:value={q}
			placeholder="Search (q)"
			class="flex-1 rounded border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-500"
		/>
		<button type="submit" class="rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500">Filter</button>
		<button type="button" onclick={() => { eventType = ''; q = ''; load(); }} class="rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800">
			Clear
		</button>
	</form>

	{#if loading}
		<p class="mt-6 text-sm text-zinc-500">Loading…</p>
	{:else}
		<p class="mt-4 text-xs text-zinc-500">{total} events · showing {events.length}</p>
		{#if events.length === 0}
			<p class="mt-2 text-sm text-zinc-500">No events.</p>
		{:else}
			<ul class="mt-2 space-y-2">
				{#each events as e (e.id)}
					<li class="rounded border border-zinc-800 bg-zinc-900 p-3">
						<div class="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
							<span class="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">{e.event_type}</span>
							<span>{new Date(e.ts).toLocaleString()}</span>
							{#if e.actor}<span>actor: {e.actor}</span>{/if}
							{#if e.session_id}<a href="/audit/session/{encodeURIComponent(e.session_id)}" class="text-indigo-400 hover:text-indigo-300">session</a>{/if}
						</div>
						<p class="mt-1 text-sm text-zinc-300">{e.summary}</p>
					</li>
				{/each}
			</ul>
		{/if}
	{/if}

	{#if usage}
		<div class="mt-8 rounded border border-zinc-800 bg-zinc-900 p-4">
			<h2 class="text-sm font-medium text-zinc-200">Usage</h2>
			<pre class="mt-2 max-h-64 overflow-auto rounded bg-zinc-950 p-2 text-xs text-zinc-400">{JSON.stringify(usage, null, 2)}</pre>
		</div>
	{/if}
</div>

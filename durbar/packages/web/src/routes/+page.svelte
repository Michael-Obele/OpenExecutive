<script lang="ts">
	import { getHealth, getToday } from '$lib/remote/health.remote.js';

	let health = $state<{ status: string; provider: string; model: string } | null>(null);
	let today = $state<unknown>(null);
	let error = $state<string | null>(null);

	// Remote `query` values are awaited in the component via `.then` — the
	// canonical pattern is `await getHealth()` in a `load` or `onMount`. For
	// the scaffold we load client-side so the page renders without a
	// `+page.server.ts`.
	import { onMount } from 'svelte';

	onMount(async () => {
		try {
			const [h, t] = await Promise.all([getHealth(), getToday().catch(() => null)]);
			health = h as typeof health;
			today = t;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		}
	});
</script>

<div class="mx-auto max-w-5xl px-6 py-8">
	<h1 class="text-2xl font-semibold text-zinc-100">Dashboard</h1>
	<p class="mt-1 text-sm text-zinc-400">
		Durbar — lean Bun + SQLite reimplementation of OpenExecutive. Dashboard calls Durbar over HTTP;
		set <code class="rounded bg-zinc-800 px-1 py-0.5 text-zinc-300">DURBAR_PUBLIC_URL</code> when hosting
		frontend and server separately.
	</p>

	{#if error}
		<div class="mt-6 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300" role="alert">
			{error}
		</div>
	{/if}

	<div class="mt-6 grid gap-4 sm:grid-cols-2">
		<div class="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
			<h2 class="text-sm font-medium text-zinc-200">Health</h2>
			{#if health}
				<dl class="mt-2 space-y-1 text-sm">
					<div class="flex justify-between"><dt class="text-zinc-500">Status</dt><dd class="text-zinc-200">{health.status}</dd></div>
					<div class="flex justify-between"><dt class="text-zinc-500">Provider</dt><dd class="text-zinc-200">{health.provider}</dd></div>
					<div class="flex justify-between"><dt class="text-zinc-500">Model</dt><dd class="text-zinc-200">{health.model}</dd></div>
				</dl>
			{:else}
				<p class="mt-2 text-sm text-zinc-500">Loading…</p>
			{/if}
		</div>

		<div class="rounded-xl border border-zinc-800 bg-zinc-900 p-4">
			<h2 class="text-sm font-medium text-zinc-200">Today</h2>
			{#if today}
				<pre class="mt-2 max-h-48 overflow-auto rounded bg-zinc-950 p-2 text-xs text-zinc-400">{JSON.stringify(today, null, 2)}</pre>
			{:else}
				<p class="mt-2 text-sm text-zinc-500">Loading…</p>
			{/if}
		</div>
	</div>

	<div class="mt-6 rounded-xl border border-zinc-800 bg-zinc-900 p-4">
		<h2 class="text-sm font-medium text-zinc-200">Chat</h2>
		<p class="mt-1 text-sm text-zinc-500">
			Chat turns are SSE streams (<code class="text-zinc-400">POST /chat → text/event-stream</code>). The
			dashboard starts a turn and streams events directly from Durbar — no same-origin assumption.
		</p>
		<a href="/today" class="mt-3 inline-block rounded bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500">
			Open Today →
		</a>
	</div>
</div>

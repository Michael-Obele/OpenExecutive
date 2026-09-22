<script lang="ts">
	import { onMount } from "svelte";
	import { listWorkflows, listWorkflowRuns } from "$lib/remote/workflows.remote.js";
	import * as Card from "$lib/components/ui/card/index.js";
	import * as Alert from "$lib/components/ui/alert/index.js";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { Skeleton } from "$lib/components/ui/skeleton/index.js";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import ClipboardCheck from "@lucide/svelte/icons/clipboard-check";

	let workflows = $state<unknown[]>([]);
	let runs = $state<unknown[]>([]);
	let err = $state<string | null>(null);
	let loading = $state(true);

	onMount(async () => {
		try {
			const [w, r] = await Promise.all([
				listWorkflows() as Promise<unknown[]>,
				listWorkflowRuns() as Promise<unknown[]>,
			]);
			workflows = w;
			runs = r;
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	});
</script>

<div class="mx-auto max-w-5xl px-6 py-8">
	<h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
		<ClipboardCheck class="size-5" /> Workflows
	</h1>
	<p class="text-muted-foreground mt-1 text-sm">
		Catalog + runs. SSE streams for live runs (<code>POST /workflows/{"{name}"}/runs → text/event-stream</code>).
	</p>

	{#if err}
		<Alert.Root variant="destructive" class="mt-4">
			<TriangleAlert />
			<Alert.Title>Load failed</Alert.Title>
			<Alert.Description>{err}</Alert.Description>
		</Alert.Root>
	{/if}

	<h2 class="mt-6 text-sm font-medium">Catalog</h2>
	{#if loading}
		<div class="mt-2 grid gap-3">
			<Skeleton class="h-20 w-full" />
			<Skeleton class="h-20 w-full" />
		</div>
	{:else}
		<div class="mt-2 grid gap-3">
			{#each workflows as w ((w as Record<string, unknown>).name ?? JSON.stringify(w))}
				<Card.Root>
					<Card.Header>
						<Card.Title class="flex items-center justify-between text-sm">
							<span>{String((w as Record<string, unknown>).title ?? (w as Record<string, unknown>).name)}</span>
							<Badge variant="outline">{String((w as Record<string, unknown>).name ?? "")}</Badge>
						</Card.Title>
					</Card.Header>
					<Card.Content>
						<pre class="text-muted-foreground overflow-auto text-xs">{JSON.stringify(w, null, 2)}</pre>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}

	<h2 class="mt-6 text-sm font-medium">Recent runs</h2>
	{#if loading}
		<div class="mt-2 grid gap-3">
			<Skeleton class="h-20 w-full" />
		</div>
	{:else}
		<div class="mt-2 grid gap-3">
			{#each runs as r ((r as Record<string, unknown>).id ?? JSON.stringify(r))}
				<Card.Root>
					<Card.Content class="pt-4">
						<pre class="text-muted-foreground overflow-auto text-xs">{JSON.stringify(r, null, 2)}</pre>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>

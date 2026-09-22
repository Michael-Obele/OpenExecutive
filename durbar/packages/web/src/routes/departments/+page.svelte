<script lang="ts">
	import { onMount } from "svelte";
	import { listDepartments, createDepartment } from "$lib/remote/departments.remote.js";
	import * as Card from "$lib/components/ui/card/index.js";
	import * as Alert from "$lib/components/ui/alert/index.js";
	import { Input } from "$lib/components/ui/input/index.js";
	import { Label } from "$lib/components/ui/label/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import { Badge } from "$lib/components/ui/badge/index.js";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import Layers from "@lucide/svelte/icons/layers";
	import Plus from "@lucide/svelte/icons/plus";

	let depts = $state<unknown[]>([]);
	let err = $state<string | null>(null);
	let title = $state("");

	async function load() {
		try {
			depts = (await listDepartments()) as unknown[];
			err = null;
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		}
	}

	onMount(load);
</script>

<div class="mx-auto max-w-5xl px-6 py-8">
	<h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
		<Layers class="size-5" /> Departments
	</h1>
	<p class="text-muted-foreground mt-1 text-sm">
		Each department wraps a specialist agent. Create via remote <code>command</code>.
	</p>

	{#if err}
		<Alert.Root variant="destructive" class="mt-4">
			<TriangleAlert />
			<Alert.Title>Load failed</Alert.Title>
			<Alert.Description>{err}</Alert.Description>
		</Alert.Root>
	{/if}

	<Card.Root class="mt-6">
		<Card.Header>
			<Card.Title class="text-sm">New department</Card.Title>
		</Card.Header>
		<Card.Content>
			<form
				onsubmit={async (e) => {
					e.preventDefault();
					if (!title.trim()) return;
					await createDepartment({ title: title.trim() });
					title = "";
					await load();
				}}
				class="flex gap-2"
			>
				<div class="flex-1">
					<Label for="dept-title" class="sr-only">Title</Label>
					<Input id="dept-title" bind:value={title} placeholder="New department title" />
				</div>
				<Button type="submit">
					<Plus class="size-4" /> Create
				</Button>
			</form>
		</Card.Content>
	</Card.Root>

	{#if depts.length === 0 && !err}
		<p class="text-muted-foreground mt-4 text-sm">No departments yet.</p>
	{:else}
		<div class="mt-4 grid gap-3">
			{#each depts as d ((d as Record<string, unknown>).slug ?? (d as Record<string, unknown>).id ?? JSON.stringify(d))}
				<Card.Root>
					<Card.Content class="pt-4">
						<div class="flex items-center justify-between">
							<span class="text-sm font-medium">{String((d as Record<string, unknown>).title ?? (d as Record<string, unknown>).slug ?? "Untitled")}</span>
							<Badge variant="secondary">{String((d as Record<string, unknown>).slug ?? "")}</Badge>
						</div>
						<pre class="text-muted-foreground mt-2 overflow-auto text-xs">{JSON.stringify(d, null, 2)}</pre>
					</Card.Content>
				</Card.Root>
			{/each}
		</div>
	{/if}
</div>

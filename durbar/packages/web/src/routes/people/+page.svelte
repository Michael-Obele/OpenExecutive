<script lang="ts">
	import { onMount } from "svelte";
	import { listPeople, createPerson } from "$lib/remote/people.remote.js";
	import * as Card from "$lib/components/ui/card/index.js";
	import * as Alert from "$lib/components/ui/alert/index.js";
	import { Input } from "$lib/components/ui/input/index.js";
	import { Label } from "$lib/components/ui/label/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import Users from "@lucide/svelte/icons/users";
	import Plus from "@lucide/svelte/icons/plus";

	let people = $state<unknown[]>([]);
	let err = $state<string | null>(null);
	let name = $state("");

	async function load() {
		try {
			people = (await listPeople()) as unknown[];
			err = null;
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		}
	}

	onMount(load);
</script>

<div class="mx-auto max-w-5xl px-6 py-8">
	<h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
		<Users class="size-5" /> People
	</h1>
	<p class="text-muted-foreground mt-1 text-sm">Roster + authority levels.</p>

	{#if err}
		<Alert.Root variant="destructive" class="mt-4">
			<TriangleAlert />
			<Alert.Title>Load failed</Alert.Title>
			<Alert.Description>{err}</Alert.Description>
		</Alert.Root>
	{/if}

	<Card.Root class="mt-6">
		<Card.Header>
			<Card.Title class="text-sm">Add person</Card.Title>
		</Card.Header>
		<Card.Content>
			<form
				onsubmit={async (e) => {
					e.preventDefault();
					if (!name.trim()) return;
					await createPerson({ full_name: name.trim() });
					name = "";
					await load();
				}}
				class="flex gap-2"
			>
				<div class="flex-1">
					<Label for="person-name" class="sr-only">Full name</Label>
					<Input id="person-name" bind:value={name} placeholder="Full name" />
				</div>
				<Button type="submit">
					<Plus class="size-4" /> Add
				</Button>
			</form>
		</Card.Content>
	</Card.Root>

	<div class="mt-4 grid gap-3">
		{#each people as p ((p as Record<string, unknown>).id ?? (p as Record<string, unknown>).full_name ?? JSON.stringify(p))}
			<Card.Root>
				<Card.Content class="pt-4">
					<pre class="text-muted-foreground overflow-auto text-xs">{JSON.stringify(p, null, 2)}</pre>
				</Card.Content>
			</Card.Root>
		{/each}
	</div>
</div>

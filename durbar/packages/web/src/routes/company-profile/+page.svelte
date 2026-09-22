<script lang="ts">
	import { onMount } from "svelte";
	import { getCompanyProfile, updateCompanyProfile } from "$lib/remote/company.remote.js";
	import * as Card from "$lib/components/ui/card/index.js";
	import * as Alert from "$lib/components/ui/alert/index.js";
	import { Input } from "$lib/components/ui/input/index.js";
	import { Textarea } from "$lib/components/ui/textarea/index.js";
	import { Label } from "$lib/components/ui/label/index.js";
	import { Button } from "$lib/components/ui/button/index.js";
	import TriangleAlert from "@lucide/svelte/icons/triangle-alert";
	import Building from "@lucide/svelte/icons/building";

	let profile = $state<Record<string, unknown> | null>(null);
	let err = $state<string | null>(null);
	onMount(async () => {
		try {
			profile = (await getCompanyProfile()) as Record<string, unknown>;
		} catch (e) {
			err = e instanceof Error ? e.message : String(e);
		}
	});
</script>

<div class="mx-auto max-w-3xl px-6 py-8">
	<h1 class="flex items-center gap-2 text-xl font-semibold tracking-tight">
		<Building class="size-5" /> Company Profile
	</h1>
	<p class="text-muted-foreground mt-1 text-sm">
		Structured profile the Executive grounds every answer in. Uses remote <code>form</code> (Valibot) for PATCH — native HTML form, no handleSubmit.
	</p>

	{#if err}
		<Alert.Root variant="destructive" class="mt-4">
			<TriangleAlert />
			<Alert.Title>Load failed</Alert.Title>
			<Alert.Description>{err}</Alert.Description>
		</Alert.Root>
	{/if}

	{#if profile}
		<Card.Root class="mt-4">
			<Card.Header>
				<Card.Title class="text-sm">Current profile</Card.Title>
			</Card.Header>
			<Card.Content>
				<pre class="bg-muted overflow-auto rounded p-3 text-xs">{JSON.stringify(profile, null, 2)}</pre>
			</Card.Content>
		</Card.Root>
	{/if}

	<Card.Root class="mt-6">
		<Card.Header>
			<Card.Title class="text-sm">Update</Card.Title>
			<Card.Description>Edit name and mission via remote form.</Card.Description>
		</Card.Header>
		<Card.Content>
			<form {...updateCompanyProfile} class="space-y-4">
				<div class="space-y-2">
					<Label for="company-name">Name</Label>
					<Input {...updateCompanyProfile.fields.name.as("text")} id="company-name" placeholder="Company name" />
				</div>
				<div class="space-y-2">
					<Label for="company-mission">Mission</Label>
					<Textarea {...updateCompanyProfile.fields.mission.as("text")} id="company-mission" rows={3} placeholder="Mission" />
				</div>
				<Button type="submit">Save</Button>
			</form>
		</Card.Content>
	</Card.Root>
</div>

<script lang="ts">
	// Redirect handled server-side in +page.server.ts — this is a fallback.
	import { goto } from '$app/navigation';
	import { onMount } from 'svelte';
	onMount(() => goto('/'));
</script>

<p class="p-6 text-sm text-fg-muted">Redirecting…</p>

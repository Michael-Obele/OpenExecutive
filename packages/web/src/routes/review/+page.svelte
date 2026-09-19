<script lang="ts">
	import ReviewQueue from '$lib/components/ReviewQueue.svelte';
</script>

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="p-6 pb-0">
		<h1 class="text-xl font-semibold text-fg">Review</h1>
		<p class="mt-2 text-sm text-fg-muted">
			Approve, reject, or correct incoming knowledge before the Executive relies on it.
		</p>
	</div>
	<ReviewQueue />
</main>

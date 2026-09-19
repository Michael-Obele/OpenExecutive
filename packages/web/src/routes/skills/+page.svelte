<script lang="ts">
	import SkillsBrowser from '$lib/components/SkillsBrowser.svelte';
</script>

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-5xl px-6 pt-8">
		<h1 class="text-xl font-semibold text-fg">Skills</h1>
		<p class="mt-2 text-sm text-fg-muted">
			Reusable how-to procedures — checklists, playbooks, templates.
		</p>
	</div>
	<SkillsBrowser />
</main>

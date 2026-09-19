<script lang="ts">
	// Create-a-file form for the built-in / failure knowledge trees.
	// Ported from `packages/ui/src/components/knowledge/NewFileForm.tsx`.
	interface Props {
		domains: string[];
		initialDomain: string;
		variant: 'playbook' | 'failure';
		onSave: (domain: string, filename: string, content: string) => Promise<void>;
		onCancel: () => void;
	}

	let { domains, initialDomain, variant, onSave, onCancel }: Props = $props();

	// Capturing the *initial* domain is intentional — the upstream component used
	// `useState(initialDomain)`, which likewise reads the prop once at construction.
	// svelte-ignore state_referenced_locally
	let domain = $state(initialDomain);
	let filename = $state('');
	let content = $state('');
	let isSaving = $state(false);
	let error = $state<string | null>(null);

	async function handleSubmit() {
		const trimmed = filename.trim();
		const fullName = trimmed.endsWith('.md') ? trimmed : `${trimmed}.md`;
		if (!/^[a-zA-Z0-9_\-]+\.md$/.test(fullName)) {
			error = 'Filename must be alphanumeric with dashes or underscores';
			return;
		}
		isSaving = true;
		error = null;
		try {
			await onSave(domain, fullName, content);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to create file';
			isSaving = false;
		}
	}

	let title = $derived(variant === 'failure' ? 'New failure case' : 'New playbook file');
	let placeholder = $derived(
		variant === 'failure'
			? '# Company X: <one-line failure summary>\n\n## Situation\n\n## What Happened\n\n## Root Cause\n\n## Key Decision Failures\n'
			: '# Title\n\nWrite your knowledge here…'
	);
</script>

<form
	class="flex flex-col gap-4"
	onsubmit={(e) => {
		e.preventDefault();
		void handleSubmit();
	}}
>
	<h2 class="text-base font-semibold text-fg">{title}</h2>
	{#if error}
		<p
			class="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400"
			role="alert"
		>
			{error}
		</p>
	{/if}
	<div class="flex gap-3">
		<select
			bind:value={domain}
			aria-label="Domain"
			class="rounded-lg border border-line-strong bg-surface-elevated px-3 py-2 text-sm text-fg focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
		>
			{#each domains as d (d)}
				<option value={d}>{d}</option>
			{/each}
		</select>
		<input
			bind:value={filename}
			aria-label="Filename"
			placeholder={variant === 'failure' ? 'my-failure-case.md' : 'my_topic.md'}
			class="flex-1 rounded-lg border border-line-strong bg-surface-elevated px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
		/>
	</div>
	<textarea
		bind:value={content}
		aria-label="File content"
		{placeholder}
		class="min-h-100 w-full resize-none rounded-xl border border-line-strong bg-surface-elevated px-4 py-3 font-mono text-sm text-fg focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
	></textarea>
	<div class="flex gap-3">
		<button
			type="submit"
			disabled={!filename.trim() || !content.trim() || isSaving}
			class="rounded-xl bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-400 disabled:opacity-40"
		>
			{isSaving ? 'Creating…' : 'Create file'}
		</button>
		<button
			type="button"
			onclick={onCancel}
			class="rounded-xl border border-line-strong px-4 py-2 text-sm text-fg-muted transition-colors hover:text-fg"
		>
			Cancel
		</button>
	</div>
</form>

<script lang="ts">
	import type { CommitteePhase } from '$lib/api.js';

	interface Props {
		phase: CommitteePhase | null;
	}

	let { phase }: Props = $props();

	const STEPS: { key: CommitteePhase; label: string }[] = [
		{ key: 'drafting', label: 'Drafting' },
		{ key: 'reviewing', label: 'Committee review' },
		{ key: 'finalizing', label: 'Revising' }
	];

	let activeIdx = $derived(phase ? STEPS.findIndex((s) => s.key === phase) : -1);
</script>

<div class="flex items-center gap-2 text-xs text-fg-muted">
	{#each STEPS as step, i (step.key)}
		{@const isActive = i === activeIdx}
		{@const isDone = i < activeIdx}
		<div class="flex items-center gap-2">
			<div
				class={'h-1.5 w-1.5 rounded-full ' +
					(isActive
						? 'animate-pulse bg-indigo-400 motion-reduce:animate-none'
						: isDone
							? 'bg-indigo-500/60'
							: 'bg-surface-input')}
			></div>
			<span class={isActive ? 'text-fg italic' : isDone ? 'text-fg-muted' : 'text-fg-subtle'}>
				{step.label}
			</span>
			{#if i < STEPS.length - 1}
				<span class="text-fg-subtle">→</span>
			{/if}
		</div>
	{/each}
</div>

<script lang="ts">
	import type { Candidate } from '$lib/api.js';
	import StageBadge from './StageBadge.svelte';
	import { fitScoreColor } from './stages.js';

	interface Props {
		candidate: Candidate;
	}

	let { candidate }: Props = $props();

	let subtitle = $derived(
		[candidate.current_title, candidate.current_company].filter(Boolean).join(' · ')
	);
</script>

<!-- Compact candidate card used on the pipeline board and engagement detail. -->
<a
	href={`/talent/candidates/${candidate.id}`}
	class="group block rounded-xl border border-line bg-surface-elevated p-3 transition-colors hover:bg-surface-overlay"
>
	<div class="flex items-start justify-between gap-2">
		<div class="min-w-0">
			<div class="truncate text-sm font-semibold text-fg group-hover:text-indigo-300">
				{candidate.full_name}
			</div>
			{#if subtitle}
				<div class="mt-0.5 truncate text-xs text-fg-muted">{subtitle}</div>
			{/if}
		</div>
		<div
			class={`text-sm font-semibold tabular-nums ${fitScoreColor(candidate.fit_score)}`}
			title="Fit score"
		>
			{candidate.fit_score ?? '—'}
		</div>
	</div>
	<div class="mt-2">
		<StageBadge stage={candidate.stage} />
	</div>
</a>

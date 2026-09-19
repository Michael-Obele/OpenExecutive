<script lang="ts">
	import type { CandidateStage } from '$lib/api.js';
	import { STAGE_META } from './stages.js';

	// Ported from `packages/ui/src/components/talent/StageBadge.tsx`. That file also
	// exported a sibling `StatusBadge`; one component per file here, so the two
	// call sites (`/talent/searches`, `/talent/engagements/[id]`) render it inline
	// from `STATUS_META` instead.
	interface Props {
		stage: CandidateStage;
	}

	let { stage }: Props = $props();

	// The `??` fallback matches the upstream component: the API can hand back a
	// stage string this build doesn't know about yet.
	let meta = $derived(
		STAGE_META[stage] ?? {
			label: stage,
			pill: 'bg-zinc-500/20 text-zinc-300 border-zinc-500/30'
		}
	);
</script>

<span class={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${meta.pill}`}>
	{meta.label}
</span>

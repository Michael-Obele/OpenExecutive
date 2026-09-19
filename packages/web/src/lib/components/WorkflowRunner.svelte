<script lang="ts">
	import { onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import {
		runWorkflow,
		type WorkflowEvent,
		type WorkflowMeta,
		type WorkflowStepDef
	} from '$lib/api.js';

	type StepState = 'pending' | 'running' | 'done' | 'skipped';

	interface StepStatus {
		def: WorkflowStepDef;
		state: StepState;
		summary?: string;
	}

	interface Props {
		workflow: WorkflowMeta;
		inputs: Record<string, unknown>;
		onCancel: () => void;
	}

	let { workflow, inputs, onCancel }: Props = $props();

	// Ported from `packages/ui/src/components/WorkflowRunner.tsx`, where the
	// step list is seeded from the prop with `useState(...)`.
	// svelte-ignore state_referenced_locally
	let steps = $state<StepStatus[]>(
		workflow.steps.map((s): StepStatus => ({ def: s, state: 'pending' }))
	);
	let runId = $state<string | null>(null);
	let error = $state<string | null>(null);
	let streaming = $state(false);
	let started = $state(false);

	// `runWorkflow` streams a long-lived async generator and exposes no abort
	// signal. Navigating away mid-run tears the component down, so stop
	// applying events rather than writing into a destroyed instance.
	let destroyed = false;
	onDestroy(() => {
		destroyed = true;
	});

	async function handleStart() {
		started = true;
		streaming = true;
		error = null;
		runId = null;
		steps = workflow.steps.map((s): StepStatus => ({ def: s, state: 'pending' }));

		try {
			for await (const evt of runWorkflow(workflow.name, inputs)) {
				if (destroyed) break;
				applyEvent(evt);
			}
		} catch (e) {
			if (!destroyed) error = e instanceof Error ? e.message : String(e);
		} finally {
			if (!destroyed) streaming = false;
		}
	}

	function applyEvent(evt: WorkflowEvent) {
		if (evt.type === 'run_created' && evt.run_id) {
			runId = evt.run_id;
			return;
		}
		if (evt.type === 'step_start' && evt.step_id) {
			const stepId = evt.step_id;
			steps = steps.map((s): StepStatus => (s.def.id === stepId ? { ...s, state: 'running' } : s));
			return;
		}
		if (evt.type === 'step_done' && evt.step_id) {
			const stepId = evt.step_id;
			const isSkipped = typeof evt.summary === 'string' && evt.summary.startsWith('Skipped');
			steps = steps.map((s): StepStatus =>
				s.def.id === stepId
					? { ...s, state: isSkipped ? 'skipped' : 'done', summary: evt.summary }
					: s
			);
			return;
		}
		if (evt.type === 'done' && evt.run_id) {
			// Redirect to the run page to view the artifact
			void goto(`/jobs/runs/${encodeURIComponent(evt.run_id)}`);
			return;
		}
		if (evt.type === 'error') {
			error = evt.message ?? 'Workflow failed';
			return;
		}
	}
</script>

{#snippet stepIndicator(state: StepState, index: number)}
	{#if state === 'done'}
		<div
			class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-emerald-500/20 text-[10px] font-bold text-emerald-400"
			aria-hidden="true"
		>
			✓
		</div>
	{:else if state === 'skipped'}
		<div
			class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-overlay text-[10px] font-medium text-fg-muted"
			aria-hidden="true"
		>
			—
		</div>
	{:else if state === 'running'}
		<div
			class="flex h-6 w-6 shrink-0 animate-pulse items-center justify-center rounded-full bg-amber-500/20 text-[10px] font-bold text-amber-400"
			aria-hidden="true"
		>
			{index}
		</div>
	{:else}
		<div
			class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full border border-line bg-surface-elevated text-[10px] font-medium text-fg-subtle"
			aria-hidden="true"
		>
			{index}
		</div>
	{/if}
{/snippet}

<div class="space-y-6">
	{#if !started}
		<div class="flex items-center gap-3">
			<button
				type="button"
				onclick={() => void handleStart()}
				class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500"
			>
				Run job
			</button>
			<button
				type="button"
				onclick={onCancel}
				class="rounded-md border border-line-strong px-4 py-2 text-sm text-fg transition hover:border-line-strong hover:text-fg"
			>
				Cancel
			</button>
			<span class="ml-auto text-xs text-fg-muted">
				~{workflow.estimated_minutes} min · {workflow.steps.length} steps
			</span>
		</div>
	{/if}

	{#if started}
		<div class="rounded-lg border border-line bg-surface/40 p-5" aria-busy={streaming}>
			<div class="mb-4 flex items-center justify-between">
				<h3 class="text-sm font-semibold text-fg">Progress</h3>
				{#if streaming}
					<span class="flex items-center gap-1.5 text-xs text-amber-400" role="status">
						<span class="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400"></span>
						Running
					</span>
				{/if}
				{#if !streaming && !error && runId}
					<span class="text-xs text-emerald-400">Complete</span>
				{/if}
				{#if error}
					<span class="text-xs text-red-400">Failed</span>
				{/if}
			</div>
			<ol class="space-y-3">
				<!-- Positional list, never reordered — index keys are safe here and
				     avoid a duplicate-key crash if two steps share an id. -->
				{#each steps as s, i (i)}
					<li class="flex gap-3">
						{@render stepIndicator(s.state, i + 1)}
						<div class="min-w-0 flex-1">
							<div class="flex items-baseline justify-between gap-3">
								<div class="text-sm font-medium text-fg">{s.def.title}</div>
								<div class="text-[10px] tracking-wide text-fg-muted uppercase">{s.state}</div>
							</div>
							<div class="mt-0.5 text-xs text-fg-muted">{s.def.description}</div>
							{#if s.summary}
								<div class="mt-1.5 text-xs text-fg-muted italic">{s.summary}</div>
							{/if}
						</div>
					</li>
				{/each}
			</ol>
			{#if error}
				<div class="mt-4 rounded-md border border-red-500/20 bg-red-500/5 p-3 text-sm text-red-400">
					<div class="mb-1 font-medium">Workflow failed</div>
					<div class="text-xs">{error}</div>
				</div>
			{/if}
		</div>
	{/if}
</div>

<script lang="ts">
	import { onMount } from 'svelte';
	import TimeframePicker, { suggestPeriodValue } from '$lib/components/TimeframePicker.svelte';
	import { createGoal, type Goal, type PeriodType } from '$lib/api.js';
	import { STATUS_OPTS, type GoalStatus } from './shared.js';

	interface Props {
		slug: string;
		onCreated: (goal: Goal) => void;
		onCancel: () => void;
	}

	let { slug, onCreated, onCancel }: Props = $props();

	interface GoalFormState {
		period_type: PeriodType;
		period_value: string;
		key_result: string;
		target: string;
		current: string;
		status: GoalStatus;
	}

	let form = $state<GoalFormState>({
		period_type: 'quarter',
		period_value: suggestPeriodValue('quarter'),
		key_result: '',
		target: '',
		current: '',
		status: 'on_track'
	});
	let saving = $state(false);
	let err = $state<string | null>(null);
	let firstEl = $state<HTMLInputElement | null>(null);

	onMount(() => {
		firstEl?.focus();
	});

	async function handleCreate() {
		saving = true;
		err = null;
		try {
			const goal = await createGoal(slug, form);
			onCreated(goal);
		} catch (e) {
			err = e instanceof Error ? e.message : 'Create failed';
		} finally {
			saving = false;
		}
	}
</script>

<div class="-mx-4 space-y-2 rounded-lg border-b border-line bg-surface-overlay/30 px-4 py-3">
	<div class="mb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">New Goal</div>
	<TimeframePicker
		periodType={form.period_type}
		periodValue={form.period_value}
		onChange={(pt, pv) => {
			form.period_type = pt;
			form.period_value = pv;
		}}
		size="compact"
	/>
	<label class="flex flex-col gap-1 text-xs text-fg-muted">
		Status
		<select
			value={form.status}
			onchange={(e) => (form.status = e.currentTarget.value as GoalStatus)}
			class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
		>
			{#each STATUS_OPTS as s (s)}
				<option value={s}>{s.replace('_', ' ')}</option>
			{/each}
		</select>
	</label>
	<label class="flex flex-col gap-1 text-xs text-fg-muted">
		Key result
		<input
			bind:this={firstEl}
			value={form.key_result}
			oninput={(e) => (form.key_result = e.currentTarget.value)}
			class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
			placeholder="What do we want to achieve?"
		/>
	</label>
	<label class="flex flex-col gap-1 text-xs text-fg-muted">
		Target
		<input
			value={form.target}
			oninput={(e) => (form.target = e.currentTarget.value)}
			class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
			placeholder="Measurable target"
		/>
	</label>
	<label class="flex flex-col gap-1 text-xs text-fg-muted">
		Current (optional)
		<input
			value={form.current}
			oninput={(e) => (form.current = e.currentTarget.value)}
			class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
			placeholder="Current progress"
		/>
	</label>
	{#if err}<p class="text-xs text-rose-300" role="alert">{err}</p>{/if}
	<div class="flex gap-2">
		<button
			type="button"
			disabled={saving || !form.period_value || !form.key_result || !form.target}
			onclick={() => void handleCreate()}
			class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50"
		>
			{saving ? 'Creating…' : 'Add Goal'}
		</button>
		<button
			type="button"
			disabled={saving}
			onclick={onCancel}
			class="rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-surface-overlay disabled:opacity-50"
		>
			Cancel
		</button>
	</div>
</div>

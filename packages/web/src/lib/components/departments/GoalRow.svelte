<script lang="ts">
	import { onMount } from 'svelte';
	import TimeframePicker from '$lib/components/TimeframePicker.svelte';
	import { deleteGoal, updateGoal, type Goal, type PeriodType } from '$lib/api.js';
	import { formatRelativeTime } from '$lib/helpers.js';
	import {
		cls,
		formatPeriodLabel,
		isStaleReview,
		STATUS_COLORS,
		STATUS_OPTS,
		type GoalStatus
	} from './shared.js';

	interface Props {
		slug: string;
		goal: Goal;
		onSaved: (updated: Goal) => void;
		onDeleted: (id: number) => void;
		// Surface edit-mode transitions so the parent can pause polling — a
		// server snapshot replacing `goals` while a user is mid-edit would
		// flicker the view label and discard the form state.
		onEditingChange?: (editing: boolean) => void;
	}

	let { slug, goal, onSaved, onDeleted, onEditingChange }: Props = $props();

	interface GoalFormState {
		period_type: PeriodType;
		period_value: string;
		key_result: string;
		target: string;
		current: string;
		status: GoalStatus;
	}

	function formFrom(g: Goal): GoalFormState {
		return {
			period_type: g.period_type,
			period_value: g.period_value,
			key_result: g.key_result,
			target: g.target,
			current: g.current,
			status: g.status
		};
	}

	let editing = $state(false);
	let saving = $state(false);
	let deleting = $state(false);
	let err = $state<string | null>(null);
	// Seed the form once from the row's first snapshot, matching the upstream
	// `useState` initializer (later edits are owned by this row).
	// svelte-ignore state_referenced_locally
	let form = $state<GoalFormState>(formFrom(goal));

	let stale = $derived(isStaleReview(goal.last_reviewed_at));

	// Centralise the editing transition so save/cancel/hover-edit all notify
	// the parent — avoids forgetting the call in one branch.
	function setEditingAndNotify(next: boolean) {
		editing = next;
		onEditingChange?.(next);
	}

	// Belt-and-suspenders: if the row unmounts while still in edit mode (e.g.
	// the parent replaces the goals list and drops this row), the parent's edit
	// counter would otherwise stay incremented and pause polling forever.
	// Reading the live `editing` value here — rather than a value captured at
	// mount — is the Svelte equivalent of the upstream `editingRef`; the
	// parent's `Math.max(0, …)` guards against a double-decrement if the row
	// also ran its own cancel path before unmount.
	onMount(() => {
		return () => {
			if (editing) onEditingChange?.(false);
		};
	});

	function cancelEdit() {
		form = formFrom(goal);
		setEditingAndNotify(false);
		err = null;
	}

	async function handleSave() {
		saving = true;
		err = null;
		try {
			const updated = await updateGoal(slug, goal.id!, form);
			onSaved(updated);
			setEditingAndNotify(false);
		} catch (e) {
			err = e instanceof Error ? e.message : 'Save failed';
		} finally {
			saving = false;
		}
	}

	async function handleDelete() {
		if (!window.confirm('Delete this Goal?')) return;
		deleting = true;
		err = null;
		try {
			await deleteGoal(slug, goal.id!);
			onDeleted(goal.id!);
		} catch (e) {
			err = e instanceof Error ? e.message : 'Delete failed';
			deleting = false;
		}
	}
</script>

{#if !editing}
	<div
		class={cls(
			'group flex items-start gap-3 border-b border-line py-3 last:border-0',
			stale && '-ml-3 border-l-2 border-l-amber-500/60 pl-3'
		)}
	>
		<span
			class={cls(
				'mt-0.5 inline-block shrink-0 rounded border px-2 py-0.5 text-[10px] font-medium',
				STATUS_COLORS[goal.status]
			)}
		>
			{goal.status.replace('_', ' ')}
		</span>
		<div class="min-w-0 flex-1">
			<div class="text-sm font-medium text-fg">{goal.key_result}</div>
			<div class="mt-0.5 text-xs text-fg-muted">
				Target: {goal.target}{goal.current ? ` — Current: ${goal.current}` : ''}
			</div>
			<div class="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-fg-subtle">
				<span>{formatPeriodLabel(goal)}</span>
				<span aria-hidden="true">·</span>
				{#if goal.last_reviewed_at}
					<span class={cls(stale && 'text-amber-400')}>
						Last reviewed {formatRelativeTime(goal.last_reviewed_at)}
					</span>
				{:else}
					<span class="italic">Never reviewed</span>
				{/if}
			</div>
		</div>
		<!-- `group-focus-within` is additive to upstream's hover reveal so the
		     row actions stay reachable for keyboard users. -->
		<div
			class="flex shrink-0 flex-col items-end gap-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100"
		>
			<div class="flex gap-1">
				<button
					type="button"
					onclick={() => setEditingAndNotify(true)}
					class="rounded border border-line bg-surface-overlay px-2 py-1 text-xs hover:bg-surface-input"
				>
					Edit
				</button>
				<button
					type="button"
					disabled={deleting}
					onclick={() => void handleDelete()}
					class="rounded border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-xs text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
				>
					{deleting ? '…' : 'Delete'}
				</button>
			</div>
			{#if err}<span class="text-[10px] text-rose-300" role="alert">{err}</span>{/if}
		</div>
	</div>
{:else}
	<div class="space-y-2 border-b border-line py-3 last:border-0">
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
				value={form.key_result}
				oninput={(e) => (form.key_result = e.currentTarget.value)}
				class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
				placeholder="Close Series A by Jun 30"
			/>
		</label>
		<label class="flex flex-col gap-1 text-xs text-fg-muted">
			Target
			<input
				value={form.target}
				oninput={(e) => (form.target = e.currentTarget.value)}
				class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
				placeholder="What does done look like?"
			/>
		</label>
		<label class="flex flex-col gap-1 text-xs text-fg-muted">
			Current
			<input
				value={form.current}
				oninput={(e) => (form.current = e.currentTarget.value)}
				class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
				placeholder="Where are we now?"
			/>
		</label>
		{#if err}<p class="text-xs text-rose-300" role="alert">{err}</p>{/if}
		<div class="flex gap-2">
			<button
				type="button"
				disabled={saving}
				onclick={() => void handleSave()}
				class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white hover:bg-indigo-500 disabled:opacity-50"
			>
				{saving ? 'Saving…' : 'Save'}
			</button>
			<button
				type="button"
				disabled={saving}
				onclick={cancelEdit}
				class="rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-surface-overlay disabled:opacity-50"
			>
				Cancel
			</button>
		</div>
	</div>
{/if}

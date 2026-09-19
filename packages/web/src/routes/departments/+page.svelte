<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { createDepartment, listDepartments, type DepartmentState } from '$lib/api.js';

	const AUTHORITY_LABELS: Record<string, string> = {
		auto_execute: 'Auto',
		propose_only: 'Propose',
		escalate: 'Escalate'
	};

	const AUTHORITY_COLORS: Record<string, string> = {
		auto_execute: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30',
		propose_only: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
		escalate: 'bg-amber-500/20 text-amber-300 border-amber-500/30'
	};

	let depts = $state.raw<DepartmentState[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Add-department modal — state hoisted out of the upstream `AddDepartmentModal`
	// sub-component (one component per `.svelte` file in this port).
	let addingDept = $state(false);
	let form = $state({ title: '', mission: '' });
	let saving = $state(false);
	let err = $state<string | null>(null);
	let titleEl = $state<HTMLInputElement | null>(null);

	onMount(() => {
		listDepartments()
			.then((v) => (depts = v))
			.catch((e) => (error = e instanceof Error ? e.message : 'Failed to load'))
			.finally(() => (loading = false));
	});

	async function openAdd() {
		form = { title: '', mission: '' };
		err = null;
		addingDept = true;
		// Upstream focused the title input on modal mount.
		await tick();
		titleEl?.focus();
	}

	function closeAdd() {
		if (saving) return;
		addingDept = false;
	}

	async function handleCreate() {
		saving = true;
		err = null;
		try {
			const dept = await createDepartment({ title: form.title.trim(), mission: form.mission });
			depts = [...depts, dept];
			addingDept = false;
		} catch (e) {
			err = e instanceof Error ? e.message : 'Create failed';
		} finally {
			saving = false;
		}
	}
</script>

{#snippet statusPill(status: string)}
	{@const pillCls =
		status === 'on_track'
			? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
			: status === 'at_risk'
				? 'bg-amber-500/20 text-amber-300 border-amber-500/30'
				: 'bg-rose-500/20 text-rose-300 border-rose-500/30'}
	<span class="inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium {pillCls}">
		{status.replace('_', ' ')}
	</span>
{/snippet}

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-5xl px-6 py-6">
		<div class="mb-1 flex items-center justify-between">
			<h1 class="text-xl font-semibold text-fg">Departments</h1>
			<button
				type="button"
				onclick={() => void openAdd()}
				class="rounded-lg border border-indigo-500/30 bg-indigo-600/20 px-3 py-1.5 text-xs text-indigo-300 hover:bg-indigo-600/30"
			>
				+ Add department
			</button>
		</div>
		<p class="mb-6 text-sm text-fg-muted">
			Each department wraps a specialist agent with persistent Goals, authority level, and cadences.
		</p>

		{#if loading}
			<p class="text-sm text-fg-muted" role="status">Loading…</p>
		{/if}
		{#if error}
			<div
				class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
				role="alert"
			>
				{error}
			</div>
		{/if}

		<!-- Upstream renders a bare (blank) grid when no department exists; the
		     porting contract §9 requires an explicit empty state, so this one is
		     additive rather than a verbatim copy. -->
		{#if !loading && !error && depts.length === 0}
			<div class="rounded-xl border border-line bg-surface-elevated p-8 text-center">
				<p class="mb-3 text-sm text-fg-muted">No departments yet.</p>
				<button
					type="button"
					onclick={() => void openAdd()}
					class="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500"
				>
					Add your first department →
				</button>
			</div>
		{/if}

		<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
			{#each depts as ds (ds.config.slug)}
				{@const cfg = ds.config}
				{@const atRisk = ds.goals.filter((g) => g.status === 'at_risk').length}
				{@const offTrack = ds.goals.filter((g) => g.status === 'off_track').length}
				{@const authCls =
					AUTHORITY_COLORS[cfg.authority_level] ?? 'bg-surface-input/40 text-fg border-line'}
				<a
					href={`/departments/${cfg.slug}`}
					class="group block rounded-xl border border-line bg-surface-elevated p-4 transition-colors hover:bg-surface-overlay"
				>
					<div class="mb-2 flex items-start justify-between gap-2">
						<div>
							<div
								class="text-sm font-semibold text-fg transition-colors group-hover:text-indigo-300"
							>
								{cfg.title}
							</div>
							<div class="mt-0.5 text-xs text-fg-muted">
								{cfg.charter.mission.slice(0, 80)}{cfg.charter.mission.length > 80 ? '…' : ''}
							</div>
						</div>
						<span
							class="inline-block shrink-0 rounded border px-2 py-0.5 text-[10px] font-medium {authCls}"
						>
							{AUTHORITY_LABELS[cfg.authority_level] ?? cfg.authority_level}
						</span>
					</div>

					<div class="mt-3 flex items-center gap-3 text-xs text-fg-muted">
						<span>{ds.goals.length} Goal{ds.goals.length !== 1 ? 's' : ''}</span>
						{#if atRisk > 0}{@render statusPill('at_risk')}{/if}
						{#if offTrack > 0}{@render statusPill('off_track')}{/if}
						{#if ds.goals.length > 0 && atRisk === 0 && offTrack === 0}
							{@render statusPill('on_track')}
						{/if}
					</div>
				</a>
			{/each}
		</div>
	</div>
</main>

<Dialog.Root open={addingDept} onOpenChange={(open) => !open && closeAdd()}>
	<Dialog.Content
		showCloseButton={false}
		aria-describedby={undefined}
		class="w-full gap-4 rounded-xl border border-line bg-surface-elevated ring-0"
	>
		<Dialog.Title class="text-sm font-semibold text-fg">New Department</Dialog.Title>
		<label class="flex flex-col gap-1 text-xs text-fg-muted">
			<span>Name <span class="text-rose-400">*</span></span>
			<input
				bind:this={titleEl}
				value={form.title}
				oninput={(e) => (form.title = e.currentTarget.value)}
				onkeydown={(e) => {
					if (e.key === 'Enter' && form.title.trim()) void handleCreate();
				}}
				class="rounded-lg border border-line bg-surface px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
				placeholder="Customer Success"
			/>
		</label>
		<label class="flex flex-col gap-1 text-xs text-fg-muted">
			<span>Mission <span class="text-fg-muted/60">(optional)</span></span>
			<textarea
				value={form.mission}
				oninput={(e) => (form.mission = e.currentTarget.value)}
				rows={3}
				class="resize-none rounded-lg border border-line bg-surface px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
				placeholder="What does this department own?"></textarea>
		</label>
		{#if err}<p class="text-xs text-rose-300" role="alert">{err}</p>{/if}
		<div class="flex gap-2">
			<button
				type="button"
				disabled={saving || !form.title.trim()}
				onclick={() => void handleCreate()}
				class="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
			>
				{saving ? 'Creating…' : 'Create'}
			</button>
			<button
				type="button"
				disabled={saving}
				onclick={closeAdd}
				class="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-surface-overlay disabled:opacity-50"
			>
				Cancel
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>

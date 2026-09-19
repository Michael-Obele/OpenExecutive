<script lang="ts">
	import { onMount } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import type { Engagement } from '$lib/api.js';
	import { createEngagement, listEngagements, reindexTalent } from '$lib/api.js';
	import { STATUS_META } from '$lib/components/talent/stages.js';

	let engagements = $state.raw<Engagement[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let showAdd = $state(false);
	let reindexMsg = $state<string | null>(null);

	// New-search form. Upstream mounted a fresh dialog per open, so the fields
	// (and the busy/error flags) are reset in `openAdd` instead.
	const BLANK_FORM = {
		role_title: '',
		department: '',
		location: '',
		comp_band: '',
		must_haves: '',
		description: ''
	};

	let form = $state({ ...BLANK_FORM });
	let saving = $state(false);
	let err = $state<string | null>(null);

	function openAdd() {
		form = { ...BLANK_FORM };
		saving = false;
		err = null;
		showAdd = true;
	}

	onMount(() => {
		void listEngagements()
			.then((e) => (engagements = e))
			.catch((e) => (error = e instanceof Error ? e.message : 'Failed to load'))
			.finally(() => (loading = false));
	});

	async function submit() {
		saving = true;
		err = null;
		try {
			const created = await createEngagement({
				role_title: form.role_title.trim(),
				department: form.department.trim(),
				location: form.location.trim(),
				comp_band: form.comp_band.trim(),
				must_haves: form.must_haves.trim(),
				description: form.description.trim()
			});
			engagements = [...engagements, created];
			showAdd = false;
		} catch (e) {
			err = e instanceof Error ? e.message : 'Failed to create';
			saving = false;
		}
	}

	// Repair action: rebuild the candidate match index from the database. Normal
	// create/edit/stage/archive already auto-index — this is only for when the
	// vector index drifts out of sync (e.g. it was wiped or an index write failed).
	async function handleReindex() {
		reindexMsg = 'Reindexing…';
		try {
			const { indexed } = await reindexTalent();
			reindexMsg = `Reindexed ${indexed} candidate(s).`;
		} catch (e) {
			reindexMsg = e instanceof Error ? e.message : 'Reindex failed';
		}
	}
</script>

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-4xl px-4 py-8 sm:px-6">
		<a href="/talent" class="text-xs text-fg-muted hover:text-fg">← Talent pipeline</a>

		<div class="mt-2 mb-6 flex items-baseline justify-between gap-4">
			<div>
				<h1 class="text-xl font-semibold text-fg">Searches</h1>
				<p class="mt-0.5 text-sm text-fg-muted">Open roles we're hiring for in this company.</p>
			</div>
			<div class="flex items-center gap-2">
				<button
					type="button"
					onclick={() => void handleReindex()}
					title="Rebuild the talent-match index from the database (repair tool)"
					class="rounded-lg border border-line px-3 py-2 text-sm text-fg hover:bg-surface-overlay"
				>
					Reindex
				</button>
				<button
					type="button"
					onclick={openAdd}
					class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
				>
					+ New search
				</button>
			</div>
		</div>

		{#if reindexMsg}
			<div class="mb-4 text-xs text-fg-muted" role="status">{reindexMsg}</div>
		{/if}
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
		{#if !loading && !error && engagements.length === 0}
			<div class="rounded-xl border border-line bg-surface-elevated p-8 text-center">
				<p class="mb-3 text-sm text-fg-muted">No searches yet.</p>
				<button
					type="button"
					onclick={openAdd}
					class="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500"
				>
					Open your first search →
				</button>
			</div>
		{/if}
		{#if !loading && !error && engagements.length > 0}
			<div class="space-y-2">
				{#each engagements as e (e.id)}
					{@const meta = STATUS_META[e.status]}
					<a
						href={`/talent/engagements/${e.id}`}
						class="group flex items-center justify-between rounded-xl border border-line bg-surface-elevated p-3 transition-colors hover:bg-surface-overlay"
					>
						<div>
							<div class="text-sm font-semibold text-fg group-hover:text-indigo-300">
								{e.role_title}
							</div>
							<div class="mt-0.5 text-xs text-fg-muted">
								{[e.department, e.location, e.comp_band].filter(Boolean).join(' · ') || '—'}
							</div>
						</div>
						<span
							class={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${meta.pill}`}
						>
							{meta.label}
						</span>
					</a>
				{/each}
			</div>
		{/if}
	</div>
</main>

<Dialog.Root open={showAdd} onOpenChange={(open) => (showAdd = open)}>
	<Dialog.Content
		showCloseButton={false}
		aria-describedby={undefined}
		class="w-full max-w-lg gap-0 rounded-2xl border border-line bg-surface p-6 shadow-2xl sm:max-w-lg"
	>
		<Dialog.Title class="mb-4 text-lg font-semibold text-fg">New search</Dialog.Title>
		<div class="space-y-3">
			<label class="block">
				<span class="text-xs text-fg-muted">Role title *</span>
				<input
					bind:value={form.role_title}
					class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
					placeholder="VP Drilling"
				/>
			</label>
			<div class="grid grid-cols-2 gap-3">
				<label class="block">
					<span class="text-xs text-fg-muted">Department</span>
					<input
						bind:value={form.department}
						class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
						placeholder="Drilling"
					/>
				</label>
				<label class="block">
					<span class="text-xs text-fg-muted">Location</span>
					<input
						bind:value={form.location}
						class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
						placeholder="Midland, TX"
					/>
				</label>
			</div>
			<label class="block">
				<span class="text-xs text-fg-muted">Comp band</span>
				<input
					bind:value={form.comp_band}
					class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
					placeholder="$300-350K + equity"
				/>
			</label>
			<label class="block">
				<span class="text-xs text-fg-muted">Must-haves</span>
				<textarea
					bind:value={form.must_haves}
					rows={3}
					class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
					placeholder="10+ yrs upstream, cycle-tested, HSE track record"></textarea>
			</label>
			<label class="block">
				<span class="text-xs text-fg-muted">Description</span>
				<textarea
					bind:value={form.description}
					rows={3}
					class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
				></textarea>
			</label>
		</div>
		{#if err}
			<p class="mt-3 text-xs text-rose-300" role="alert">{err}</p>
		{/if}
		<div class="mt-5 flex gap-2">
			<button
				type="button"
				disabled={saving || !form.role_title.trim()}
				onclick={() => void submit()}
				class="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
			>
				{saving ? 'Creating…' : 'Create search'}
			</button>
			<button
				type="button"
				disabled={saving}
				onclick={() => (showAdd = false)}
				class="rounded-lg border border-line px-4 py-2 text-sm hover:bg-surface-overlay disabled:opacity-50"
			>
				Cancel
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>

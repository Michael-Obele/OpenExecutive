<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import type { Candidate, CandidateMatch, Engagement, EngagementStatus } from '$lib/api.js';
	import {
		ENGAGEMENT_STATUSES,
		archiveEngagement,
		createCandidate,
		getEngagement,
		listCandidates,
		matchCandidatesForEngagement,
		updateEngagement
	} from '$lib/api.js';
	import CandidateCard from '$lib/components/talent/CandidateCard.svelte';
	import { STATUS_META, fitScoreColor } from '$lib/components/talent/stages.js';

	type AddField =
		| 'full_name'
		| 'current_title'
		| 'current_company'
		| 'location'
		| 'email'
		| 'linkedin_url'
		| 'source';

	const ADD_FIELDS: [AddField, string, string][] = [
		['full_name', 'Full name *', 'Dana Cole'],
		['current_title', 'Current title', 'Drilling Director'],
		['current_company', 'Current company', 'Permian Co'],
		['location', 'Location', 'Midland, TX'],
		['email', 'Email', 'dana@example.com'],
		['linkedin_url', 'LinkedIn URL', 'https://linkedin.com/in/…'],
		['source', 'Source', 'referral']
	];

	const BLANK_CANDIDATE: Record<AddField, string> = {
		full_name: '',
		current_title: '',
		current_company: '',
		location: '',
		email: '',
		linkedin_url: '',
		source: ''
	};

	let engagementId = $derived(page.params.id ? Number(page.params.id) : null);

	let engagement = $state.raw<Engagement | null>(null);
	let allCandidates = $state.raw<Candidate[]>([]);
	let matches = $state.raw<CandidateMatch[] | null>(null);
	let matchError = $state<string | null>(null);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let editing = $state(false);
	let saving = $state(false);
	let showAddCandidate = $state(false);

	let editForm = $state<{
		role_title: string;
		department: string;
		status: EngagementStatus;
		location: string;
		comp_band: string;
		must_haves: string;
		description: string;
	}>({
		role_title: '',
		department: '',
		status: 'open',
		location: '',
		comp_band: '',
		must_haves: '',
		description: ''
	});

	// Add-candidate form. Upstream mounted a fresh dialog per open, so the fields
	// (and the busy/error flags) are reset in `openAddCandidate` instead.
	let addForm = $state<Record<AddField, string>>({ ...BLANK_CANDIDATE });
	let adding = $state(false);
	let addErr = $state<string | null>(null);

	let nameById = $derived(new Map(allCandidates.map((c) => [c.id, c])));
	let engagementCandidates = $derived(
		allCandidates.filter((c) => c.engagement_id === engagementId)
	);

	function load() {
		if (engagementId == null) return;
		void getEngagement(engagementId)
			.then(async (e) => {
				engagement = e;
				editForm = {
					role_title: e.role_title,
					department: e.department,
					status: e.status,
					location: e.location,
					comp_band: e.comp_band,
					must_haves: e.must_haves,
					description: e.description
				};
				allCandidates = await listCandidates();
			})
			.catch((err) => (error = err instanceof Error ? err.message : 'Failed to load'))
			.finally(() => (loading = false));
	}

	// Upstream fetched in a useEffect keyed on `engagementId`. Navigating between
	// engagements reuses this component (same route), so the first load has to be
	// re-triggered per navigation — `afterNavigate` runs on mount *and* on every
	// later navigation, and `load()` no-ops once the param is gone.
	afterNavigate(() => {
		load();
	});

	function openAddCandidate() {
		addForm = { ...BLANK_CANDIDATE };
		adding = false;
		addErr = null;
		showAddCandidate = true;
	}

	async function submitCandidate() {
		if (engagementId == null) return;
		adding = true;
		addErr = null;
		try {
			const created = await createCandidate({
				engagement_id: engagementId,
				full_name: addForm.full_name.trim(),
				current_title: addForm.current_title.trim(),
				current_company: addForm.current_company.trim(),
				location: addForm.location.trim(),
				email: addForm.email.trim() || null,
				linkedin_url: addForm.linkedin_url.trim() || null,
				source: addForm.source.trim()
			});
			allCandidates = [...allCandidates, created];
			showAddCandidate = false;
		} catch (e) {
			addErr = e instanceof Error ? e.message : 'Failed to create';
			adding = false;
		}
	}

	async function saveEdits() {
		if (engagementId == null) return;
		saving = true;
		try {
			const updated = await updateEngagement(engagementId, editForm);
			engagement = updated;
			editing = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save';
		} finally {
			saving = false;
		}
	}

	async function handleArchive() {
		if (engagementId == null || !engagement) return;
		try {
			await archiveEngagement(engagementId);
			await goto('/talent/searches');
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to archive';
		}
	}

	async function loadMatches() {
		if (engagementId == null) return;
		matchError = null;
		try {
			matches = await matchCandidatesForEngagement(engagementId);
		} catch (e) {
			matchError = e instanceof Error ? e.message : 'Failed to load matches';
		}
	}
</script>

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-4xl px-4 py-8 sm:px-6">
		{#if loading}
			<p class="text-sm text-fg-muted" role="status">Loading…</p>
		{:else if error}
			<div
				class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
				role="alert"
			>
				{error}
			</div>
		{:else if !engagement}
			<p class="text-sm text-fg-muted">Engagement not found.</p>
		{:else}
			{@const current = engagement}

			{@const statusMeta = STATUS_META[current.status]}

			<a href="/talent/searches" class="text-xs text-fg-muted hover:text-fg">← Searches</a>

			<div class="mt-2 mb-6 flex items-start justify-between gap-4">
				<div class="min-w-0">
					<h1 class="flex items-center gap-2 text-xl font-semibold text-fg">
						{current.role_title}
						<span
							class={`inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium ${statusMeta.pill}`}
						>
							{statusMeta.label}
						</span>
					</h1>
					<p class="mt-0.5 text-sm text-fg-muted">
						{[current.department, current.location, current.comp_band]
							.filter(Boolean)
							.join(' · ') || '—'}
					</p>
				</div>
				<div class="flex shrink-0 gap-2">
					<button
						type="button"
						onclick={() => (editing = !editing)}
						class="rounded-lg border border-line px-3 py-2 text-sm text-fg hover:bg-surface-overlay"
					>
						{editing ? 'Cancel' : 'Edit'}
					</button>
					<button
						type="button"
						onclick={() => void handleArchive()}
						class="rounded-lg border border-rose-500/40 px-3 py-2 text-sm text-rose-300 hover:bg-rose-500/10"
					>
						Archive
					</button>
				</div>
			</div>

			{#if editing}
				<div class="mb-6 space-y-3 rounded-xl border border-line bg-surface-elevated p-4">
					<div class="grid grid-cols-2 gap-3">
						<label class="block">
							<span class="text-xs text-fg-muted">Role title</span>
							<input
								bind:value={editForm.role_title}
								class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
							/>
						</label>
						<label class="block">
							<span class="text-xs text-fg-muted">Department</span>
							<input
								bind:value={editForm.department}
								class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
							/>
						</label>
					</div>
					<div class="grid grid-cols-3 gap-3">
						<label class="block">
							<span class="text-xs text-fg-muted">Status</span>
							<select
								value={editForm.status}
								onchange={(e) => (editForm.status = e.currentTarget.value as EngagementStatus)}
								class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
							>
								{#each ENGAGEMENT_STATUSES as s (s)}
									<option value={s}>{s}</option>
								{/each}
							</select>
						</label>
						<label class="block">
							<span class="text-xs text-fg-muted">Location</span>
							<input
								bind:value={editForm.location}
								class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
							/>
						</label>
						<label class="block">
							<span class="text-xs text-fg-muted">Comp band</span>
							<input
								bind:value={editForm.comp_band}
								class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
							/>
						</label>
					</div>
					<label class="block">
						<span class="text-xs text-fg-muted">Must-haves</span>
						<textarea
							bind:value={editForm.must_haves}
							rows={3}
							class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
						></textarea>
					</label>
					<label class="block">
						<span class="text-xs text-fg-muted">Description</span>
						<textarea
							bind:value={editForm.description}
							rows={3}
							class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
						></textarea>
					</label>
					<button
						type="button"
						disabled={saving}
						onclick={() => void saveEdits()}
						class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
					>
						{saving ? 'Saving…' : 'Save'}
					</button>
				</div>
			{/if}

			{#if current.must_haves && !editing}
				<div class="mb-6">
					<div class="mb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">
						Must-haves
					</div>
					<p class="text-sm whitespace-pre-wrap text-fg-muted">{current.must_haves}</p>
				</div>
			{/if}

			<!-- Candidates -->
			<div class="mb-3 flex items-center justify-between">
				<h2 class="text-sm font-semibold text-fg">
					Candidates ({engagementCandidates.length})
				</h2>
				<button
					type="button"
					onclick={openAddCandidate}
					class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
				>
					+ Add candidate
				</button>
			</div>
			{#if engagementCandidates.length === 0}
				<p class="mb-6 text-sm text-fg-subtle">No candidates yet.</p>
			{:else}
				<div class="mb-6 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
					{#each engagementCandidates as c (c.id)}
						<CandidateCard candidate={c} />
					{/each}
				</div>
			{/if}

			<!-- Talent-graph matches -->
			<div class="mb-3 flex items-center justify-between border-t border-line pt-6">
				<div>
					<h2 class="text-sm font-semibold text-fg">Suggested matches</h2>
					<p class="mt-0.5 text-xs text-fg-muted">
						Best-fit candidates across the whole pool, ranked against this role.
					</p>
				</div>
				<button
					type="button"
					onclick={() => void loadMatches()}
					class="rounded-lg border border-line px-3 py-1.5 text-xs text-fg hover:bg-surface-overlay"
				>
					{matches ? 'Refresh' : 'Find matches'}
				</button>
			</div>
			{#if matchError}
				<p class="text-sm text-rose-300" role="alert">{matchError}</p>
			{/if}
			{#if matches && matches.length === 0}
				<p class="text-sm text-fg-subtle">No matches found (try Reindex on the pipeline).</p>
			{/if}
			{#if matches && matches.length > 0}
				<div class="space-y-2">
					{#each matches as m (m.candidate_id)}
						{@const cand = nameById.get(m.candidate_id)}
						<a
							href={`/talent/candidates/${m.candidate_id}`}
							class="group flex items-center justify-between rounded-xl border border-line bg-surface-elevated p-3 transition-colors hover:bg-surface-overlay"
						>
							<div class="min-w-0">
								<div class="truncate text-sm font-semibold text-fg group-hover:text-indigo-300">
									{cand ? cand.full_name : `Candidate #${m.candidate_id}`}
								</div>
								<div class="truncate text-xs text-fg-muted">
									{cand?.current_title || m.stage}
								</div>
							</div>
							<div
								class={`text-sm font-semibold tabular-nums ${fitScoreColor(
									Math.round(m.score * 100)
								)}`}
								title="Match score"
							>
								{Math.round(m.score * 100)}%
							</div>
						</a>
					{/each}
				</div>
			{/if}
		{/if}
	</div>
</main>

<Dialog.Root open={showAddCandidate} onOpenChange={(open) => (showAddCandidate = open)}>
	<Dialog.Content
		showCloseButton={false}
		aria-describedby={undefined}
		class="w-full max-w-lg gap-0 rounded-2xl border border-line bg-surface p-6 shadow-2xl sm:max-w-lg"
	>
		<Dialog.Title class="mb-4 text-lg font-semibold text-fg">Add candidate</Dialog.Title>
		<div class="space-y-3">
			{#each ADD_FIELDS as [key, label, placeholder] (key)}
				<label class="block">
					<span class="text-xs text-fg-muted">{label}</span>
					<input
						bind:value={addForm[key]}
						class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
						{placeholder}
					/>
				</label>
			{/each}
		</div>
		{#if addErr}
			<p class="mt-3 text-xs text-rose-300" role="alert">{addErr}</p>
		{/if}
		<div class="mt-5 flex gap-2">
			<button
				type="button"
				disabled={adding || !addForm.full_name.trim()}
				onclick={() => void submitCandidate()}
				class="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
			>
				{adding ? 'Adding…' : 'Add candidate'}
			</button>
			<button
				type="button"
				disabled={adding}
				onclick={() => (showAddCandidate = false)}
				class="rounded-lg border border-line px-4 py-2 text-sm hover:bg-surface-overlay disabled:opacity-50"
			>
				Cancel
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>

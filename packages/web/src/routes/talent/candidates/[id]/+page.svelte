<script lang="ts">
	import { afterNavigate, goto } from '$app/navigation';
	import { page } from '$app/state';
	import type { Candidate, CandidateMatch, CandidateStage } from '$lib/api.js';
	import {
		CANDIDATE_STAGES,
		archiveCandidate,
		getCandidate,
		listCandidates,
		setCandidateStage,
		similarCandidates,
		updateCandidate
	} from '$lib/api.js';
	import OfferPanel from '$lib/components/talent/OfferPanel.svelte';
	import StageBadge from '$lib/components/talent/StageBadge.svelte';
	import { STAGE_META, fitScoreColor } from '$lib/components/talent/stages.js';
	import { workflowLink } from '$lib/components/talent/workflowLink.js';

	const EDIT_FIELDS: [keyof Candidate, string][] = [
		['full_name', 'Full name'],
		['current_title', 'Current title'],
		['current_company', 'Current company'],
		['location', 'Location'],
		['email', 'Email'],
		['linkedin_url', 'LinkedIn URL'],
		['source', 'Source'],
		['notes', 'Notes']
	];

	let candidateId = $derived(page.params.id ? Number(page.params.id) : null);

	let candidate = $state.raw<Candidate | null>(null);
	let similar = $state.raw<CandidateMatch[]>([]);
	let allCandidates = $state.raw<Candidate[]>([]);
	let error = $state<string | null>(null);
	let loading = $state(true);
	let editing = $state(false);
	let editForm = $state<Record<string, string>>({});
	let saving = $state(false);
	let stageBusy = $state(false);

	let nameById = $derived(new Map(allCandidates.map((c) => [c.id, c])));
	let subtitle = $derived(
		candidate
			? [candidate.current_title, candidate.current_company].filter(Boolean).join(' · ')
			: ''
	);

	function load() {
		if (candidateId == null) return;
		void getCandidate(candidateId)
			.then((c) => {
				candidate = c;
				editForm = {
					full_name: c.full_name,
					current_title: c.current_title,
					current_company: c.current_company,
					location: c.location,
					email: c.email ?? '',
					linkedin_url: c.linkedin_url ?? '',
					source: c.source,
					notes: c.notes
				};
			})
			.catch((e) => (error = e instanceof Error ? e.message : 'Failed to load'))
			.finally(() => (loading = false));
		void similarCandidates(candidateId)
			.then((s) => (similar = s))
			.catch(() => (similar = []));
		void listCandidates()
			.then((all) => (allCandidates = all))
			.catch(() => (allCandidates = []));
	}

	// Upstream fetched in a useEffect keyed on `candidateId`. Navigating between
	// candidates reuses this component (same route), so the first load has to be
	// re-triggered per navigation — `afterNavigate` runs on mount *and* on every
	// later navigation, and `load()` no-ops once the param is gone.
	afterNavigate(() => {
		load();
	});

	let workflowActions = $derived.by(() => {
		if (!candidate) return [];
		const cid = String(candidate.id);
		const eid = String(candidate.engagement_id);
		return [
			{
				label: 'Screen',
				href: workflowLink('candidate_screen', { engagement_id: eid, candidate_id: cid })
			},
			{ label: 'Outreach', href: workflowLink('candidate_outreach', { candidate_id: cid }) },
			{ label: 'Interviews', href: workflowLink('interview_coordination', { candidate_id: cid }) },
			{ label: 'References', href: workflowLink('reference_check', { candidate_id: cid }) },
			{ label: 'Offer', href: workflowLink('offer_approval', { candidate_id: cid }) },
			{ label: 'Onboarding', href: workflowLink('new_hire_onboarding', { candidate_id: cid }) }
		];
	});

	async function saveEdits() {
		if (candidateId == null) return;
		saving = true;
		try {
			const updated = await updateCandidate(candidateId, {
				full_name: editForm.full_name,
				current_title: editForm.current_title,
				current_company: editForm.current_company,
				location: editForm.location,
				email: editForm.email || null,
				linkedin_url: editForm.linkedin_url || null,
				source: editForm.source,
				notes: editForm.notes
			});
			candidate = updated;
			editing = false;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to save';
		} finally {
			saving = false;
		}
	}

	async function moveStage(stage: CandidateStage) {
		if (candidateId == null || !candidate || candidate.stage === stage) return;
		stageBusy = true;
		try {
			candidate = await setCandidateStage(candidateId, stage);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to move stage';
		} finally {
			stageBusy = false;
		}
	}

	async function handleArchive() {
		if (candidateId == null || !candidate) return;
		try {
			const engagementId = candidate.engagement_id;
			await archiveCandidate(candidateId);
			await goto(`/talent/engagements/${engagementId}`);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to archive';
		}
	}
</script>

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-4xl px-4 py-8 sm:px-6">
		{#if loading}
			<p class="text-sm text-fg-muted" role="status">Loading…</p>
		{:else if error && !candidate}
			<div
				class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
				role="alert"
			>
				{error}
			</div>
		{:else if !candidate}
			<p class="text-sm text-fg-muted">Candidate not found.</p>
		{:else}
			{@const current = candidate}

			<a
				href={`/talent/engagements/${current.engagement_id}`}
				class="text-xs text-fg-muted hover:text-fg"
			>
				← Engagement
			</a>

			<div class="mt-2 mb-6 flex items-start justify-between gap-4">
				<div class="min-w-0">
					<h1 class="flex items-center gap-2 text-xl font-semibold text-fg">
						{current.full_name}
						<StageBadge stage={current.stage} />
					</h1>
					{#if subtitle}
						<p class="mt-0.5 text-sm text-fg-muted">{subtitle}</p>
					{/if}
				</div>
				<div class="flex shrink-0 items-center gap-3">
					<div class="text-right">
						<div class={`text-2xl font-bold tabular-nums ${fitScoreColor(current.fit_score)}`}>
							{current.fit_score ?? '—'}
						</div>
						<div class="text-[10px] text-fg-subtle uppercase">Fit score</div>
					</div>
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

			{#if error}
				<div
					class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
					role="alert"
				>
					{error}
				</div>
			{/if}

			<!-- Stage control -->
			<div class="mb-6">
				<div class="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
					Pipeline stage
				</div>
				<div class="flex flex-wrap gap-2">
					{#each CANDIDATE_STAGES as stage (stage)}
						{@const active = current.stage === stage}
						<button
							type="button"
							disabled={stageBusy || active}
							onclick={() => void moveStage(stage)}
							class={`rounded-lg border px-3 py-1.5 text-xs font-medium transition-colors disabled:opacity-100 ${
								active
									? 'border-indigo-500/50 bg-indigo-600/30 text-indigo-200'
									: 'border-line bg-surface-input text-fg-muted hover:border-indigo-500/40 disabled:opacity-50'
							}`}
						>
							{STAGE_META[stage].label}
						</button>
					{/each}
				</div>
			</div>

			<!-- Offer lifecycle. Keyed so switching candidate remounts the panel and
			     it refetches that candidate's offers. -->
			{#key current.id}
				<OfferPanel candidate={current} onChanged={load} />
			{/key}

			<!-- Run workflows -->
			<div class="mb-6">
				<div class="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
					Run a workflow
				</div>
				<div class="flex flex-wrap gap-2">
					{#each workflowActions as a (a.label)}
						<a
							href={a.href}
							class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
						>
							{a.label}
						</a>
					{/each}
				</div>
			</div>

			{#if editing}
				<div class="mb-6 space-y-3 rounded-xl border border-line bg-surface-elevated p-4">
					{#each EDIT_FIELDS as [key, label] (key)}
						<label class="block">
							<span class="text-xs text-fg-muted">{label}</span>
							{#if key === 'notes'}
								<textarea
									bind:value={editForm[key]}
									rows={3}
									class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
								></textarea>
							{:else}
								<input
									bind:value={editForm[key]}
									class="mt-1 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
								/>
							{/if}
						</label>
					{/each}
					<button
						type="button"
						disabled={saving || !editForm.full_name?.trim()}
						onclick={() => void saveEdits()}
						class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
					>
						{saving ? 'Saving…' : 'Save'}
					</button>
				</div>
			{/if}

			<!-- Screening summary -->
			{#if current.screening_summary}
				<div class="mb-6">
					<div class="mb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">
						Screening summary
					</div>
					<p class="text-sm whitespace-pre-wrap text-fg-muted">{current.screening_summary}</p>
				</div>
			{/if}

			{#if current.notes && !editing}
				<div class="mb-6">
					<div class="mb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">Notes</div>
					<p class="text-sm whitespace-pre-wrap text-fg-muted">{current.notes}</p>
				</div>
			{/if}

			<!-- Similar candidates -->
			<div class="border-t border-line pt-6">
				<div class="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
					Similar candidates
				</div>
				{#if similar.length === 0}
					<p class="text-sm text-fg-subtle">No similar candidates indexed yet.</p>
				{:else}
					<div class="space-y-2">
						{#each similar as m (m.candidate_id)}
							{@const cand = nameById.get(m.candidate_id)}
							<a
								href={`/talent/candidates/${m.candidate_id}`}
								class="group flex items-center justify-between rounded-xl border border-line bg-surface-elevated p-3 transition-colors hover:bg-surface-overlay"
							>
								<span class="truncate text-sm text-fg group-hover:text-indigo-300">
									{cand ? cand.full_name : `Candidate #${m.candidate_id}`}
								</span>
								<span
									class={`text-sm font-semibold tabular-nums ${fitScoreColor(Math.round(m.score * 100))}`}
								>
									{Math.round(m.score * 100)}%
								</span>
							</a>
						{/each}
					</div>
				{/if}
			</div>
		{/if}
	</div>
</main>

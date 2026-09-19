<script lang="ts">
	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import type { OnboardingPlan, OnboardingTask } from '$lib/api.js';
	import {
		activateOnboardingPlan,
		advanceOnboardingPlan,
		getOnboardingPlan,
		setOnboardingTaskStatus
	} from '$lib/api.js';
	import Markdown from '$lib/components/Markdown.svelte';
	import { PHASE_LABEL, PHASE_ORDER, STATUS_META } from '$lib/components/onboarding/meta.js';

	let planId = $derived(page.params.id ? Number(page.params.id) : NaN);

	let plan = $state.raw<OnboardingPlan | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let busy = $state(false);

	function load() {
		if (Number.isNaN(planId)) return;
		loading = true;
		getOnboardingPlan(planId)
			.then((p) => (plan = p))
			.catch((err) => (error = err instanceof Error ? err.message : 'Failed to load'))
			.finally(() => (loading = false));
	}

	// Upstream re-fetched in a `useEffect` keyed on `planId`. Navigating between
	// plans reuses this component (same route), so the first load has to be
	// re-triggered per navigation — `afterNavigate` runs on mount *and* on every
	// later navigation, and `load()` no-ops once the param is gone.
	afterNavigate(() => {
		load();
	});

	async function runAction(fn: () => Promise<unknown>) {
		busy = true;
		error = null;
		try {
			await fn();
			load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Action failed';
		} finally {
			busy = false;
		}
	}

	async function toggleTask(task: OnboardingTask) {
		if (task.id == null) return;
		const next = task.status === 'done' ? 'pending' : 'done';
		await runAction(() => setOnboardingTaskStatus(task.id as number, next));
	}

	let tasksByPhase = $derived(
		PHASE_ORDER.map((phase) => ({
			phase,
			tasks: plan ? plan.tasks.filter((t) => t.phase === phase) : []
		})).filter((g) => g.tasks.length > 0)
	);
</script>

<main class="min-h-0 flex-1 overflow-y-auto">
	{#if loading}
		<div class="p-6 text-sm text-fg-muted" role="status">Loading…</div>
	{:else if error && !plan}
		<div class="p-6">
			<a href="/staff-onboarding" class="text-sm text-indigo-300 hover:text-indigo-200">← Back</a>
			<p class="mt-4 text-sm text-rose-300" role="alert">{error}</p>
		</div>
	{:else if plan}
		{@const current = plan}
		{@const meta = STATUS_META[current.status] ?? STATUS_META.draft}
		<div class="mx-auto max-w-4xl px-4 py-8 sm:px-6">
			<a href="/staff-onboarding" class="text-sm text-indigo-300 hover:text-indigo-200">
				← All plans
			</a>

			<div class="mt-3 flex flex-wrap items-start justify-between gap-4">
				<div>
					<h1 class="text-xl font-semibold text-fg">
						{current.full_name}{#if current.role}<span class="text-fg-muted"
								>{` — ${current.role}`}</span
							>{/if}
					</h1>
					<div class="mt-1 flex items-center gap-2 text-sm">
						<span class={`rounded-full border px-2 py-0.5 text-[11px] ${meta.cls}`}>
							{meta.label}
						</span>
						<span class="text-fg-subtle">
							{PHASE_LABEL[current.current_phase] ?? current.current_phase}
						</span>
						<span class="text-fg-subtle">· starts {current.start_date}</span>
						<span class="text-fg-subtle">· {current.completion_pct}% complete</span>
					</div>
				</div>
				<div class="flex items-center gap-2">
					{#if current.status === 'draft'}
						<button
							type="button"
							onclick={() => void runAction(() => activateOnboardingPlan(planId))}
							disabled={busy}
							class="rounded-lg bg-emerald-600 px-3 py-1.5 text-sm text-white hover:bg-emerald-500 disabled:opacity-50"
						>
							Activate
						</button>
					{/if}
					<button
						type="button"
						onclick={() => void runAction(() => advanceOnboardingPlan(planId))}
						disabled={busy}
						class="rounded-lg border border-line bg-surface-input px-3 py-1.5 text-sm hover:border-indigo-500 disabled:opacity-50"
					>
						Advance phase
					</button>
				</div>
			</div>

			{#if error}
				<div
					class="mt-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
					role="alert"
				>
					{error}
				</div>
			{/if}

			<!-- Tasks -->
			<section class="mt-6">
				<h2 class="mb-3 text-sm font-semibold tracking-wide text-fg-muted uppercase">Checklist</h2>
				{#if tasksByPhase.length === 0}
					<p class="text-sm text-fg-subtle">No tasks on this plan.</p>
				{/if}
				<div class="space-y-4">
					{#each tasksByPhase as group (group.phase)}
						<div>
							<div class="mb-1.5 text-[11px] font-semibold tracking-wide text-fg-subtle uppercase">
								{PHASE_LABEL[group.phase]}
							</div>
							<div class="space-y-1.5">
								{#each group.tasks as t (t.id)}
									<label
										class="flex cursor-pointer items-center gap-3 rounded-lg border border-line bg-surface-elevated px-3 py-2"
									>
										<input
											type="checkbox"
											checked={t.status === 'done'}
											onchange={() => void toggleTask(t)}
											disabled={busy || t.status === 'skipped'}
											class="accent-emerald-500"
										/>
										<span
											class={`flex-1 text-sm ${
												t.status === 'done' ? 'text-fg-subtle line-through' : 'text-fg'
											}`}
										>
											{t.title}
										</span>
										{#if t.due_date}
											<span class="text-[11px] text-fg-subtle tabular-nums">due {t.due_date}</span>
										{/if}
										{#if t.status === 'skipped'}
											<span class="text-[11px] text-fg-subtle">skipped</span>
										{/if}
									</label>
								{/each}
							</div>
						</div>
					{/each}
				</div>
			</section>

			<!-- Reading list -->
			{#if current.reading_list.length > 0}
				<section class="mt-6">
					<h2 class="mb-2 text-sm font-semibold tracking-wide text-fg-muted uppercase">
						Suggested reading
					</h2>
					<ul class="list-inside list-disc space-y-0.5 text-sm text-fg-muted">
						{#each current.reading_list as r, i (i)}
							<li>{r}</li>
						{/each}
					</ul>
				</section>
			{/if}

			<!-- Ramp -->
			{#if current.ramp_segments.length > 0}
				<section class="mt-6">
					<h2 class="mb-2 text-sm font-semibold tracking-wide text-fg-muted uppercase">
						Ramp drip
					</h2>
					<p class="text-sm text-fg-muted">
						{current.ramp_segments.length} daily message{current.ramp_segments.length === 1
							? ''
							: 's'} · {current.ramp_next_index} sent
					</p>
				</section>
			{/if}

			<!-- Welcome brief -->
			<section class="mt-6">
				<h2 class="mb-2 text-sm font-semibold tracking-wide text-fg-muted uppercase">
					Welcome brief
				</h2>
				{#if current.brief_artifact}
					<Markdown
						source={current.brief_artifact}
						class="prose-sm rounded-lg border border-line bg-surface/40 p-6 prose-invert prose-headings:font-semibold prose-headings:text-fg prose-p:leading-relaxed prose-p:text-fg prose-strong:text-fg prose-li:text-fg"
					/>
				{:else}
					<p class="text-sm text-fg-subtle">
						No brief generated yet — ask the Executive to “start onboarding for {current.full_name}”
						in chat to generate the role-tailored welcome brief.
					</p>
				{/if}
			</section>
		</div>
	{/if}
</main>

<script lang="ts">
	import { onMount } from 'svelte';
	import type { OnboardingPlan, OnboardingTemplate } from '$lib/api.js';
	import { createOnboardingPlan, listOnboardingPlans, listOnboardingTemplates } from '$lib/api.js';
	import { PHASE_LABEL, STATUS_META, STATUS_ORDER } from '$lib/components/onboarding/meta.js';

	let plans = $state.raw<OnboardingPlan[]>([]);
	let templates = $state.raw<OnboardingTemplate[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let showCreate = $state(false);
	let saving = $state(false);

	// Create-plan form. Upstream held these as separate `useState` fields and
	// cleared them by hand after a successful create — same here.
	let fullName = $state('');
	let startDate = $state('');
	let role = $state('');
	let templateName = $state('');

	// Upstream memoised this sort over `plans`: active plans first, then the
	// least-complete within a status group.
	let sorted = $derived(
		[...plans].sort(
			(a, b) =>
				(STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) ||
				a.completion_pct - b.completion_pct
		)
	);

	function load() {
		loading = true;
		Promise.all([listOnboardingPlans(), listOnboardingTemplates()])
			.then(([p, t]) => {
				plans = p;
				templates = t;
			})
			.catch((err) => (error = err instanceof Error ? err.message : 'Failed to load'))
			.finally(() => (loading = false));
	}

	onMount(() => {
		load();
	});

	async function handleCreate(e: SubmitEvent) {
		e.preventDefault();
		if (!fullName.trim() || !startDate) return;
		saving = true;
		error = null;
		try {
			await createOnboardingPlan({
				full_name: fullName.trim(),
				start_date: startDate,
				role: role.trim() || undefined,
				template_name: templateName || undefined
			});
			fullName = '';
			startDate = '';
			role = '';
			templateName = '';
			showCreate = false;
			load();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to create plan';
		} finally {
			saving = false;
		}
	}
</script>

{#snippet progressBar(pct: number)}
	<div class="h-1.5 w-full overflow-hidden rounded-full bg-surface-input">
		<div
			class="h-full rounded-full bg-emerald-500/70"
			style={`width: ${Math.max(0, Math.min(100, pct))}%`}
		></div>
	</div>
{/snippet}

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-5xl px-4 py-8 sm:px-6">
		<div class="mb-6 flex flex-wrap items-baseline justify-between gap-4">
			<div>
				<h1 class="text-xl font-semibold text-fg">Staff Onboarding</h1>
				<p class="mt-0.5 text-sm text-fg-muted">
					Onboarding plans for new hires — progress, tasks, and the generated welcome brief.
				</p>
			</div>
			<button
				type="button"
				onclick={() => (showCreate = !showCreate)}
				class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
			>
				{showCreate ? 'Cancel' : 'New plan'}
			</button>
		</div>

		{#if showCreate}
			<form
				onsubmit={handleCreate}
				class="mb-6 grid gap-3 rounded-xl border border-line bg-surface-elevated p-4 sm:grid-cols-2"
			>
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-fg-muted">Full name *</span>
					<input
						bind:value={fullName}
						required
						class="rounded-lg border border-line bg-surface-input px-3 py-2 focus:border-indigo-500 focus:outline-none"
					/>
				</label>
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-fg-muted">Start date *</span>
					<input
						type="date"
						bind:value={startDate}
						required
						class="rounded-lg border border-line bg-surface-input px-3 py-2 focus:border-indigo-500 focus:outline-none"
					/>
				</label>
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-fg-muted">Role</span>
					<input
						bind:value={role}
						placeholder="e.g. Fractional CFO"
						class="rounded-lg border border-line bg-surface-input px-3 py-2 focus:border-indigo-500 focus:outline-none"
					/>
				</label>
				<label class="flex flex-col gap-1 text-sm">
					<span class="text-fg-muted">Template</span>
					<select
						bind:value={templateName}
						class="rounded-lg border border-line bg-surface-input px-3 py-2 focus:border-indigo-500 focus:outline-none"
					>
						<option value="">No template (blank plan)</option>
						{#each templates as t (t.name)}
							<option value={t.name}>{t.title}</option>
						{/each}
					</select>
				</label>
				<div class="flex justify-end sm:col-span-2">
					<button
						type="submit"
						disabled={saving || !fullName.trim() || !startDate}
						class="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
					>
						{saving ? 'Creating…' : 'Create plan'}
					</button>
				</div>
			</form>
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
		{#if !loading && !error && plans.length === 0}
			<div class="rounded-xl border border-line bg-surface-elevated p-8 text-center">
				<p class="text-sm text-fg-muted">
					No onboarding plans yet. Create one above, or ask the Executive to onboard a new hire in
					chat.
				</p>
			</div>
		{/if}

		<div class="space-y-3">
			{#each sorted as plan (plan.id)}
				{@const meta = STATUS_META[plan.status] ?? STATUS_META.draft}
				<a
					href={`/staff-onboarding/${plan.id}`}
					class="block rounded-xl border border-line bg-surface-elevated p-4 transition-colors hover:border-indigo-500/50"
				>
					<div class="mb-2 flex flex-wrap items-center justify-between gap-3">
						<div class="min-w-0">
							<span class="font-medium text-fg">{plan.full_name}</span>{#if plan.role}<span
									class="text-sm text-fg-muted">{` — ${plan.role}`}</span
								>{/if}
						</div>
						<div class="flex items-center gap-2">
							<span class={`rounded-full border px-2 py-0.5 text-[11px] ${meta.cls}`}>
								{meta.label}
							</span>
							<span class="text-[11px] text-fg-subtle">
								{PHASE_LABEL[plan.current_phase] ?? plan.current_phase}
							</span>
						</div>
					</div>
					<div class="flex items-center gap-3">
						{@render progressBar(plan.completion_pct)}
						<span class="w-10 text-right text-xs text-fg-subtle tabular-nums">
							{plan.completion_pct}%
						</span>
					</div>
					<div class="mt-1.5 text-[11px] text-fg-subtle">Starts {plan.start_date}</div>
				</a>
			{/each}
		</div>
	</div>
</main>

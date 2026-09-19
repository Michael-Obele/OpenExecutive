<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import type { PageProps } from './$types';
	import AddGoalForm from '$lib/components/departments/AddGoalForm.svelte';
	import GoalRow from '$lib/components/departments/GoalRow.svelte';
	import { AUTHORITY_META, AUTHORITY_OPTS, cls } from '$lib/components/departments/shared.js';
	import {
		deleteDepartment,
		getDepartment,
		listPeople,
		updateDepartment,
		type DepartmentConfig,
		type DepartmentState,
		type Goal,
		type Person
	} from '$lib/api.js';

	let { params }: PageProps = $props();

	// SvelteKit decodes dynamic params before exposing them here. `$derived`
	// keeps this tracking the live route param rather than freezing the first
	// value (which is what trips svelte's state_referenced_locally warning).
	const slug = $derived(params.slug);

	// Auto-refresh cadence for the detail page. The `dept_cadence` scheduler
	// fires at most once per department per cadence (default daily), so any
	// poll faster than ~30s is overkill for review-driven status changes
	// but keeps the page feeling live for cross-tab edits.
	const POLL_INTERVAL_MS = 30_000;

	// Textarea placeholder — a real newline can only be expressed as a JS
	// string, so it lives as a constant rather than a mustache literal.
	const WATCHED_ENTITIES_PLACEHOLDER = 'Brex\nStripe\nACME';

	interface SettingsForm {
		authority_level: DepartmentConfig['authority_level'];
		mission: string;
		cadences: Record<string, string>;
		headcount: string;
		budget_usd: string;
		head_person_id: number | null;
		slack_channel_id: string;
		discord_channel_id: string;
		telegram_chat_id: string;
		// One entity per line in the textarea; split + trimmed on save.
		watched_entities: string;
	}

	const BLANK_SETTINGS: SettingsForm = {
		authority_level: 'propose_only',
		mission: '',
		cadences: {},
		headcount: '',
		budget_usd: '',
		head_person_id: null,
		slack_channel_id: '',
		discord_channel_id: '',
		telegram_chat_id: '',
		watched_entities: ''
	};

	function settingsFormFrom(d: DepartmentState): SettingsForm {
		return {
			authority_level: d.config.authority_level,
			mission: d.config.charter.mission,
			cadences: { ...d.config.cadences },
			headcount: d.headcount != null ? String(d.headcount) : '',
			budget_usd: d.budget_usd != null ? String(d.budget_usd) : '',
			head_person_id: d.config.head_person_id,
			slack_channel_id: d.config.slack_channel_id ?? '',
			discord_channel_id: d.config.discord_channel_id ?? '',
			telegram_chat_id: d.config.telegram_chat_id ?? '',
			watched_entities: (d.config.watched_entities ?? []).join('\n')
		};
	}

	function summaryRowsFor(d: DepartmentState, roster: Person[]): Array<[string, string]> {
		const rows: Array<[string, string]> = [['Mission', d.config.charter.mission || '—']];
		if (d.config.head_person_id != null) {
			rows.push([
				'Head',
				roster.find((p) => p.id === d.config.head_person_id)?.full_name ??
					`Person #${d.config.head_person_id}`
			]);
		}
		if (d.headcount != null) rows.push(['Headcount', String(d.headcount)]);
		if (d.budget_usd != null) rows.push(['Budget', `$${d.budget_usd.toLocaleString()}`]);
		if (d.config.slack_channel_id) rows.push(['Slack channel', d.config.slack_channel_id]);
		if (d.config.discord_channel_id) rows.push(['Discord channel', d.config.discord_channel_id]);
		if (d.config.telegram_chat_id) rows.push(['Telegram chat', d.config.telegram_chat_id]);
		if ((d.config.watched_entities ?? []).length > 0) {
			rows.push(['Watched entities', (d.config.watched_entities ?? []).join(', ')]);
		}
		return rows;
	}

	let dept = $state.raw<DepartmentState | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// People for the head-person picker (loaded lazily)
	let people = $state.raw<Person[]>([]);

	// Settings edit state
	let editingSettings = $state(false);
	let settingsForm = $state<SettingsForm>({ ...BLANK_SETTINGS });
	let savingSettings = $state(false);
	let settingsErr = $state<string | null>(null);

	// Delete state
	let deleting = $state(false);
	let deleteErr = $state<string | null>(null);

	// Goal state
	let goals = $state.raw<Goal[]>([]);
	let addingGoal = $state(false);

	// Count of GoalRow children currently in edit mode. Polling pauses while
	// > 0 so a snapshot replacing `goals` mid-edit doesn't flicker the view
	// label or wipe the form state. Unlike the React source no ref indirection
	// is needed — a closure always reads the live `$state` value.
	let editingGoalCount = $state(0);

	function applyDept(d: DepartmentState, isInitial: boolean) {
		dept = d;
		// Don't replace `goals` while any row is being edited — the row owns its
		// form state and a server snapshot would flicker the visible label.
		// Initial load always wins (the user hasn't had a chance to start
		// editing yet).
		if (isInitial || editingGoalCount === 0) {
			goals = d.goals;
		}
		// Same guard for the big settings form.
		if (isInitial || !editingSettings) {
			settingsForm = settingsFormFrom(d);
		}
		if (isInitial && d.config.head_person_id != null) {
			listPeople()
				.then((v) => (people = v))
				.catch(() => {});
		}
	}

	onMount(() => {
		let cancelled = false;

		getDepartment(slug)
			.then((d) => {
				if (!cancelled) applyDept(d, true);
			})
			.catch((e) => {
				if (!cancelled) error = e instanceof Error ? e.message : 'Failed to load';
			})
			.finally(() => {
				if (!cancelled) loading = false;
			});

		// Poll for cross-tab edits and status updates from the
		// department_check_in workflow firing in the background. Pause while
		// any inline form is open.
		const interval = window.setInterval(() => {
			if (editingGoalCount > 0 || editingSettings || addingGoal) return;
			getDepartment(slug)
				.then((d) => applyDept(d, false))
				.catch(() => {
					// Swallow transient errors — the next tick retries.
				});
		}, POLL_INTERVAL_MS);

		return () => {
			cancelled = true;
			window.clearInterval(interval);
		};
	});

	function toggleSettingsEdit() {
		if (editingSettings) {
			// reset
			if (dept) settingsForm = settingsFormFrom(dept);
			settingsErr = null;
		} else if (people.length === 0) {
			// Upstream loaded the roster whenever the user opened edit mode.
			listPeople()
				.then((v) => (people = v))
				.catch(() => {});
		}
		editingSettings = !editingSettings;
	}

	async function saveSettings() {
		if (!dept) return;
		savingSettings = true;
		settingsErr = null;
		try {
			const headcountNum =
				settingsForm.headcount.trim() !== '' ? Number(settingsForm.headcount) : undefined;
			const budgetNum =
				settingsForm.budget_usd.trim() !== '' ? Number(settingsForm.budget_usd) : undefined;
			const updated = await updateDepartment(slug, {
				authority_level: settingsForm.authority_level,
				charter: {
					mission: settingsForm.mission,
					scope: dept.config.charter.scope,
					out_of_scope: dept.config.charter.out_of_scope
				},
				cadences: settingsForm.cadences,
				headcount: headcountNum,
				budget_usd: budgetNum,
				head_person_id: settingsForm.head_person_id,
				// Empty string → null clears the channel; non-empty trim sends the new id.
				slack_channel_id: settingsForm.slack_channel_id.trim() || null,
				discord_channel_id: settingsForm.discord_channel_id.trim() || null,
				telegram_chat_id: settingsForm.telegram_chat_id.trim() || null,
				// Always sent: an emptied textarea clears the list.
				watched_entities: settingsForm.watched_entities
					.split('\n')
					.map((line) => line.trim())
					.filter((line) => line.length > 0)
			});
			dept = updated;
			editingSettings = false;
		} catch (e) {
			settingsErr = e instanceof Error ? e.message : 'Save failed';
		} finally {
			savingSettings = false;
		}
	}

	async function handleDeleteDepartment() {
		if (!dept) return;
		if (
			!window.confirm(
				`Delete "${dept.config.title}"? This will also remove all its Goals and cannot be undone.`
			)
		)
			return;
		deleting = true;
		deleteErr = null;
		try {
			await deleteDepartment(slug);
			await goto('/departments');
		} catch (e) {
			deleteErr = e instanceof Error ? e.message : 'Delete failed';
			deleting = false;
		}
	}
</script>

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-3xl px-6 py-6">
		{#if loading}
			<p class="text-sm text-fg-muted" role="status">Loading…</p>
		{/if}
		{#if error}
			<div
				class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
				role="alert"
			>
				{error}
			</div>
		{/if}

		{#if dept}
			<!-- Header -->
			<div class="mb-6 flex items-start justify-between gap-3">
				<div>
					<h1 class="text-xl font-semibold text-fg">{dept.config.title}</h1>
					<div class="mt-1 text-xs text-fg-muted">
						{#if dept.config.specialist_key}
							Specialist: <code class="font-mono text-fg">{dept.config.specialist_key}</code>
						{:else}
							<span class="italic">Informational department (no specialist agent)</span>
						{/if}
					</div>
				</div>
				<div class="flex shrink-0 items-center gap-2">
					<button
						type="button"
						onclick={toggleSettingsEdit}
						class="rounded-lg border border-line px-3 py-1.5 text-xs transition-colors hover:bg-surface-overlay"
					>
						{editingSettings ? 'Cancel' : 'Edit settings'}
					</button>
					<button
						type="button"
						disabled={deleting}
						onclick={() => void handleDeleteDepartment()}
						class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300 transition-colors hover:bg-rose-500/20 disabled:opacity-50"
					>
						{deleting ? 'Deleting…' : 'Delete department'}
					</button>
				</div>
			</div>
			{#if deleteErr}
				<div
					class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
					role="alert"
				>
					{deleteErr}
				</div>
			{/if}

			<!-- Settings — stacked cards in edit mode, single summary card in read mode -->
			{#if editingSettings}
				<div class="mb-6 space-y-4">
					<!-- Card 1: Charter -->
					<section class="rounded-xl border border-line bg-surface-elevated px-4 py-4">
						<h3 class="mb-3 text-xs font-semibold tracking-wide text-fg-muted uppercase">
							Charter
						</h3>
						<label class="flex flex-col gap-1 text-xs text-fg-muted">
							Mission
							<textarea
								value={settingsForm.mission}
								oninput={(e) => (settingsForm.mission = e.currentTarget.value)}
								rows={3}
								class="resize-none rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
							></textarea>
						</label>
					</section>

					<!-- Card 2: How it acts -->
					<section class="rounded-xl border border-line bg-surface-elevated px-4 py-4">
						<h3 class="mb-3 text-xs font-semibold tracking-wide text-fg-muted uppercase">
							How it acts
						</h3>
						<div class="space-y-3">
							<label class="flex flex-col gap-1 text-xs text-fg-muted">
								Department head
								<select
									value={String(settingsForm.head_person_id ?? '')}
									onchange={(e) =>
										(settingsForm.head_person_id = e.currentTarget.value
											? Number(e.currentTarget.value)
											: null)}
									class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
								>
									<option value="">— None —</option>
									{#each people as p (p.id)}
										<option value={p.id}>
											{p.full_name}{p.role ? ` — ${p.role}` : ''}{p.is_principal ? ' (you)' : ''}
										</option>
									{/each}
								</select>
								<span class="text-[10px] text-fg-muted">
									The Executive surfaces this person as the department owner in routing decisions.
								</span>
							</label>
							<div class="space-y-1.5">
								{#each AUTHORITY_OPTS as a (a)}
									{@const meta = AUTHORITY_META[a]}
									{@const checked = settingsForm.authority_level === a}
									<label
										class={cls(
											'flex cursor-pointer items-start gap-2.5 rounded-lg border p-2.5 transition-colors',
											checked
												? 'border-indigo-500/50 bg-indigo-600/10'
												: 'border-line bg-surface-input hover:border-indigo-500/30'
										)}
									>
										<input
											type="radio"
											name="authority_level"
											value={a}
											{checked}
											onchange={() => (settingsForm.authority_level = a)}
											class="mt-0.5 shrink-0 accent-indigo-500"
										/>
										<div class="min-w-0">
											<div class="text-xs font-medium text-fg">{meta.label}</div>
											<div class="mt-0.5 text-[10px] text-fg-muted">{meta.hint}</div>
										</div>
									</label>
								{/each}
							</div>

							<div>
								<div class="mb-1 text-xs text-fg-muted">Recurring check-in</div>
								{#each Object.entries(settingsForm.cadences) as [name, spec] (name)}
									<div class="mb-1.5 flex items-center gap-2">
										<input
											value={name}
											readonly
											class="flex-1 rounded-lg border border-line bg-surface-input px-2 py-1.5 font-mono text-xs text-fg-muted focus:outline-none"
										/>
										<input
											value={spec}
											oninput={(e) =>
												(settingsForm.cadences = {
													...settingsForm.cadences,
													[name]: e.currentTarget.value
												})}
											class="flex-1 rounded-lg border border-line bg-surface-input px-2 py-1.5 font-mono text-xs focus:border-indigo-500 focus:outline-none"
											placeholder="daily@09:00"
										/>
									</div>
								{/each}
								<p class="mt-1 text-[10px] text-fg-muted">
									When set, the specialist posts a check-in on this schedule. You'll see it in
									Today. Example: <code class="font-mono">daily@09:00</code>,
									<code class="font-mono">mondays@09:00</code>.
								</p>
							</div>
						</div>
					</section>

					<!-- Card 3: Numbers -->
					<section class="rounded-xl border border-line bg-surface-elevated px-4 py-4">
						<h3 class="mb-3 text-xs font-semibold tracking-wide text-fg-muted uppercase">
							Numbers
						</h3>
						<div class="grid grid-cols-2 gap-2">
							<label class="flex flex-col gap-1 text-xs text-fg-muted">
								Headcount
								<input
									type="number"
									min={0}
									value={settingsForm.headcount}
									oninput={(e) => (settingsForm.headcount = e.currentTarget.value)}
									class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
								/>
							</label>
							<label class="flex flex-col gap-1 text-xs text-fg-muted">
								Budget (USD)
								<input
									type="number"
									min={0}
									value={settingsForm.budget_usd}
									oninput={(e) => (settingsForm.budget_usd = e.currentTarget.value)}
									class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
								/>
							</label>
						</div>
					</section>

					<!-- Card 4: Broadcast channels — OE can post to these team rooms -->
					<section class="rounded-xl border border-line bg-surface-elevated px-4 py-4">
						<h3 class="mb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">
							Team channels
						</h3>
						<p class="mb-3 text-[10px] text-fg-muted">
							When set, the Executive can post department-scoped updates to these rooms via <code
								class="font-mono">send_department_message</code
							>. Leave blank to have OE fall back to DMing the department head.
						</p>
						<div class="space-y-2">
							<label class="flex flex-col gap-1 text-xs text-fg-muted">
								Slack channel ID
								<input
									type="text"
									value={settingsForm.slack_channel_id}
									oninput={(e) => (settingsForm.slack_channel_id = e.currentTarget.value)}
									placeholder="C01234ABCDE"
									class="rounded-lg border border-line bg-surface-input px-2 py-1.5 font-mono text-sm focus:border-indigo-500 focus:outline-none"
								/>
							</label>
							<label class="flex flex-col gap-1 text-xs text-fg-muted">
								Discord channel ID
								<input
									type="text"
									value={settingsForm.discord_channel_id}
									oninput={(e) => (settingsForm.discord_channel_id = e.currentTarget.value)}
									placeholder="123456789012345678"
									class="rounded-lg border border-line bg-surface-input px-2 py-1.5 font-mono text-sm focus:border-indigo-500 focus:outline-none"
								/>
							</label>
							<label class="flex flex-col gap-1 text-xs text-fg-muted">
								Telegram chat ID
								<input
									type="text"
									value={settingsForm.telegram_chat_id}
									oninput={(e) => (settingsForm.telegram_chat_id = e.currentTarget.value)}
									placeholder="-1001234567890"
									class="rounded-lg border border-line bg-surface-input px-2 py-1.5 font-mono text-sm focus:border-indigo-500 focus:outline-none"
								/>
							</label>
						</div>
					</section>

					<!-- Card 5: Watched entities — strong grounding for the research watch policy -->
					<section class="rounded-xl border border-line bg-surface-elevated px-4 py-4">
						<h3 class="mb-1 text-xs font-semibold tracking-wide text-fg-muted uppercase">
							Watched entities
						</h3>
						<p class="mb-3 text-[10px] text-fg-muted">
							Vendors, competitors or tickers this department cares about, one per line. Named here,
							the Executive will start watching their status pages, filings and feeds on its own and
							route what it finds to this department and its head.
						</p>
						<label class="flex flex-col gap-1 text-xs text-fg-muted">
							Watched entities (one per line)
							<textarea
								value={settingsForm.watched_entities}
								oninput={(e) => (settingsForm.watched_entities = e.currentTarget.value)}
								rows={4}
								placeholder={WATCHED_ENTITIES_PLACEHOLDER}
								class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
							></textarea>
						</label>
					</section>

					{#if settingsErr}<p class="text-xs text-rose-300" role="alert">{settingsErr}</p>{/if}
					<button
						type="button"
						disabled={savingSettings}
						onclick={() => void saveSettings()}
						class="rounded-lg bg-indigo-600 px-4 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
					>
						{savingSettings ? 'Saving…' : 'Save settings'}
					</button>
				</div>
			{:else}
				<section class="mb-6 rounded-xl border border-line bg-surface-elevated px-4 py-4">
					<div class="divide-y divide-line">
						<div class="flex items-start gap-3 py-2">
							<div class="w-36 shrink-0 pt-0.5 text-xs text-fg-muted">How it acts</div>
							<div>
								<div class="text-sm text-fg">
									{AUTHORITY_META[dept.config.authority_level].label}
								</div>
								<div class="mt-0.5 text-[10px] text-fg-muted">
									{AUTHORITY_META[dept.config.authority_level].hint}
								</div>
							</div>
						</div>
						{#each summaryRowsFor(dept, people) as [label, value] (label)}
							<div class="flex items-start gap-3 py-2">
								<div class="w-36 shrink-0 pt-0.5 text-xs text-fg-muted">{label}</div>
								<div class="text-sm text-fg">{value}</div>
							</div>
						{/each}
						{#if Object.entries(dept.config.cadences).length > 0}
							<div class="flex items-start gap-3 py-2">
								<div class="w-36 shrink-0 pt-0.5 text-xs text-fg-muted">Recurring check-in</div>
								<div class="flex flex-wrap gap-1.5">
									{#each Object.entries(dept.config.cadences) as [n, s] (n)}
										<span
											class="rounded border border-line bg-surface-overlay px-2 py-0.5 font-mono text-xs text-fg"
										>
											{n}: {s}
										</span>
									{/each}
								</div>
							</div>
						{/if}
					</div>
				</section>
			{/if}

			<!-- Charter scope (read-only) -->
			{#if dept.config.charter.scope.length > 0 || dept.config.charter.out_of_scope.length > 0}
				<section class="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
					{#if dept.config.charter.scope.length > 0}
						<div>
							<h2 class="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
								In Scope
							</h2>
							<ul class="list-inside list-disc space-y-1">
								{#each dept.config.charter.scope as s, i (i)}
									<li class="text-sm text-fg">{s}</li>
								{/each}
							</ul>
						</div>
					{/if}
					{#if dept.config.charter.out_of_scope.length > 0}
						<div>
							<h2 class="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
								Out of Scope
							</h2>
							<ul class="list-inside list-disc space-y-1">
								{#each dept.config.charter.out_of_scope as s, i (i)}
									<li class="text-sm text-fg-muted">{s}</li>
								{/each}
							</ul>
						</div>
					{/if}
				</section>
			{/if}

			<!-- Goals -->
			<section>
				<div class="mb-3 flex items-center justify-between">
					<h2 class="text-xs font-semibold tracking-wide text-fg-muted uppercase">
						Goals ({goals.length})
					</h2>
					{#if !addingGoal}
						<button
							type="button"
							onclick={() => (addingGoal = true)}
							class="rounded-lg border border-indigo-500/30 bg-indigo-600/20 px-3 py-1 text-xs text-indigo-300 hover:bg-indigo-600/30"
						>
							+ Add Goal
						</button>
					{/if}
				</div>

				<div class="rounded-xl border border-line bg-surface-elevated px-4">
					{#if addingGoal}
						<AddGoalForm
							{slug}
							onCreated={(goal) => {
								goals = [...goals, goal];
								addingGoal = false;
							}}
							onCancel={() => (addingGoal = false)}
						/>
					{/if}
					{#if goals.length === 0 && !addingGoal}
						<p class="py-6 text-center text-sm text-fg-muted">
							No Goals yet.
							<button
								type="button"
								onclick={() => (addingGoal = true)}
								class="text-indigo-400 hover:underline"
							>
								Add one →
							</button>
						</p>
					{:else}
						{#each goals as goal (goal.id)}
							<GoalRow
								{slug}
								{goal}
								onSaved={(updated) =>
									(goals = goals.map((g) => (g.id === updated.id ? updated : g)))}
								onDeleted={(id) => (goals = goals.filter((g) => g.id !== id))}
								onEditingChange={(editing) =>
									(editingGoalCount = Math.max(0, editingGoalCount + (editing ? 1 : -1)))}
							/>
						{/each}
					{/if}
				</div>
			</section>
		{/if}
	</div>
</main>

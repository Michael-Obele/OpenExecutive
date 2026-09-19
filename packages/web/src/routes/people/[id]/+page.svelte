<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import {
		archivePerson,
		getPerson,
		updatePerson,
		type AvailabilityWindow,
		type Person
	} from '$lib/api.js';

	// SvelteKit decodes dynamic params before exposing them on `page.params`.
	const personId = Number.parseInt(String(page.params.id), 10);

	const ALL_SCOPES = [
		{
			value: 'spend_lt_2k',
			label: 'Spend <$2K',
			hint: 'Receives proposals for any spend under $2K.'
		},
		{
			value: 'spend_lt_10k',
			label: 'Spend <$10K',
			hint: 'Receives proposals for spend under $10K.'
		},
		{
			value: 'spend_gt_10k',
			label: 'Spend >$10K',
			hint: 'Receives proposals for spend over $10K.'
		},
		{
			value: 'hiring_signoff',
			label: 'Hiring',
			hint: 'Receives proposals related to hiring decisions.'
		},
		{
			value: 'vendor_onboarding',
			label: 'Vendors',
			hint: 'Receives proposals for vendor contracts.'
		},
		{
			value: 'customer_credit',
			label: 'Credit',
			hint: 'Receives proposals involving credit or debt.'
		},
		{ value: 'legal_sign', label: 'Legal', hint: 'Receives proposals with legal implications.' },
		{
			value: 'board_comms',
			label: 'Board',
			hint: 'Receives proposals before board communications.'
		},
		{
			value: 'wildcard',
			label: 'All (wildcard)',
			hint: 'Receives anything no one else is scoped for — usually the founder.'
		}
	];

	const CHANNELS = ['any', 'slack', 'discord', 'telegram', 'email'];

	const WEEKDAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

	interface PersonFormState {
		full_name: string;
		role: string;
		email: string;
		slack_user_id: string;
		telegram_chat_id: string;
		discord_user_id: string;
		preferred_channel: string;
		response_sla_hours: string;
		on_leave_until: string;
		authority_scope: string[];
		availability: AvailabilityWindow[];
	}

	function formFrom(p: Person): PersonFormState {
		return {
			full_name: p.full_name,
			role: p.role,
			email: p.email ?? '',
			slack_user_id: p.slack_user_id ?? '',
			telegram_chat_id: p.telegram_chat_id ?? '',
			discord_user_id: p.discord_user_id ?? '',
			preferred_channel: p.preferred_channel,
			response_sla_hours: String(p.response_sla_hours),
			on_leave_until: p.on_leave_until ?? '',
			authority_scope: [...p.authority_scope],
			availability: p.availability.map((w) => ({ ...w, weekdays: [...w.weekdays] }))
		};
	}

	function detailRowsFor(p: Person): Array<[string, string]> {
		return [
			['Preferred channel', p.preferred_channel],
			['Expected reply within', `${p.response_sla_hours} hours`],
			['Email', p.email ?? '—'],
			['Slack user ID', p.slack_user_id ?? '—'],
			['Discord user ID', p.discord_user_id ?? '—'],
			['Telegram chat ID', p.telegram_chat_id ?? '—'],
			['On leave until', p.on_leave_until ?? '—']
		];
	}

	let person = $state.raw<Person | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let editing = $state(false);
	let saving = $state(false);
	let archiving = $state(false);
	let saveErr = $state<string | null>(null);
	let saved = $state(false);

	// Edit-mode disclosure panels
	let showContact = $state(false);
	let showAdvanced = $state(false);

	// Edit form state — mirrors the person fields we allow editing
	let form = $state<PersonFormState>({
		full_name: '',
		role: '',
		email: '',
		slack_user_id: '',
		telegram_chat_id: '',
		discord_user_id: '',
		preferred_channel: 'any',
		response_sla_hours: '24',
		on_leave_until: '',
		authority_scope: [],
		availability: []
	});

	const detailRows = $derived(person ? detailRowsFor(person) : []);

	function resetForm(p: Person) {
		form = formFrom(p);
	}

	onMount(() => {
		if (Number.isNaN(personId)) return;
		getPerson(personId)
			.then((p) => {
				person = p;
				resetForm(p);
				// Auto-open sections that already have data so existing values aren't hidden
				if (
					p.email ||
					p.slack_user_id ||
					p.discord_user_id ||
					p.telegram_chat_id ||
					p.preferred_channel !== 'any' ||
					p.response_sla_hours !== 24
				) {
					showContact = true;
				}
				if (p.on_leave_until) {
					showAdvanced = true;
				}
			})
			.catch((e) => (error = e instanceof Error ? e.message : 'Failed to load'))
			.finally(() => (loading = false));
	});

	function toggleScope(val: string) {
		form.authority_scope = form.authority_scope.includes(val)
			? form.authority_scope.filter((s) => s !== val)
			: [...form.authority_scope, val];
	}

	function addWindow() {
		form.availability = [
			...form.availability,
			{ weekdays: [1], start_local: '09:00', end_local: '17:00', timezone: 'UTC' }
		];
	}

	function updateWindow(i: number, w: AvailabilityWindow) {
		form.availability = form.availability.map((existing, idx) => (idx === i ? w : existing));
	}

	function removeWindow(i: number) {
		form.availability = form.availability.filter((_, idx) => idx !== i);
	}

	// `sort()` is the upstream default (lexicographic) — kept as-is so the
	// `0..6` weekday list still reads left-to-right for single-digit days.
	function toggleDay(windowIndex: number, day: number) {
		const win = form.availability[windowIndex];
		if (!win) return;
		const weekdays = win.weekdays.includes(day)
			? win.weekdays.filter((x) => x !== day)
			: [...win.weekdays, day].sort();
		updateWindow(windowIndex, { ...win, weekdays });
	}

	function cancelEdit() {
		if (person) resetForm(person);
		editing = false;
		saveErr = null;
	}

	async function save() {
		const trimmedName = form.full_name.trim();
		if (!trimmedName) {
			saveErr = 'Full name is required.';
			return;
		}
		saving = true;
		saveErr = null;
		try {
			const slaNum = Number(form.response_sla_hours);
			const updated = await updatePerson(personId, {
				full_name: trimmedName,
				role: form.role.trim(),
				email: form.email.trim() || null,
				slack_user_id: form.slack_user_id.trim() || null,
				telegram_chat_id: form.telegram_chat_id.trim() || null,
				discord_user_id: form.discord_user_id.trim() || null,
				preferred_channel: form.preferred_channel,
				response_sla_hours: slaNum >= 1 ? slaNum : 24,
				on_leave_until: form.on_leave_until || null,
				authority_scope: form.authority_scope,
				availability: form.availability
			});
			person = updated;
			editing = false;
			saved = true;
			setTimeout(() => (saved = false), 2500);
		} catch (e) {
			saveErr = e instanceof Error ? e.message : 'Save failed';
		} finally {
			saving = false;
		}
	}

	async function doArchive() {
		if (
			!window.confirm(
				"Archive this person? They won't receive new assignments but their history is preserved."
			)
		)
			return;
		archiving = true;
		saveErr = null;
		try {
			await archivePerson(personId);
			await goto('/people');
		} catch (e) {
			saveErr = e instanceof Error ? e.message : 'Archive failed';
			archiving = false;
		}
	}
</script>

{#snippet windowRow(win: AvailabilityWindow, index: number)}
	<div class="space-y-2 rounded-lg border border-line bg-surface-input p-3">
		<div class="flex flex-wrap gap-1">
			{#each WEEKDAY_NAMES as name, idx (name)}
				{@const active = win.weekdays.includes(idx)}
				<button
					type="button"
					onclick={() => toggleDay(index, idx)}
					aria-pressed={active}
					class="rounded border px-2 py-0.5 text-xs font-medium transition-colors {active
						? 'border-indigo-500/50 bg-indigo-600/40 text-indigo-200'
						: 'border-line bg-surface-overlay text-fg-muted hover:border-indigo-500/40'}"
				>
					{name}
				</button>
			{/each}
		</div>
		<div class="grid grid-cols-3 gap-2">
			<label class="flex flex-col gap-0.5 text-[10px] text-fg-muted">
				Start
				<input
					type="time"
					value={win.start_local}
					oninput={(e) => updateWindow(index, { ...win, start_local: e.currentTarget.value })}
					class="rounded border border-line bg-surface-elevated px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none"
				/>
			</label>
			<label class="flex flex-col gap-0.5 text-[10px] text-fg-muted">
				End
				<input
					type="time"
					value={win.end_local}
					oninput={(e) => updateWindow(index, { ...win, end_local: e.currentTarget.value })}
					class="rounded border border-line bg-surface-elevated px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none"
				/>
			</label>
			<label class="flex flex-col gap-0.5 text-[10px] text-fg-muted">
				Timezone
				<input
					value={win.timezone}
					oninput={(e) => updateWindow(index, { ...win, timezone: e.currentTarget.value })}
					class="rounded border border-line bg-surface-elevated px-2 py-1 text-xs focus:border-indigo-500 focus:outline-none"
					placeholder="America/Los_Angeles"
				/>
			</label>
		</div>
		{#if win.weekdays.length === 0}
			<p class="text-[10px] text-amber-400">Select at least one day.</p>
		{/if}
		{#if win.end_local <= win.start_local && win.start_local !== '' && win.end_local !== ''}
			<p class="text-[10px] text-amber-400">End time must be after start time.</p>
		{/if}
		<button
			type="button"
			onclick={() => removeWindow(index)}
			class="text-[10px] text-rose-400 hover:text-rose-300"
		>
			Remove window
		</button>
	</div>
{/snippet}

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-2xl px-6 py-6">
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

		{#if person}
			<!-- Header -->
			<div class="mb-6 flex items-start gap-3">
				<div
					class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-indigo-500 to-violet-600"
				>
					<span class="text-sm font-bold text-white">
						{person.full_name.charAt(0).toUpperCase()}
					</span>
				</div>
				<div class="min-w-0 flex-1">
					<h1 class="text-xl font-semibold text-fg">
						{person.full_name}
						{#if person.is_principal}
							<span
								class="ml-2 inline-block rounded border border-violet-500/30 bg-violet-500/20 px-1.5 py-0.5 align-middle text-[10px] font-medium text-violet-300"
							>
								Principal
							</span>
						{/if}
						{#if person.archived}
							<span
								class="ml-2 inline-block rounded border border-rose-500/30 bg-rose-500/20 px-1.5 py-0.5 align-middle text-[10px] font-medium text-rose-300"
							>
								Archived
							</span>
						{/if}
					</h1>
					<p class="text-sm text-fg-muted">{person.role || 'No role set'}</p>
				</div>
				<div class="flex shrink-0 gap-2">
					{#if saved}
						<span class="self-center text-xs text-emerald-400">Saved ✓</span>
					{/if}
					{#if editing}
						<button
							type="button"
							disabled={saving || !form.full_name.trim()}
							onclick={() => void save()}
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
					{:else}
						<button
							type="button"
							onclick={() => (editing = true)}
							class="rounded-lg border border-line px-3 py-1.5 text-xs hover:bg-surface-overlay"
						>
							Edit
						</button>
					{/if}
				</div>
			</div>

			{#if saveErr}
				<div
					class="mb-4 rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-sm text-rose-300"
					role="alert"
				>
					{saveErr}
				</div>
			{/if}

			<!-- Core fields -->
			<section class="mb-6 rounded-xl border border-line bg-surface-elevated px-4">
				{#if editing}
					<div class="space-y-3 py-4">
						<!-- Always-visible in edit mode -->
						<div class="grid grid-cols-2 gap-3">
							<label class="flex flex-col gap-1 text-xs text-fg-muted">
								Full name
								<input
									value={form.full_name}
									oninput={(e) => (form.full_name = e.currentTarget.value)}
									class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
								/>
							</label>
							<label class="flex flex-col gap-1 text-xs text-fg-muted">
								Role
								<input
									value={form.role}
									oninput={(e) => (form.role = e.currentTarget.value)}
									class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
								/>
							</label>
						</div>

						<!-- Contact & routing -->
						<div class="border-t border-line pt-2">
							<button
								type="button"
								onclick={() => (showContact = !showContact)}
								aria-expanded={showContact}
								class="flex w-full items-center justify-between py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
							>
								<span>Contact &amp; routing</span>
								<span aria-hidden="true" class="text-[10px] text-fg-subtle"
									>{showContact ? '▲' : '▼'}</span
								>
							</button>
							{#if showContact}
								<div class="space-y-3 pt-2">
									<div class="grid grid-cols-2 gap-3">
										<div>
											<label class="flex flex-col gap-1 text-xs text-fg-muted">
												Preferred channel
												<select
													value={form.preferred_channel}
													onchange={(e) => (form.preferred_channel = e.currentTarget.value)}
													class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
												>
													{#each CHANNELS as c (c)}
														<option value={c}>{c}</option>
													{/each}
												</select>
											</label>
											<p class="mt-1 text-[10px] text-fg-muted">
												Proposals routed to this person are sent via {form.preferred_channel ===
												'any'
													? 'any available channel'
													: form.preferred_channel}.
											</p>
										</div>
										<div>
											<label class="flex flex-col gap-1 text-xs text-fg-muted">
												Expected reply within
												<div class="flex items-center gap-1.5">
													<input
														type="number"
														min={1}
														value={form.response_sla_hours}
														oninput={(e) => (form.response_sla_hours = e.currentTarget.value)}
														class="flex-1 rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
													/>
													<span class="shrink-0 text-xs text-fg-muted">hours</span>
												</div>
											</label>
											<p class="mt-1 text-[10px] text-fg-muted">
												Items overdue in Today after {form.response_sla_hours || 24}h with no reply.
											</p>
										</div>
									</div>

									<label class="flex flex-col gap-1 text-xs text-fg-muted">
										Email
										<input
											type="email"
											value={form.email}
											oninput={(e) => (form.email = e.currentTarget.value)}
											class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
										/>
									</label>

									<label class="flex flex-col gap-1 text-xs text-fg-muted">
										Slack user ID
										<input
											value={form.slack_user_id}
											oninput={(e) => (form.slack_user_id = e.currentTarget.value)}
											class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
											placeholder="U01ABC123"
										/>
									</label>

									<label class="flex flex-col gap-1 text-xs text-fg-muted">
										Discord user ID
										<input
											value={form.discord_user_id}
											oninput={(e) => (form.discord_user_id = e.currentTarget.value)}
											class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
											placeholder="123456789012345678"
										/>
										<span class="text-[10px] text-fg-muted">
											Right-click your Discord username and "Copy User ID" (developer mode
											required).
										</span>
									</label>

									<label class="flex flex-col gap-1 text-xs text-fg-muted">
										Telegram chat ID
										<input
											value={form.telegram_chat_id}
											oninput={(e) => (form.telegram_chat_id = e.currentTarget.value)}
											class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
											placeholder="123456789"
										/>
									</label>
								</div>
							{/if}
						</div>

						<!-- Advanced -->
						<div class="border-t border-line pt-2">
							<button
								type="button"
								onclick={() => (showAdvanced = !showAdvanced)}
								aria-expanded={showAdvanced}
								class="flex w-full items-center justify-between py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
							>
								<span>Advanced</span>
								<span aria-hidden="true" class="text-[10px] text-fg-subtle"
									>{showAdvanced ? '▲' : '▼'}</span
								>
							</button>
							{#if showAdvanced}
								<div class="space-y-3 pt-2">
									<label class="flex flex-col gap-1 text-xs text-fg-muted">
										On leave until
										<input
											type="date"
											value={form.on_leave_until}
											oninput={(e) => (form.on_leave_until = e.currentTarget.value)}
											class="rounded-lg border border-line bg-surface-input px-2 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
										/>
									</label>
								</div>
							{/if}
						</div>
					</div>
				{:else}
					<div class="divide-y divide-line">
						{#each detailRows as [label, value] (label)}
							<div class="flex items-start gap-3 py-2">
								<div class="w-40 shrink-0 pt-0.5 text-xs text-fg-muted">{label}</div>
								<div class="text-sm text-fg">{value}</div>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<!-- Authority scope -->
			<section class="mb-6">
				<h2 class="mb-3 text-xs font-semibold tracking-wide text-fg-muted uppercase">
					What this person approves
				</h2>
				{#if editing}
					<div class="grid grid-cols-3 gap-2">
						{#each ALL_SCOPES as { value, label, hint } (value)}
							{@const active = form.authority_scope.includes(value)}
							<button
								type="button"
								onclick={() => toggleScope(value)}
								title={hint}
								aria-pressed={active}
								class="rounded-lg border px-2 py-2 text-left text-xs transition-colors {active
									? 'border-indigo-500/50 bg-indigo-600/30 text-indigo-300'
									: 'border-line bg-surface-elevated text-fg-muted hover:border-indigo-500/40'}"
							>
								<div class="font-medium">{label}</div>
								<div class="mt-0.5 line-clamp-2 text-[9px] leading-tight opacity-70">
									{hint}
								</div>
							</button>
						{/each}
					</div>
				{:else if person.authority_scope.length === 0}
					<p class="text-sm text-fg-muted">No approval authority.</p>
				{:else}
					<div class="flex flex-wrap gap-2">
						{#each person.authority_scope as s (s)}
							{@const entry = ALL_SCOPES.find((x) => x.value === s)}
							<span
								class="inline-block rounded-lg border px-2 py-1 text-xs font-medium {s ===
								'wildcard'
									? 'border-indigo-500/30 bg-indigo-500/20 text-indigo-300'
									: 'border-line bg-surface-input/40 text-fg'}"
							>
								{entry?.label ?? s}
							</span>
						{/each}
					</div>
				{/if}
			</section>

			<!-- Availability windows -->
			<section class="mb-6">
				<div class="mb-3 flex items-center justify-between">
					<h2 class="text-xs font-semibold tracking-wide text-fg-muted uppercase">
						Availability Windows
					</h2>
					{#if editing}
						<button
							type="button"
							onclick={addWindow}
							class="text-xs text-indigo-400 hover:text-indigo-300"
						>
							+ Add window
						</button>
					{/if}
				</div>

				{#if editing}
					<div class="space-y-2">
						{#if form.availability.length === 0}
							<p class="text-sm text-fg-muted">
								No windows — person is considered always available.
								<button type="button" onclick={addWindow} class="text-indigo-400 hover:underline">
									Add one →
								</button>
							</p>
						{/if}
						{#each form.availability as w, i (i)}
							{@render windowRow(w, i)}
						{/each}
					</div>
				{:else if person.availability.length === 0}
					<p class="text-sm text-fg-muted">Always available (no windows set).</p>
				{:else}
					<div class="space-y-2">
						{#each person.availability as w, i (i)}
							<div
								class="flex items-center gap-3 rounded-lg border border-line bg-surface-elevated px-4 py-2.5 text-sm"
							>
								<div class="flex gap-1">
									{#each w.weekdays as d (d)}
										<span class="rounded bg-surface-overlay px-1.5 py-0.5 text-xs text-fg">
											{WEEKDAY_NAMES[d] ?? d}
										</span>
									{/each}
								</div>
								<span class="text-fg">{w.start_local} – {w.end_local}</span>
								<span class="text-xs text-fg-muted">{w.timezone}</span>
							</div>
						{/each}
					</div>
				{/if}
			</section>

			<!-- Archive -->
			{#if !person.is_principal && !person.archived}
				<section class="border-t border-line pt-6">
					<h2 class="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">
						Danger zone
					</h2>
					<p class="mb-3 text-xs text-fg-muted">
						Archiving removes this person from routing and the active roster. Their history is
						preserved.
					</p>
					<button
						type="button"
						disabled={archiving}
						onclick={() => void doArchive()}
						class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-4 py-2 text-sm text-rose-300 hover:bg-rose-500/20 disabled:opacity-50"
					>
						{archiving ? 'Archiving…' : 'Archive person'}
					</button>
				</section>
			{/if}
		{/if}
	</div>
</main>

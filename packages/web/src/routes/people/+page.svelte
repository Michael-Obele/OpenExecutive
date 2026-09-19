<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import { useAskOEForm, type RegisteredForm } from '$lib/components/askoe/askoe.svelte.js';
	import { createPerson, listPeople, type PageFormField, type Person } from '$lib/api.js';

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
	const SCOPE_VALUES = ALL_SCOPES.map((s) => s.value);

	interface AddPersonForm {
		full_name: string;
		role: string;
		is_principal: boolean;
		email: string;
		slack_user_id: string;
		telegram_chat_id: string;
		discord_user_id: string;
		preferred_channel: string;
		response_sla_hours: string;
		authority_scope: string[];
	}

	const BLANK_FORM: AddPersonForm = {
		full_name: '',
		role: '',
		is_principal: false,
		email: '',
		slack_user_id: '',
		telegram_chat_id: '',
		discord_user_id: '',
		preferred_channel: 'any',
		response_sla_hours: '24',
		authority_scope: []
	};

	function blankForm(): AddPersonForm {
		return { ...BLANK_FORM, authority_scope: [] };
	}

	let people = $state.raw<Person[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// Add-person modal — state hoisted out of the upstream `AddPersonModal`
	// sub-component (one component per `.svelte` file in this port). Ask OE
	// registration below mirrors that modal's `useAskOEFormContext` call.
	let showAdd = $state(false);
	let form = $state<AddPersonForm>(blankForm());
	let saving = $state(false);
	let err = $state<string | null>(null);
	let showContact = $state(false);
	let showAuthority = $state(false);
	let nameEl = $state<HTMLInputElement | null>(null);

	function refresh() {
		loading = true;
		listPeople()
			.then((v) => (people = v))
			.catch((e) => (error = e instanceof Error ? e.message : 'Failed to load'))
			.finally(() => (loading = false));
	}

	onMount(() => {
		refresh();
	});

	const addPersonForm: RegisteredForm = {
		formId: 'add_person',
		title: 'Add person',
		description:
			'Adds a human the Executive coordinates with. Authority scopes determine which proposals route to them for approval.',
		getFields: (): PageFormField[] => [
			{
				name: 'full_name',
				label: 'Full name',
				type: 'text',
				value: form.full_name,
				required: true
			},
			{ name: 'role', label: 'Role', type: 'text', value: form.role },
			{
				name: 'is_principal',
				label: 'This is me — Primary',
				type: 'boolean',
				value: form.is_principal,
				description: 'Marks the person as the primary decision-maker. Only for the user themselves.'
			},
			{
				name: 'preferred_channel',
				label: 'Preferred channel',
				type: 'select',
				options: CHANNELS,
				value: form.preferred_channel
			},
			{
				name: 'response_sla_hours',
				label: 'Expected reply within (hours)',
				type: 'number',
				value: Number(form.response_sla_hours) || 24
			},
			{ name: 'email', label: 'Email', type: 'text', value: form.email },
			{ name: 'slack_user_id', label: 'Slack user ID', type: 'text', value: form.slack_user_id },
			{
				name: 'discord_user_id',
				label: 'Discord user ID',
				type: 'text',
				value: form.discord_user_id
			},
			{
				name: 'telegram_chat_id',
				label: 'Telegram chat ID',
				type: 'text',
				value: form.telegram_chat_id
			},
			{
				name: 'authority_scope',
				label: 'Approval authority',
				type: 'json',
				value: form.authority_scope,
				description: `JSON array of scope tokens, each one of: ${SCOPE_VALUES.join(', ')}.`
			}
		],
		applyPatch: (values) => {
			const applied: string[] = [];
			const skipped: string[] = [];
			// Snapshot for undo — captured before any field is written.
			const before = {
				form: { ...form, authority_scope: [...form.authority_scope] },
				showContact,
				showAuthority
			};
			const next: AddPersonForm = { ...form, authority_scope: [...form.authority_scope] };
			for (const [key, raw] of Object.entries(values)) {
				switch (key) {
					case 'full_name':
					case 'role':
					case 'email':
					case 'slack_user_id':
					case 'discord_user_id':
					case 'telegram_chat_id':
						if (typeof raw === 'string') {
							next[key] = raw;
							applied.push(key);
						} else skipped.push(key);
						break;
					case 'is_principal':
						if (typeof raw === 'boolean') {
							next.is_principal = raw;
							applied.push(key);
						} else skipped.push(key);
						break;
					case 'preferred_channel':
						if (typeof raw === 'string' && CHANNELS.includes(raw)) {
							next.preferred_channel = raw;
							applied.push(key);
						} else skipped.push(key);
						break;
					case 'response_sla_hours': {
						const n = Number(raw);
						if (Number.isFinite(n) && n >= 1) {
							next.response_sla_hours = String(Math.round(n));
							applied.push(key);
						} else skipped.push(key);
						break;
					}
					case 'authority_scope': {
						const arr = Array.isArray(raw)
							? raw.filter((s): s is string => typeof s === 'string' && SCOPE_VALUES.includes(s))
							: null;
						// Empty after filtering means no proposed scope was recognized —
						// skip rather than silently wiping every existing scope.
						if (arr !== null && arr.length > 0) {
							next.authority_scope = arr;
							applied.push(key);
						} else skipped.push(key);
						break;
					}
					default:
						skipped.push(key);
				}
			}
			form = next;
			// Open the disclosures so the suggested values are visible to review.
			if (
				applied.some((k) =>
					[
						'email',
						'slack_user_id',
						'discord_user_id',
						'telegram_chat_id',
						'preferred_channel',
						'response_sla_hours'
					].includes(k)
				)
			) {
				showContact = true;
			}
			if (applied.includes('authority_scope')) showAuthority = true;
			return {
				applied,
				skipped,
				undo: () => {
					form = before.form;
					showContact = before.showContact;
					showAuthority = before.showAuthority;
				}
			};
		}
	};

	const { suggestedCls, clearSuggested } = useAskOEForm(() => (showAdd ? addPersonForm : null));

	async function openAdd() {
		form = blankForm();
		err = null;
		showContact = false;
		showAuthority = false;
		showAdd = true;
		// Upstream focused the name input on modal mount.
		await tick();
		nameEl?.focus();
	}

	function closeAdd() {
		if (saving) return;
		showAdd = false;
	}

	function toggleScope(val: string) {
		form.authority_scope = form.authority_scope.includes(val)
			? form.authority_scope.filter((s) => s !== val)
			: [...form.authority_scope, val];
	}

	async function submit() {
		saving = true;
		err = null;
		try {
			const person = await createPerson({
				full_name: form.full_name.trim(),
				role: form.role.trim(),
				is_principal: form.is_principal,
				email: form.email.trim() || null,
				slack_user_id: form.slack_user_id.trim() || null,
				telegram_chat_id: form.telegram_chat_id.trim() || null,
				discord_user_id: form.discord_user_id.trim() || null,
				preferred_channel: form.preferred_channel,
				response_sla_hours: Number(form.response_sla_hours) || 24,
				authority_scope: form.authority_scope
			});
			people = [...people, person];
			showAdd = false;
		} catch (e) {
			err = e instanceof Error ? e.message : 'Create failed';
		} finally {
			saving = false;
		}
	}
</script>

{#snippet scopePill(scope: string)}
	{@const entry = ALL_SCOPES.find((s) => s.value === scope)}
	{@const pillCls =
		scope === 'wildcard'
			? 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30'
			: 'bg-surface-input/40 text-fg-muted border-line'}
	<span class="inline-block rounded border px-1.5 py-0.5 text-[10px] font-medium {pillCls}">
		{entry?.label ?? scope}
	</span>
{/snippet}

{#snippet personCard(person: Person)}
	<a
		href={`/people/${person.id}`}
		class="group block rounded-xl border border-line bg-surface-elevated p-4 transition-colors hover:bg-surface-overlay"
	>
		<div class="mb-2 flex items-start justify-between gap-2">
			<div>
				<div
					class="flex items-center gap-2 text-sm font-semibold text-fg transition-colors group-hover:text-indigo-300"
				>
					{person.full_name}
					{#if person.is_principal}
						<span
							class="inline-block rounded border border-violet-500/30 bg-violet-500/20 px-1.5 py-0.5 text-[10px] font-medium text-violet-300"
						>
							Principal
						</span>
					{/if}
				</div>
				<div class="mt-0.5 text-xs text-fg-muted">{person.role || '—'}</div>
			</div>
			<div class="shrink-0 text-xs text-fg-muted capitalize">{person.preferred_channel}</div>
		</div>
		<div class="mb-2 text-xs text-fg-muted">SLA: {person.response_sla_hours}h</div>
		{#if person.authority_scope.length > 0}
			<div class="flex flex-wrap gap-1">
				{#each person.authority_scope as s (s)}
					{@render scopePill(s)}
				{/each}
			</div>
		{/if}
	</a>
{/snippet}

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-5xl px-6 py-6">
		<div class="mb-6 flex items-baseline justify-between">
			<div>
				<h1 class="text-xl font-semibold text-fg">People</h1>
				<p class="mt-0.5 text-sm text-fg-muted">
					Humans the Executive coordinates with. Authority scopes determine who approves what.
				</p>
			</div>
			<button
				type="button"
				onclick={() => void openAdd()}
				class="shrink-0 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-500"
			>
				+ Add person
			</button>
		</div>

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
		{#if !loading && !error && people.length === 0}
			<div class="rounded-xl border border-line bg-surface-elevated p-8 text-center">
				<p class="mb-3 text-sm text-fg-muted">No people configured yet.</p>
				<button
					type="button"
					onclick={() => void openAdd()}
					class="rounded-lg bg-indigo-600 px-4 py-2 text-sm text-white hover:bg-indigo-500"
				>
					Add your first person →
				</button>
			</div>
		{/if}

		<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
			{#each people as person (person.id)}
				{@render personCard(person)}
			{/each}
		</div>
	</div>
</main>

<Dialog.Root open={showAdd} onOpenChange={(open) => !open && closeAdd()}>
	<Dialog.Content
		showCloseButton={false}
		aria-describedby={undefined}
		class="max-h-[90vh] w-full gap-0 overflow-y-auto rounded-2xl border border-line bg-surface p-6 ring-0 sm:max-w-lg"
	>
		<Dialog.Title class="mb-4 text-base font-semibold text-fg">Add person</Dialog.Title>

		<div class="space-y-3">
			<!-- Always-visible: the 10-second path -->
			<label class="flex flex-col gap-1 text-xs text-fg-muted">
				Full name *
				<input
					bind:this={nameEl}
					value={form.full_name}
					oninput={(e) => {
						form.full_name = e.currentTarget.value;
						clearSuggested('full_name');
					}}
					class="rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none {suggestedCls(
						'full_name'
					)}"
					placeholder="Sarah Chen"
				/>
			</label>

			<label class="flex flex-col gap-1 text-xs text-fg-muted">
				Role
				<input
					value={form.role}
					oninput={(e) => {
						form.role = e.currentTarget.value;
						clearSuggested('role');
					}}
					class="rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none {suggestedCls(
						'role'
					)}"
					placeholder="CFO (fractional)"
				/>
			</label>

			<label class="flex cursor-pointer items-center gap-2.5 select-none">
				<input
					type="checkbox"
					checked={form.is_principal}
					onchange={(e) => {
						const checked = e.currentTarget.checked;
						form.is_principal = checked;
						if (checked) showAuthority = true;
					}}
					class="h-4 w-4 rounded accent-indigo-500"
				/>
				<span class="text-sm text-fg">This is me — Primary</span>
				<span class="text-xs text-fg-muted">— marks you as the primary decision-maker</span>
			</label>

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
										class="rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
									>
										{#each CHANNELS as c (c)}
											<option value={c}>{c}</option>
										{/each}
									</select>
								</label>
								<p class="mt-1 text-[10px] text-fg-muted">
									Proposals routed to this person are sent via {form.preferred_channel === 'any'
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
											class="flex-1 rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
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
								value={form.email}
								oninput={(e) => {
									form.email = e.currentTarget.value;
									clearSuggested('email');
								}}
								class="rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none {suggestedCls(
									'email'
								)}"
								placeholder="sarah@example.com"
							/>
						</label>

						<label class="flex flex-col gap-1 text-xs text-fg-muted">
							Slack user ID
							<input
								value={form.slack_user_id}
								oninput={(e) => (form.slack_user_id = e.currentTarget.value)}
								class="rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
								placeholder="U01ABC123"
							/>
						</label>

						<label class="flex flex-col gap-1 text-xs text-fg-muted">
							Discord user ID
							<input
								value={form.discord_user_id}
								oninput={(e) => (form.discord_user_id = e.currentTarget.value)}
								class="rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
								placeholder="123456789012345678"
							/>
							<span class="text-[10px] text-fg-muted">
								Right-click your Discord username and "Copy User ID" (developer mode required).
							</span>
						</label>

						<label class="flex flex-col gap-1 text-xs text-fg-muted">
							Telegram chat ID
							<input
								value={form.telegram_chat_id}
								oninput={(e) => (form.telegram_chat_id = e.currentTarget.value)}
								class="rounded-lg border border-line bg-surface-input px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
								placeholder="123456789"
							/>
						</label>
					</div>
				{/if}
			</div>

			<!-- Approval authority -->
			<div class="border-t border-line pt-2">
				<button
					type="button"
					onclick={() => (showAuthority = !showAuthority)}
					aria-expanded={showAuthority}
					class="flex w-full items-center justify-between py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
				>
					<span>Approval authority</span>
					<span aria-hidden="true" class="text-[10px] text-fg-subtle"
						>{showAuthority ? '▲' : '▼'}</span
					>
				</button>
				{#if showAuthority}
					<div class="space-y-3 pt-2">
						<div class="mb-1.5 text-[10px] text-fg-muted">What this person approves</div>
						<div class="grid grid-cols-3 gap-1.5">
							{#each ALL_SCOPES as { value, label, hint } (value)}
								{@const active = form.authority_scope.includes(value)}
								<button
									type="button"
									onclick={() => toggleScope(value)}
									title={hint}
									aria-pressed={active}
									class="rounded-lg border px-2 py-1.5 text-left text-xs transition-colors {active
										? 'border-indigo-500/50 bg-indigo-600/30 text-indigo-300'
										: 'border-line bg-surface-input text-fg-muted hover:border-indigo-500/40'}"
								>
									<div class="font-medium">{label}</div>
									<div class="mt-0.5 line-clamp-2 text-[9px] leading-tight opacity-70">
										{hint}
									</div>
								</button>
							{/each}
						</div>
					</div>
				{/if}
			</div>
		</div>

		{#if err}<p class="mt-3 text-xs text-rose-300" role="alert">{err}</p>{/if}

		<div class="mt-5 flex gap-2">
			<button
				type="button"
				disabled={saving || !form.full_name.trim()}
				onclick={() => void submit()}
				class="flex-1 rounded-lg bg-indigo-600 py-2 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
			>
				{saving ? 'Creating…' : 'Add person'}
			</button>
			<button
				type="button"
				disabled={saving}
				onclick={closeAdd}
				class="rounded-lg border border-line px-4 py-2 text-sm hover:bg-surface-overlay disabled:opacity-50"
			>
				Cancel
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>

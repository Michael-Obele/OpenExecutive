<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type {
		ClientCockpitCard,
		ClientDraftResult,
		ClientMetaPatch,
		ClientSlotSummary,
		ClientsStatus
	} from '$lib/api.js';
	import {
		activateClient,
		createClient,
		createClientFromDraft,
		deleteClient,
		generateClientDraft,
		getClientsCockpit,
		listClients,
		saveActiveClient,
		updateClientMeta
	} from '$lib/api.js';
	import { clientCountsSummary, renewalBadge } from '$lib/practice.js';

	type MetaForm = Required<
		Pick<
			ClientMetaPatch,
			'role' | 'status' | 'renewal_date' | 'retainer' | 'primary_contact' | 'notes'
		>
	>;

	// Client-company switcher for fractional / multi-client use. One client is
	// live at a time; switching saves the current client back to its slot and
	// restores the target. Single-company installs see only the intro + create
	// form — nothing about the default experience changes until a client exists.

	// base64url-encode a prefill payload for the /jobs/{name} runner page
	// (mirrors decodePrefill there).
	function encodePrefill(payload: Record<string, string>): string {
		const json = JSON.stringify(payload);
		const bytes = new TextEncoder().encode(json);
		let binary = '';
		bytes.forEach((b) => (binary += String.fromCharCode(b)));
		return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
	}

	/** One-line slot summary: engagement identity · document count · save state. */
	function slotSummary(c: ClientSlotSummary): string {
		const head = [c.role, c.status, c.industry, c.stage].filter(Boolean).join(' · ') || c.slug;
		const docs = `${c.doc_count} doc${c.doc_count !== 1 ? 's' : ''}`;
		const saved = c.saved_at ? `saved ${new Date(c.saved_at).toLocaleString()}` : 'never saved';
		return `${head} · ${docs} · ${saved}`;
	}

	let status = $state.raw<ClientsStatus>({ active: null, fixture_active: null, clients: [] });
	let loading = $state(true);
	let busySlug = $state<string | null>(null);
	let toast = $state<{ message: string; kind: 'success' | 'error' } | null>(null);
	let name = $state('');
	let source = $state<'current' | 'blank'>('current');
	let creating = $state(false);
	let confirmDelete = $state<string | null>(null);

	// Engagement-intake (AI draft) flow.
	let notes = $state('');
	let attachments = $state.raw<File[]>([]);
	let generating = $state(false);
	let draft = $state.raw<ClientDraftResult | null>(null);
	let draftName = $state('');
	let creatingDraft = $state(false);

	// Practice cockpit (multi-client only) + per-slot engagement metadata edit.
	let cockpit = $state.raw<ClientCockpitCard[]>([]);
	let editingSlug = $state<string | null>(null);
	// Engagement-metadata editor. Deep `$state` (not `.raw`) because each field
	// is edited in place, and every field is a real string so `bind:value` works.
	let metaForm = $state<MetaForm>({
		role: '',
		status: 'active',
		renewal_date: '',
		retainer: '',
		primary_contact: '',
		notes: ''
	});
	let savingMeta = $state(false);

	let fileInputEl = $state<HTMLInputElement | null>(null);

	// Upstream dismissed the banner 5s after it appeared (an effect on `toast`);
	// doing it at the single mutation point keeps this handler-driven.
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	function showToast(next: { message: string; kind: 'success' | 'error' }) {
		toast = next;
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 5000);
	}

	onDestroy(() => clearTimeout(toastTimer));

	async function refresh() {
		try {
			const next = await listClients();
			status = next;
			if (next.clients.length >= 2) {
				try {
					cockpit = (await getClientsCockpit()).clients;
				} catch {
					cockpit = [];
				}
			} else {
				cockpit = [];
			}
		} catch {
			showToast({ message: 'Failed to load clients', kind: 'error' });
		} finally {
			loading = false;
		}
	}

	onMount(() => {
		void refresh();
	});

	async function handleCreate() {
		if (!name.trim()) return;
		creating = true;
		try {
			const created = await createClient(name.trim(), source);
			showToast({
				message: created.active
					? `${created.display_name} created from your current company and is now active.`
					: `${created.display_name} created — activate it to start onboarding.`,
				kind: 'success'
			});
			name = '';
			await refresh();
		} catch (e: unknown) {
			showToast({ message: e instanceof Error ? e.message : 'Create failed', kind: 'error' });
		} finally {
			creating = false;
		}
	}

	function openMetaEditor(slug: string) {
		// The slot summary carries the practice metadata directly here, so the
		// upstream widening cast to a Record is unnecessary.
		const c = status.clients.find((x) => x.slug === slug);
		metaForm = {
			role: c?.role ?? '',
			status: c?.status ?? 'active',
			renewal_date: c?.renewal_date ?? '',
			retainer: c?.retainer ?? '',
			primary_contact: c?.primary_contact ?? '',
			notes: c?.notes ?? ''
		};
		editingSlug = slug;
	}

	async function handleSaveMeta() {
		if (!editingSlug) return;
		savingMeta = true;
		try {
			// Drop empty strings so we never overwrite with blanks unintentionally.
			const patch = Object.fromEntries(
				Object.entries(metaForm).filter(([, v]) => v !== '' && v !== undefined)
			) as ClientMetaPatch;
			await updateClientMeta(editingSlug, patch);
			showToast({ message: 'Engagement details saved.', kind: 'success' });
			editingSlug = null;
			await refresh();
		} catch (e: unknown) {
			showToast({ message: e instanceof Error ? e.message : 'Save failed', kind: 'error' });
		} finally {
			savingMeta = false;
		}
	}

	async function handleGenerateDraft() {
		if (!notes.trim() && attachments.length === 0) return;
		generating = true;
		try {
			const result = await generateClientDraft(notes.trim(), attachments);
			draft = result;
			draftName = result.display_name;
		} catch (e: unknown) {
			showToast({ message: e instanceof Error ? e.message : 'Draft failed', kind: 'error' });
		} finally {
			generating = false;
		}
	}

	async function handleCreateFromDraft(activate: boolean) {
		if (!draft) return;
		creatingDraft = true;
		try {
			const displayName = draftName.trim() || draft.display_name;
			const bundle = { ...draft.bundle, profile: { ...draft.bundle.profile, name: displayName } };
			const created = await createClientFromDraft(displayName, bundle, notes.trim());
			if (activate) {
				await activateClient(created.slug);
				showToast({ message: `${displayName} created and activated.`, kind: 'success' });
			} else {
				showToast({
					message: `${displayName} created — activate it to start the engagement.`,
					kind: 'success'
				});
			}
			draft = null;
			notes = '';
			attachments = [];
			await refresh();
		} catch (e: unknown) {
			showToast({ message: e instanceof Error ? e.message : 'Create failed', kind: 'error' });
		} finally {
			creatingDraft = false;
		}
	}

	async function handleActivate(slug: string) {
		busySlug = slug;
		try {
			const result = await activateClient(slug);
			showToast({
				message: result.mcp_config_changed
					? `Switched to ${slug}. MCP tool config changed — it applies on the next API restart.`
					: `Switched to ${slug}.`,
				kind: 'success'
			});
			await refresh();
		} catch (e: unknown) {
			showToast({ message: e instanceof Error ? e.message : 'Switch failed', kind: 'error' });
		} finally {
			busySlug = null;
		}
	}

	async function handleSave() {
		busySlug = status.active;
		try {
			const result = await saveActiveClient();
			showToast({ message: `Saved ${result.slug} to its slot.`, kind: 'success' });
			await refresh();
		} catch (e: unknown) {
			showToast({ message: e instanceof Error ? e.message : 'Save failed', kind: 'error' });
		} finally {
			busySlug = null;
		}
	}

	async function handleDelete(slug: string) {
		busySlug = slug;
		try {
			await deleteClient(slug);
			showToast({ message: `Deleted ${slug}.`, kind: 'success' });
			confirmDelete = null;
			await refresh();
		} catch (e: unknown) {
			showToast({ message: e instanceof Error ? e.message : 'Delete failed', kind: 'error' });
		} finally {
			busySlug = null;
		}
	}

	function handleAttachPicked(e: Event & { currentTarget: HTMLInputElement }) {
		const picked = Array.from(e.currentTarget.files ?? []);
		if (picked.length) attachments = [...attachments, ...picked];
		e.currentTarget.value = '';
	}
</script>

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-3xl px-4 py-8 sm:px-6">
		<h1 class="text-xl font-semibold text-fg">Client companies</h1>
		<p class="mt-1 text-sm text-fg-muted">
			Run several client companies from one Open Executive — one active at a time. Switching saves
			the current client's full state (chat, schedule, onboarding plans, documents, MCP tools) to
			its slot and restores the target.
		</p>

		{#if toast}
			<div
				class={`mt-4 rounded-lg border px-3 py-2 text-sm ${
					toast.kind === 'success'
						? 'border-line bg-surface-elevated text-fg'
						: 'border-red-500/40 bg-red-500/10 text-red-400'
				}`}
				role={toast.kind === 'success' ? 'status' : 'alert'}
			>
				{toast.message}
			</div>
		{/if}

		{#if status.rotation_in_progress}
			<div
				class="mt-4 rounded-lg border border-line bg-surface-elevated px-3 py-2 text-sm text-fg-muted"
			>
				Overnight rotation is running — the active client will switch briefly while parked clients
				are refreshed, then return.
			</div>
		{/if}

		{#if status.fixture_active}
			<div
				class="mt-4 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm text-amber-400"
			>
				Demo fixture <strong>{status.fixture_active}</strong> is active — unload it on the Company Simulator
				page before working with clients.
			</div>
		{/if}

		<!-- Practice cockpit — only in multi-client mode (2+ slots) -->
		{#if cockpit.length >= 2}
			<div class="mt-6 rounded-xl border border-line bg-surface-elevated p-4">
				<h2 class="text-sm font-medium text-fg">Practice cockpit</h2>
				<p class="mt-1 text-xs text-fg-muted">
					All clients at a glance. Parked clients show their state as of the last save point.
				</p>
				<div class="mt-3 grid gap-2 sm:grid-cols-2">
					{#each cockpit as c (c.slug)}
						<div
							class={`rounded-lg border p-3 ${
								c.is_active ? 'border-line-strong bg-surface-overlay' : 'border-line'
							}`}
						>
							<div class="flex items-center justify-between gap-2">
								<div class="truncate text-xs font-medium text-fg">
									{c.display_name}
									{#if c.role}
										<span class="font-normal text-fg-muted"> · {c.role}</span>
									{/if}
								</div>
								{#if c.is_active}
									<span
										class="shrink-0 rounded-full border border-emerald-500/40 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-400"
									>
										active
									</span>
								{:else}
									{@const badge = renewalBadge(c.days_to_renewal)}
									{#if badge}
										<span
											class={`shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] ${
												badge.urgent
													? 'border-red-500/40 bg-red-500/10 text-red-400'
													: 'border-amber-500/40 bg-amber-500/10 text-amber-400'
											}`}
										>
											{badge.label}
										</span>
									{/if}
								{/if}
							</div>
							<div class="mt-1 text-[11px] text-fg-muted">
								{clientCountsSummary(c)}
							</div>
							{#if c.has_state}
								<div class="mt-1.5">
									<a
										href={`/jobs/engagement_value_report?prefill=${encodePrefill({ client_slug: c.slug })}`}
										class="text-[11px] text-indigo-400 hover:text-indigo-300"
									>
										Value report →
									</a>
								</div>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		{/if}

		<!-- Create -->
		<div class="mt-6 rounded-xl border border-line bg-surface-elevated p-4">
			<h2 class="text-sm font-medium text-fg">New client</h2>
			<div class="mt-3 flex flex-col gap-2 sm:flex-row">
				<input
					bind:value={name}
					aria-label="Client company name"
					placeholder="Client company name"
					class="flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-line-strong focus:outline-none"
				/>
				<select
					value={source}
					onchange={(e) => (source = e.currentTarget.value as 'current' | 'blank')}
					aria-label="Client source"
					class="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus:outline-none"
				>
					<option value="current">From current company</option>
					<option value="blank">Blank (onboard fresh)</option>
				</select>
				<button
					type="button"
					onclick={() => void handleCreate()}
					disabled={creating || !name.trim() || !!status.fixture_active}
					class="rounded-lg border border-line bg-surface-overlay px-4 py-2 text-sm font-medium text-fg hover:border-line-strong disabled:opacity-50"
				>
					{creating ? 'Creating…' : 'Create'}
				</button>
			</div>
			<p class="mt-2 text-xs text-fg-muted">
				{source === 'current'
					? 'Captures the live company into the new client slot and makes it the active client.'
					: 'Creates an empty client. Activate it, then run company onboarding and upload its documents.'}
			</p>
		</div>

		<!-- New engagement from intake notes (AI) -->
		<div class="mt-4 rounded-xl border border-line bg-surface-elevated p-4">
			<h2 class="text-sm font-medium text-fg">New client from intake notes</h2>
			<p class="mt-1 text-xs text-fg-muted">
				Paste real intake material — call notes, a brief, website copy — or attach PDFs, Word,
				Excel, or CSV files, and the AI drafts the client's profile, org, starter documents, and
				known history. Attachments are also saved as company documents. It extracts only what the
				material says: unknowns stay blank and become open questions, and no contact details are
				ever imported.
			</p>

			{#if !draft}
				<textarea
					bind:value={notes}
					rows={5}
					aria-label="Intake notes"
					placeholder="e.g. Notes from the kickoff call with Meridian Solar: 80-person commercial solar installer in Texas, CEO Dana Reyes, struggling with project-margin visibility…"
					class="mt-3 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg placeholder:text-fg-muted focus:border-line-strong focus:outline-none"
				></textarea>

				<div class="mt-2 flex flex-wrap items-center gap-2">
					<!-- The picker itself stays hidden; a real button drives it so the
					     control keeps a visible focus target and a label. -->
					<input
						bind:this={fileInputEl}
						type="file"
						multiple
						accept=".pdf,.docx,.doc,.xlsx,.xlsm,.csv,.md,.txt"
						class="hidden"
						onchange={handleAttachPicked}
					/>
					<button
						type="button"
						onclick={() => fileInputEl?.click()}
						class="cursor-pointer rounded-lg border border-line bg-surface-overlay px-3 py-1.5 text-xs font-medium text-fg hover:border-line-strong"
					>
						Attach files
					</button>
					<span class="text-xs text-fg-muted">PDF, Word, Excel, CSV, or text</span>
				</div>

				{#if attachments.length > 0}
					<ul class="mt-2 flex flex-col gap-1">
						{#each attachments as f, i (`${f.name}-${i}`)}
							<li
								class="flex items-center justify-between gap-2 rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg"
							>
								<span class="truncate">{f.name}</span>
								<button
									type="button"
									onclick={() => (attachments = attachments.filter((_, j) => j !== i))}
									aria-label={`Remove ${f.name}`}
									class="shrink-0 text-fg-muted hover:text-fg"
								>
									×
								</button>
							</li>
						{/each}
					</ul>
				{/if}

				<button
					type="button"
					onclick={() => void handleGenerateDraft()}
					disabled={generating ||
						(!notes.trim() && attachments.length === 0) ||
						!!status.fixture_active}
					class="mt-2 rounded-lg border border-line bg-surface-overlay px-4 py-2 text-sm font-medium text-fg hover:border-line-strong disabled:opacity-50"
				>
					{generating ? 'Drafting…' : 'Draft client'}
				</button>
			{:else}
				<div class="mt-3">
					<div class="flex flex-col gap-2 sm:flex-row sm:items-center">
						<input
							bind:value={draftName}
							aria-label="Client name"
							class="flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus:border-line-strong focus:outline-none"
						/>
						<span class="text-xs text-fg-muted">
							{draft.bundle.people.length} people · {draft.bundle.departments.length} departments ·
							{draft.bundle.docs.length} docs
						</span>
					</div>
					{#if draft.bundle.people.length > 0}
						<p class="mt-2 text-xs text-fg-muted">
							Roster:
							{draft.bundle.people
								.map((p) => `${p.full_name}${p.is_principal ? ' (principal)' : ''}`)
								.join(', ')}
						</p>
					{/if}
					{#if draft.bundle.docs.length > 0}
						<p class="mt-1 text-xs text-fg-muted">
							Docs: {draft.bundle.docs.map((d) => d.filename).join(', ')}
						</p>
					{/if}
					<div class="mt-3 flex flex-wrap gap-2">
						<button
							type="button"
							onclick={() => void handleCreateFromDraft(false)}
							disabled={creatingDraft || !draftName.trim()}
							class="rounded-lg border border-line bg-surface-overlay px-4 py-2 text-sm font-medium text-fg hover:border-line-strong disabled:opacity-50"
						>
							{creatingDraft ? 'Creating…' : 'Create client'}
						</button>
						<button
							type="button"
							onclick={() => void handleCreateFromDraft(true)}
							disabled={creatingDraft || !draftName.trim()}
							class="rounded-lg border border-line bg-surface-overlay px-4 py-2 text-sm font-medium text-fg hover:border-line-strong disabled:opacity-50"
						>
							{creatingDraft ? 'Creating…' : 'Create & activate'}
						</button>
						<button
							type="button"
							onclick={() => (draft = null)}
							disabled={creatingDraft}
							class="rounded-lg border border-line px-4 py-2 text-sm text-fg-muted hover:border-line-strong disabled:opacity-50"
						>
							← Edit notes
						</button>
					</div>
				</div>
			{/if}
		</div>

		<!-- List -->
		{#if loading}
			<p class="mt-6 text-sm text-fg-muted" role="status">Loading clients…</p>
		{:else if status.clients.length === 0}
			<p class="mt-6 text-sm text-fg-muted">
				No clients yet. Create one from your current company to enter multi-client mode —
				single-company use is unaffected until you do.
			</p>
		{:else}
			<div class="mt-6 space-y-3">
				{#each status.clients as c (c.slug)}
					{@const isActive = c.slug === status.active}
					{@const busy = busySlug === c.slug}
					<div
						class={`rounded-xl border p-4 ${
							isActive ? 'border-line-strong bg-surface-overlay' : 'border-line bg-surface-elevated'
						}`}
					>
						<div class="flex items-center justify-between gap-3">
							<div class="min-w-0">
								<div class="flex items-center gap-2">
									<h3 class="truncate text-sm font-medium text-fg">{c.display_name}</h3>
									{#if isActive}
										<span
											class="rounded-full border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-400"
										>
											active
										</span>
									{/if}
									{#if c.has_mcp_config}
										<span
											class="rounded-full border border-line px-2 py-0.5 text-[10px] font-medium text-fg-muted"
										>
											MCP tools
										</span>
									{/if}
								</div>
								<p class="mt-1 text-xs text-fg-muted">
									{slotSummary(c)}
								</p>
							</div>
							<div class="flex shrink-0 items-center gap-2">
								{#if isActive}
									<button
										type="button"
										onclick={() => void handleSave()}
										disabled={busy || !!status.fixture_active}
										class="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fg hover:border-line-strong disabled:opacity-50"
									>
										{busy ? 'Saving…' : 'Save now'}
									</button>
								{:else}
									<button
										type="button"
										onclick={() => void handleActivate(c.slug)}
										disabled={busy || !!status.fixture_active}
										class="rounded-lg border border-line bg-surface-overlay px-3 py-1.5 text-xs font-medium text-fg hover:border-line-strong disabled:opacity-50"
									>
										{busy ? 'Switching…' : 'Activate'}
									</button>
									{#if confirmDelete === c.slug}
										<button
											type="button"
											onclick={() => void handleDelete(c.slug)}
											disabled={busy}
											class="rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium text-red-400 disabled:opacity-50"
										>
											Confirm delete
										</button>
									{:else}
										<button
											type="button"
											onclick={() => (confirmDelete = c.slug)}
											disabled={busy}
											aria-label={`Delete ${c.display_name}`}
											class="rounded-lg border border-line px-2 py-1.5 text-xs text-fg-muted hover:border-line-strong disabled:opacity-50"
										>
											<Icon name="trash" size="w-3.5 h-3.5" />
										</button>
									{/if}
								{/if}
							</div>
						</div>
						<div class="mt-2">
							{#if editingSlug === c.slug}
								<div class="grid gap-2 rounded-lg border border-line bg-surface p-3 sm:grid-cols-2">
									<input
										bind:value={metaForm.role}
										aria-label="Your role"
										placeholder="Your role (e.g. Fractional CFO)"
										class="rounded border border-line bg-surface-elevated px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:outline-none"
									/>
									<select
										bind:value={metaForm.status}
										aria-label="Engagement status"
										class="rounded border border-line bg-surface-elevated px-2 py-1.5 text-xs text-fg focus:outline-none"
									>
										<option value="active">active</option>
										<option value="paused">paused</option>
										<option value="winding_down">winding down</option>
										<option value="completed">completed</option>
									</select>
									<label class="flex items-center gap-2 text-[11px] text-fg-muted">
										Renewal
										<input
											type="date"
											bind:value={metaForm.renewal_date}
											class="flex-1 rounded border border-line bg-surface-elevated px-2 py-1.5 text-xs text-fg focus:outline-none"
										/>
									</label>
									<input
										bind:value={metaForm.retainer}
										aria-label="Retainer"
										placeholder="Retainer (display only)"
										class="rounded border border-line bg-surface-elevated px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:outline-none"
									/>
									<input
										bind:value={metaForm.primary_contact}
										aria-label="Primary contact"
										placeholder="Primary contact"
										class="rounded border border-line bg-surface-elevated px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:outline-none"
									/>
									<input
										bind:value={metaForm.notes}
										aria-label="Notes"
										placeholder="Notes"
										class="rounded border border-line bg-surface-elevated px-2 py-1.5 text-xs text-fg placeholder:text-fg-muted focus:outline-none"
									/>
									<div class="flex gap-2 sm:col-span-2">
										<button
											type="button"
											onclick={() => void handleSaveMeta()}
											disabled={savingMeta}
											class="rounded-lg border border-line bg-surface-overlay px-3 py-1.5 text-xs font-medium text-fg hover:border-line-strong disabled:opacity-50"
										>
											{savingMeta ? 'Saving…' : 'Save details'}
										</button>
										<button
											type="button"
											onclick={() => (editingSlug = null)}
											disabled={savingMeta}
											class="rounded-lg border border-line px-3 py-1.5 text-xs text-fg-muted hover:border-line-strong"
										>
											Cancel
										</button>
									</div>
								</div>
							{:else}
								<button
									type="button"
									onclick={() => openMetaEditor(c.slug)}
									class="text-[11px] text-indigo-400 hover:text-indigo-300"
								>
									Engagement details
								</button>
							{/if}
						</div>
					</div>
				{/each}
			</div>
		{/if}

		<p class="mt-8 text-xs leading-relaxed text-fg-muted">
			Only the active client is live — its scheduled actions fire and its documents are indexed;
			parked clients sleep in their slots. Your original company is preserved automatically the
			first time you switch, and can be restored from the Company Simulator page.
		</p>
	</div>
</main>

<script module>
	function formatARR(arr: number | null): string {
		if (arr == null) return '—';
		if (arr >= 1_000_000_000) return `$${(arr / 1_000_000_000).toFixed(1)}B`;
		if (arr >= 1_000_000) return `$${(arr / 1_000_000).toFixed(0)}M`;
		if (arr >= 1_000) return `$${(arr / 1_000).toFixed(0)}K`;
		return `$${arr.toFixed(0)}`;
	}

	const STAGE_COLORS: Record<string, string> = {
		Seed: 'bg-amber-500/15 text-amber-400 border-amber-500/30',
		'Seed to Series A': 'bg-amber-500/15 text-amber-400 border-amber-500/30',
		'Pre-Series B': 'bg-amber-500/15 text-amber-400 border-amber-500/30',
		'Series A': 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
		'Series B': 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30',
		Growth: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
		'Post-Deal Growth': 'bg-violet-500/15 text-violet-400 border-violet-500/30',
		'Post-Deal': 'bg-violet-500/15 text-violet-400 border-violet-500/30'
	};
</script>

<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import type { CreateFixtureResult, FixtureStatus, FixtureSummary } from '$lib/api.js';
	import {
		deleteFixture,
		getFixtureStatus,
		listFixtures,
		loadFixture,
		resetAllState,
		snapshotCurrentState,
		unloadFixture
	} from '$lib/api.js';
	import CreateFixtureDialog from '$lib/components/demo/CreateFixtureDialog.svelte';

	const RESET_CONFIRM_TOKEN = 'RESET';

	let fixtures = $state.raw<FixtureSummary[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);
	let loadingFixture = $state<string | null>(null);
	let status = $state<FixtureStatus>({ active_fixture: null, has_snapshot: false });
	let busy = $state(false);
	let toast = $state<{ message: string; kind: 'success' | 'error' } | null>(null);
	let resetOpen = $state(false);
	let resetConfirmText = $state('');
	let resetInput = $state<HTMLInputElement | undefined>(undefined);
	let deletingName = $state<string | null>(null);
	let createOpen = $state(false);

	// Upstream armed a 4s timer in an effect keyed on `toast`; arming it in the
	// mutating helper keeps the same auto-dismiss without an effect.
	let toastTimer: ReturnType<typeof setTimeout> | undefined;

	function showToast(message: string, kind: 'success' | 'error') {
		toast = { message, kind };
		clearTimeout(toastTimer);
		toastTimer = setTimeout(() => (toast = null), 4000);
	}

	onDestroy(() => clearTimeout(toastTimer));

	async function refreshFixtures() {
		try {
			fixtures = await listFixtures();
		} catch {
			// tolerate transient failures — keep last-known list
		}
	}

	async function refreshStatus() {
		try {
			status = await getFixtureStatus();
		} catch {
			// tolerate transient failures — UI state stays as last known
		}
	}

	onMount(() => {
		Promise.all([
			listFixtures(),
			getFixtureStatus().catch((): FixtureStatus => ({ active_fixture: null, has_snapshot: false }))
		])
			.then(([fx, st]) => {
				fixtures = fx;
				status = st;
			})
			.catch((e: Error) => (error = e.message))
			.finally(() => (loading = false));
	});

	// Upstream `handleSaveDraft` lived in the page; the dialog hands the saved
	// fixture back so the toast, list refresh and optional load stay here.
	async function handleSaved(result: CreateFixtureResult, thenLoad: boolean) {
		showToast(`Saved ${result.display_name}${thenLoad ? ' — loading…' : ''}`, 'success');
		await refreshFixtures();
		if (thenLoad) await handleLoad(result.name);
	}

	async function handleLoad(name: string) {
		loadingFixture = name;
		try {
			const result = await loadFixture(name);
			const mem = result.memory_seeded;
			const memTotal = (mem.decisions ?? 0) + (mem.initiatives ?? 0) + (mem.advice_given ?? 0);
			showToast(
				`Loaded ${result.display_name} — ${result.docs_indexed} chunks indexed, ${memTotal} memory items seeded`,
				'success'
			);
			await refreshStatus();
		} catch (e: unknown) {
			showToast(e instanceof Error ? e.message : 'Failed to load fixture', 'error');
		} finally {
			loadingFixture = null;
		}
	}

	async function handleDelete(name: string) {
		deletingName = name;
		try {
			await deleteFixture(name);
			showToast(`Deleted ${name}`, 'success');
			await refreshFixtures();
			await refreshStatus();
		} catch (e: unknown) {
			showToast(e instanceof Error ? e.message : 'Delete failed', 'error');
		} finally {
			deletingName = null;
		}
	}

	async function handleSnapshot() {
		busy = true;
		try {
			const r = await snapshotCurrentState();
			showToast(
				`Snapshot saved — ${r.people_snapshotted} people, ${r.departments_snapshotted} departments, ${r.docs_snapshotted} docs`,
				'success'
			);
			await refreshStatus();
		} catch (e: unknown) {
			showToast(e instanceof Error ? e.message : 'Snapshot failed', 'error');
		} finally {
			busy = false;
		}
	}

	async function handleUnload() {
		busy = true;
		try {
			const r = await unloadFixture();
			showToast(
				`Restored your company — ${r.docs_indexed} chunks reindexed, ${r.people_seeded} people`,
				'success'
			);
			await refreshStatus();
		} catch (e: unknown) {
			showToast(e instanceof Error ? e.message : 'Unload failed', 'error');
		} finally {
			busy = false;
		}
	}

	// Upstream put `autoFocus` on the confirm input; focusing after the tick that
	// mounts it keeps that behaviour without an effect.
	async function openReset() {
		resetOpen = true;
		await tick();
		resetInput?.focus();
	}

	async function handleReset() {
		busy = true;
		try {
			const r = await resetAllState();
			showToast(
				`Reset complete — ${r.departments_seeded} default departments seeded, snapshot wiped`,
				'success'
			);
			resetOpen = false;
			resetConfirmText = '';
			await refreshStatus();
		} catch (e: unknown) {
			showToast(e instanceof Error ? e.message : 'Reset failed', 'error');
		} finally {
			busy = false;
		}
	}
</script>

{#if toast}
	<div
		class={`fixed bottom-6 left-1/2 z-50 max-w-md -translate-x-1/2 rounded-lg border px-4 py-3 text-center text-sm font-medium shadow-lg ${
			toast.kind === 'success'
				? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
				: 'border-red-500/30 bg-red-500/10 text-red-300'
		}`}
		role={toast.kind === 'error' ? 'alert' : 'status'}
	>
		{toast.message}
	</div>
{/if}

<main class="min-h-0 flex-1 overflow-y-auto">
	<div
		class="flex flex-wrap items-start justify-between gap-4 border-b border-line px-4 py-5 sm:px-6"
	>
		<div class="min-w-0">
			<h1 class="text-xl font-semibold text-fg">Company Simulator</h1>
			<p class="mt-1 text-xs text-fg-muted">
				Put the Executive in a real-world scenario. Load a simulated company — full profile,
				documents, and memory — and test how it reasons, prioritizes, and decides before you trust
				it with your own.
			</p>
		</div>
		<button
			type="button"
			onclick={() => (createOpen = true)}
			class="shrink-0 cursor-pointer rounded-lg border border-indigo-500/30 bg-indigo-500/15 px-3 py-2 text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-500/25"
		>
			✨ Create with AI
		</button>
	</div>

	<!-- Body -->
	<div class="mx-auto max-w-4xl px-4 py-6 sm:px-6">
		{#if loading}
			<p class="text-sm text-fg-muted" role="status">Loading fixtures…</p>
		{/if}
		{#if error}
			<p class="text-sm text-red-400" role="alert">Error: {error}. Is the backend running?</p>
		{/if}

		<!-- Active-fixture banner -->
		{#if !loading && status.active_fixture}
			<div
				class="mb-5 flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
			>
				<div class="min-w-0 flex-1 text-xs text-amber-200">
					<span class="font-medium">Simulated company active:</span>
					<span class="font-mono text-amber-100">{status.active_fixture}</span>
					{#if !status.has_snapshot}
						<span class="mt-1 block text-amber-300/80">
							No snapshot of your original company exists — unload won't restore anything.
						</span>
					{/if}
					{#if status.has_snapshot}
						<span class="mt-1 block text-amber-300/80">
							Snapshotting is disabled while a fixture is active — unload first to capture your real
							state.
						</span>
					{/if}
				</div>
				<div class="flex items-center gap-2">
					{#if status.has_snapshot}
						<button
							type="button"
							disabled={busy}
							onclick={() => void handleUnload()}
							class="cursor-pointer rounded-lg border border-emerald-500/30 bg-emerald-500/15 px-3 py-1.5 text-xs font-medium text-emerald-200 transition-colors hover:bg-emerald-500/25 disabled:cursor-not-allowed disabled:opacity-50"
						>
							{busy ? 'Working…' : 'Unload to my company'}
						</button>
					{/if}
				</div>
			</div>
		{/if}

		<!-- Snapshot CTA when no fixture is active -->
		{#if !loading && !status.active_fixture && !error && fixtures.length > 0}
			<div
				class="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface-elevated px-4 py-3"
			>
				<p class="min-w-0 flex-1 text-xs text-fg-muted">
					{#if status.has_snapshot}
						Snapshot of your company exists. Loading a fixture will replace state; unload restores
						from the snapshot.
					{:else}
						No snapshot of your company yet. Loading a fixture will auto-snapshot first. You can
						also snapshot manually now.
					{/if}
				</p>
				<button
					type="button"
					disabled={busy}
					onclick={() => void handleSnapshot()}
					class="cursor-pointer rounded-lg border border-line bg-surface-overlay px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-surface-input disabled:cursor-not-allowed disabled:opacity-50"
				>
					{busy ? 'Working…' : 'Snapshot current as my company'}
				</button>
			</div>
		{/if}

		{#if !loading && !error && fixtures.length === 0}
			<p class="text-sm text-fg-muted">
				No fixtures found. Add company directories to
				<code class="rounded bg-surface-overlay px-1 py-0.5 text-xs">fixtures/companies/</code>.
			</p>
		{/if}

		{#if !loading && fixtures.length > 0}
			<p class="mb-4 text-xs text-fg-muted">
				{fixtures.length} fixture{fixtures.length !== 1 ? 's' : ''} available — click Load to replace
				the active company context.
			</p>
			<div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
				{#each fixtures as fx (fx.name)}
					{@const isActive = status.active_fixture === fx.name}
					{@const isLoading = loadingFixture === fx.name}
					{@const stageCls =
						STAGE_COLORS[fx.stage] ?? 'bg-surface-overlay text-fg-muted border-line'}
					<div
						class={`flex flex-col gap-3 rounded-xl border p-4 transition-colors ${
							isActive ? 'border-indigo-500/40 bg-indigo-500/5' : 'border-line bg-surface-elevated'
						}`}
					>
						<!-- Top row -->
						<div class="flex items-start justify-between gap-2">
							<div class="min-w-0">
								<div class="flex flex-wrap items-center gap-2">
									<h2 class="truncate text-sm font-semibold text-fg">{fx.display_name}</h2>
									{#if isActive}
										<span
											class="rounded-full border border-indigo-500/30 bg-indigo-500/20 px-2 py-0.5 text-[10px] font-medium text-indigo-300"
										>
											Active
										</span>
									{/if}
									{#if fx.source === 'generated'}
										<span
											class="rounded-full border border-violet-500/30 bg-violet-500/15 px-2 py-0.5 text-[10px] font-medium text-violet-300"
										>
											AI
										</span>
									{/if}
								</div>
								<p class="mt-0.5 truncate text-xs text-fg-muted">{fx.industry}</p>
							</div>
							<div class="flex shrink-0 items-center gap-1.5">
								<span class={`rounded-full border px-2 py-0.5 text-[10px] font-medium ${stageCls}`}>
									{fx.stage}
								</span>
								{#if fx.source === 'generated'}
									<button
										type="button"
										title="Delete this generated fixture"
										disabled={deletingName === fx.name || isActive}
										onclick={() => void handleDelete(fx.name)}
										class="cursor-pointer rounded-md border border-red-500/30 bg-red-500/10 px-1.5 py-0.5 text-[10px] font-medium text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-40"
									>
										{deletingName === fx.name ? '…' : 'Delete'}
									</button>
								{/if}
							</div>
						</div>

						<!-- Mission -->
						{#if fx.mission}
							<p class="line-clamp-2 text-xs leading-relaxed text-fg-muted">{fx.mission}</p>
						{/if}

						<!-- Stats row -->
						<div class="flex items-center gap-4 text-xs text-fg-muted">
							<span><span class="font-medium text-fg">{formatARR(fx.arr)}</span> ARR</span>
							{#if fx.headcount}
								<span><span class="font-medium text-fg">{fx.headcount}</span> people</span>
							{/if}
							<span><span class="font-medium text-fg">{fx.doc_count}</span> docs</span>
						</div>

						<!-- Org snapshot — departments + leadership -->
						{#if fx.departments.length > 0 || fx.people.length > 0}
							<div class="flex flex-col gap-3 border-t border-line/60 pt-3">
								{#if fx.departments.length > 0}
									<div>
										<p
											class="mb-1.5 text-[10px] font-medium tracking-wider text-fg-subtle uppercase"
										>
											Departments · {fx.departments.length}
										</p>
										<div class="flex flex-wrap gap-1">
											{#each fx.departments.slice(0, 6) as d, i (i)}
												<span
													title={d.head ? `${d.title} — led by ${d.head}` : d.title}
													class="rounded-md border border-line bg-surface-overlay px-1.5 py-1 text-[10px] leading-none text-fg-muted"
												>
													{d.title}
												</span>
											{/each}
											{#if fx.departments.length > 6}
												<span class="px-1.5 py-1 text-[10px] leading-none text-fg-subtle">
													+{fx.departments.length - 6} more
												</span>
											{/if}
										</div>
									</div>
								{/if}

								{#if fx.people.length > 0}
									<div>
										<p
											class="mb-1.5 text-[10px] font-medium tracking-wider text-fg-subtle uppercase"
										>
											Leadership · {fx.people.length}
										</p>
										<ul class="flex flex-col gap-1">
											{#each fx.people.slice(0, 5) as p, i (i)}
												<li class="flex min-w-0 items-baseline gap-1.5 text-[11px]">
													<span class="font-medium whitespace-nowrap text-fg">{p.name}</span>
													{#if p.is_principal}
														<span
															class="rounded border border-indigo-500/30 bg-indigo-500/15 px-1 py-px text-[9px] tracking-wide whitespace-nowrap text-indigo-300 uppercase"
														>
															Principal
														</span>
													{/if}
													{#if p.role}
														<span class="truncate text-fg-subtle">{p.role}</span>
													{/if}
												</li>
											{/each}
										</ul>
									</div>
								{/if}
							</div>
						{/if}

						<!-- Load button -->
						<button
							type="button"
							disabled={isLoading || loadingFixture !== null}
							onclick={() => void handleLoad(fx.name)}
							class={`mt-auto w-full cursor-pointer rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${
								isActive
									? 'border-indigo-500/30 bg-indigo-500/20 text-indigo-300 hover:bg-indigo-500/30'
									: 'border-line bg-surface-overlay text-fg hover:bg-surface-input'
							} disabled:cursor-not-allowed disabled:opacity-50`}
						>
							{#if isLoading}
								<span class="flex items-center justify-center gap-1.5">
									<span
										class="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"
									></span>
									Loading…
								</span>
							{:else if isActive}
								Reload
							{:else}
								Load
							{/if}
						</button>
					</div>
				{/each}
			</div>

			{#if status.active_fixture}
				<div class="mt-6 flex items-center gap-3">
					<p class="text-xs text-fg-muted">
						Company context loaded. Head to the chat to ask questions.
					</p>
					<a
						href="/"
						class="cursor-pointer text-xs font-medium whitespace-nowrap text-indigo-400 transition-colors hover:text-indigo-300"
					>
						Open chat →
					</a>
				</div>
			{/if}

			<!-- Danger zone — reset everything -->
			<div class="mt-10 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
				<div class="flex flex-wrap items-start justify-between gap-3">
					<div class="min-w-0">
						<h3 class="text-xs font-semibold text-red-300">Danger zone — Reset everything</h3>
						<p class="mt-1 text-xs leading-relaxed text-fg-muted">
							Clears your live company data <em>and</em> the snapshot. Re-seeds the 8 default specialist
							departments so you start from a sensible blank slate. There is no undo.
						</p>
					</div>
					{#if !resetOpen}
						<button
							type="button"
							disabled={busy}
							onclick={() => void openReset()}
							class="cursor-pointer rounded-lg border border-red-500/40 bg-red-500/10 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-red-300 transition-colors hover:bg-red-500/20 disabled:cursor-not-allowed disabled:opacity-50"
						>
							Reset everything
						</button>
					{/if}
				</div>

				{#if resetOpen}
					<div class="mt-4 flex flex-wrap items-center gap-2">
						<label class="text-xs whitespace-nowrap text-fg-muted" for="reset-confirm-input">
							Type <code class="font-mono text-red-300">{RESET_CONFIRM_TOKEN}</code> to confirm:
						</label>
						<input
							id="reset-confirm-input"
							bind:this={resetInput}
							type="text"
							bind:value={resetConfirmText}
							disabled={busy}
							placeholder={RESET_CONFIRM_TOKEN}
							class="rounded-md border border-line bg-surface-input px-2 py-1.5 font-mono text-xs text-fg placeholder:text-fg-subtle focus:border-red-500/50 focus:outline-none disabled:opacity-50"
						/>
						<button
							type="button"
							disabled={busy || resetConfirmText !== RESET_CONFIRM_TOKEN}
							onclick={() => void handleReset()}
							class="cursor-pointer rounded-lg border border-red-500/40 bg-red-500/20 px-3 py-1.5 text-xs font-medium whitespace-nowrap text-red-200 transition-colors hover:bg-red-500/30 disabled:cursor-not-allowed disabled:opacity-30"
						>
							{busy ? 'Resetting…' : 'Confirm reset'}
						</button>
						<button
							type="button"
							disabled={busy}
							onclick={() => {
								resetOpen = false;
								resetConfirmText = '';
							}}
							class="cursor-pointer rounded-lg border border-line bg-surface-overlay px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
						>
							Cancel
						</button>
					</div>
				{/if}
			</div>
		{/if}
	</div>
</main>

<CreateFixtureDialog
	bind:open={createOpen}
	onSaved={handleSaved}
	onFailed={(message) => showToast(message, 'error')}
/>

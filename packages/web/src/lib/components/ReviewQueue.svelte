<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import * as Sheet from '$lib/components/ui/sheet/index.js';
	import * as Tabs from '$lib/components/ui/tabs/index.js';
	import type {
		ExternalPeekChunk,
		ReviewAnnotation,
		ReviewItem,
		ReviewItemDetail,
		ReviewPriority,
		ReviewStatus
	} from '$lib/api.js';
	import {
		addAnnotation,
		bulkApproveReviewItems,
		deleteAnnotation,
		getBuiltinFile,
		getReviewItem,
		listAllAnnotations,
		listItemAnnotations,
		listReviewItems,
		patchAnnotation,
		patchReviewItem,
		peekExternalSource,
		updateBuiltinFile
	} from '$lib/api.js';

	// ---------------------------------------------------------------------------
	// Helpers
	// ---------------------------------------------------------------------------

	const STATUS_LABELS: Record<ReviewStatus, string> = {
		pending: 'Pending',
		approved: 'Approved',
		rejected: 'Rejected',
		needs_revision: 'Needs revision'
	};

	const STATUS_CLASSES: Record<ReviewStatus, string> = {
		pending: 'bg-amber-950/60 text-amber-400 border border-amber-900/60',
		approved: 'bg-emerald-950/60 text-emerald-400 border border-emerald-900/60',
		rejected: 'bg-red-950/60 text-red-400 border border-red-900/60',
		needs_revision: 'bg-violet-950/60 text-violet-400 border border-violet-900/60'
	};

	const PRIORITY_CLASSES: Record<ReviewPriority, string> = {
		high: 'bg-blue-950/60 text-blue-400 border border-blue-900/60',
		normal: '',
		low: 'bg-surface-overlay/60 text-fg-muted border border-line-strong/60'
	};

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleDateString(undefined, {
			month: 'short',
			day: 'numeric',
			year: 'numeric'
		});
	}

	type Tab = 'queue' | 'all' | 'annotations';

	// ---------------------------------------------------------------------------
	// Queue state
	// ---------------------------------------------------------------------------

	let tab = $state<Tab>('queue');
	// Big API payloads that are only ever replaced wholesale — `$state.raw` keeps
	// them out of the deep-proxy path.
	let items = $state.raw<ReviewItem[]>([]);
	let allItems = $state.raw<ReviewItem[]>([]);
	let annotations = $state.raw<ReviewAnnotation[]>([]);
	let loading = $state(true);
	let filterStatus = $state<ReviewStatus | ''>('');
	let filterDomain = $state('');
	let filterType = $state<'builtin' | 'external' | ''>('');
	let selectedItemId = $state<string | null>(null);
	let rejectModal = $state<{ itemId: string; notes: string } | null>(null);

	async function loadQueue() {
		loading = true;
		try {
			const [pending, needsRevision] = await Promise.all([
				listReviewItems({ status: 'pending', limit: 200 }),
				listReviewItems({ status: 'needs_revision', limit: 200 })
			]);
			items = [...pending, ...needsRevision];
		} finally {
			loading = false;
		}
	}

	async function loadAll(
		status: ReviewStatus | '',
		domain: string,
		type: 'builtin' | 'external' | ''
	) {
		loading = true;
		try {
			allItems = await listReviewItems({
				status: status || undefined,
				domain: domain || undefined,
				content_type: type || undefined,
				limit: 500
			});
		} finally {
			loading = false;
		}
	}

	async function loadAnnotations() {
		loading = true;
		try {
			annotations = await listAllAnnotations(true);
		} finally {
			loading = false;
		}
	}

	// Upstream loaded per tab via useEffect([tab, loadQueue, loadAll, loadAnnotations]),
	// with the "All items" filters as deps of loadAll. A rune-free equivalent: the tab
	// strip and the three filter selects are the only things that can change either,
	// so they call the loader directly from their handlers (the initial queue load
	// runs once on mount).
	onMount(() => {
		void loadQueue();
	});

	async function selectTab(next: Tab) {
		tab = next;
		if (next === 'queue') await loadQueue();
		else if (next === 'all') await loadAll(filterStatus, filterDomain, filterType);
		else await loadAnnotations();
	}

	// The "All items" tab reloads whenever a filter changes; these handlers set the
	// filter first, so applyFilters reads the new value.
	function applyFilters() {
		void loadAll(filterStatus, filterDomain, filterType);
	}

	function setStatusFilter(value: ReviewStatus | '') {
		filterStatus = value;
		applyFilters();
	}

	function setDomainFilter(value: string) {
		filterDomain = value;
		applyFilters();
	}

	function setTypeFilter(value: 'builtin' | 'external' | '') {
		filterType = value;
		applyFilters();
	}

	async function handleApprove(item: ReviewItem) {
		const updated = await patchReviewItem(item.item_id, { status: 'approved' });
		items = items.filter((i) => i.item_id !== item.item_id);
		allItems = allItems.map((i) => (i.item_id === updated.item_id ? updated : i));
	}

	async function handleFlag(item: ReviewItem) {
		const updated = await patchReviewItem(item.item_id, { status: 'needs_revision' });
		items = items.map((i) => (i.item_id === updated.item_id ? updated : i));
		allItems = allItems.map((i) => (i.item_id === updated.item_id ? updated : i));
	}

	function openRejectModal(itemId: string) {
		rejectModal = { itemId, notes: '' };
	}

	async function handleRejectConfirm() {
		const modal = rejectModal;
		if (!modal) return;
		const updated = await patchReviewItem(modal.itemId, {
			status: 'rejected',
			reviewer_notes: modal.notes
		});
		items = items.filter((i) => i.item_id !== modal.itemId);
		allItems = allItems.map((i) => (i.item_id === updated.item_id ? updated : i));
		rejectModal = null;
	}

	async function handlePriorityChange(item: ReviewItem, priority: ReviewPriority) {
		const updated = await patchReviewItem(item.item_id, { priority });
		items = items.map((i) => (i.item_id === updated.item_id ? updated : i));
		allItems = allItems.map((i) => (i.item_id === updated.item_id ? updated : i));
	}

	async function handleBulkApprove(domain?: string) {
		await bulkApproveReviewItems(domain);
		await loadQueue();
		await loadAll(filterStatus, filterDomain, filterType);
	}

	function handleItemUpdated(updated: ReviewItem) {
		items = items.map((i) => (i.item_id === updated.item_id ? updated : i));
		allItems = allItems.map((i) => (i.item_id === updated.item_id ? updated : i));
	}

	// Unique domains from current list
	const domains = $derived(Array.from(new Set(allItems.map((i) => i.domain))).sort());

	// ---------------------------------------------------------------------------
	// Slide-over detail panel
	//
	// Its state lives up here: a Svelte file holds exactly one component, so the
	// panel is a template snippet that shares this scope. Upstream reset its
	// content state in an effect keyed on the item id; openItem does that reset
	// imperatively instead, keeping the detail fetch, the builtin file fetch and
	// the external chunk fetch in the same call order upstream's three effects ran.
	// ---------------------------------------------------------------------------

	let detail = $state<ReviewItemDetail | null>(null);
	let content = $state<string | null>(null);
	let contentLoading = $state(false);
	let contentError = $state(false);
	let editing = $state(false);
	let editDraft = $state('');
	let saving = $state(false);
	let newCorrection = $state('');
	let addingAnnotation = $state(false);
	let notes = $state('');
	let externalChunks = $state.raw<ExternalPeekChunk[]>([]);
	let externalChunkLimit = $state(10);
	let loadingChunks = $state(false);

	function resetContentState() {
		content = null;
		contentLoading = false;
		contentError = false;
		externalChunks = [];
		externalChunkLimit = 10;
		loadingChunks = false;
	}

	async function loadBuiltinContent(item: ReviewItem) {
		const [, domain, filename] = item.item_id.split(':');
		contentLoading = true;
		contentError = false;
		content = null;
		try {
			const f = await getBuiltinFile(domain, filename);
			content = f.content;
		} catch {
			content = null;
			contentError = true;
		} finally {
			contentLoading = false;
		}
	}

	async function loadExternalChunks(sourceId: string, limit: number) {
		loadingChunks = true;
		try {
			const r = await peekExternalSource(sourceId, limit);
			externalChunks = r.chunks;
		} catch {
			externalChunks = [];
		} finally {
			loadingChunks = false;
		}
	}

	async function openItem(itemId: string) {
		selectedItemId = itemId;
		detail = null;
		notes = '';
		editing = false;
		editDraft = '';
		newCorrection = '';
		resetContentState();
		try {
			const d = await getReviewItem(itemId);
			// A second row can be opened while this is in flight — whichever item
			// is selected last wins.
			if (selectedItemId !== itemId) return;
			detail = d;
			notes = d.item.reviewer_notes;
			if (d.item.content_type === 'builtin') await loadBuiltinContent(d.item);
			else if (d.item.content_type === 'external')
				await loadExternalChunks(d.item.filename, externalChunkLimit);
		} catch {
			// Upstream had no catch here either: the panel stays on "Loading…".
		}
	}

	function closeItem() {
		selectedItemId = null;
		detail = null;
		notes = '';
		editing = false;
		editDraft = '';
		newCorrection = '';
		resetContentState();
	}

	async function loadMoreChunks() {
		if (!detail) return;
		externalChunkLimit += 10;
		await loadExternalChunks(detail.item.filename, externalChunkLimit);
	}

	async function refreshAnnotations() {
		if (!selectedItemId) return;
		const anns = await listItemAnnotations(selectedItemId);
		if (detail) detail = { ...detail, annotations: anns };
	}

	async function handleSaveEdit() {
		if (!detail || editDraft === content) {
			editing = false;
			return;
		}
		const itemId = detail.item.item_id;
		saving = true;
		try {
			const [, domain, filename] = itemId.split(':');
			await updateBuiltinFile(domain, filename, editDraft);
			content = editDraft;
			editing = false;
			// Reload item — status will have reset to needs_revision server-side
			const updated = await getReviewItem(itemId);
			detail = updated;
			handleItemUpdated(updated.item);
		} finally {
			saving = false;
		}
	}

	async function handleAddAnnotation() {
		if (!selectedItemId || !newCorrection.trim()) return;
		addingAnnotation = true;
		try {
			await addAnnotation(selectedItemId, newCorrection.trim());
			newCorrection = '';
			await refreshAnnotations();
		} finally {
			addingAnnotation = false;
		}
	}

	async function handleToggleAnnotation(ann: ReviewAnnotation) {
		await patchAnnotation(ann.annotation_id, { is_active: !ann.is_active });
		await refreshAnnotations();
	}

	async function handleDeleteAnnotation(annId: string) {
		await deleteAnnotation(annId);
		await refreshAnnotations();
	}

	async function handleSaveNotes() {
		if (!detail || !selectedItemId) return;
		const updated = await patchReviewItem(selectedItemId, { reviewer_notes: notes });
		detail = { ...detail, item: updated };
		handleItemUpdated(updated);
	}
</script>

{#snippet statusPill(status: ReviewStatus)}
	<span class={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${STATUS_CLASSES[status]}`}>
		{STATUS_LABELS[status]}
	</span>
{/snippet}

{#snippet priorityPill(priority: ReviewPriority)}
	{#if priority !== 'normal'}
		<span
			class={`rounded-full px-1.5 py-0.5 text-[10px] font-medium ${PRIORITY_CLASSES[priority]}`}
		>
			{priority === 'high' ? '↑ High priority' : '↓ Low priority'}
		</span>
	{/if}
{/snippet}

{#snippet itemRow(item: ReviewItem)}
	<div
		class="flex items-center gap-3 rounded-lg border border-line bg-surface-elevated/40 px-4 py-3"
	>
		<div class="shrink-0 text-fg-subtle">
			<Icon name={item.content_type === 'builtin' ? 'clipboard' : 'book'} size="w-4 h-4" />
		</div>

		<div class="min-w-0 flex-1">
			<div class="flex flex-wrap items-center gap-2">
				<span class="truncate text-sm font-medium text-fg">{item.filename}</span>
				<span
					class="rounded border border-line-strong bg-surface-overlay px-1.5 py-0.5 text-[10px] text-fg-muted"
					>{item.domain}</span
				>
				{@render statusPill(item.status)}
				{@render priorityPill(item.priority)}
			</div>
			<p class="mt-0.5 text-[11px] text-fg-subtle">Added {formatDate(item.registered_at)}</p>
		</div>

		<select
			value={item.priority}
			onchange={(e) => void handlePriorityChange(item, e.currentTarget.value as ReviewPriority)}
			class="rounded-lg border border-line-strong bg-surface-elevated px-2 py-1 text-[10px] text-fg-muted focus:border-indigo-500 focus:outline-none"
			title="Set priority"
			aria-label="Set priority"
		>
			<option value="low">↓ Low</option>
			<option value="normal">Normal</option>
			<option value="high">↑ High</option>
		</select>

		<div class="flex shrink-0 items-center gap-1">
			<button
				type="button"
				onclick={() => void openItem(item.item_id)}
				class="rounded-lg border border-line-strong bg-surface-overlay px-2 py-1 text-[10px] text-fg-muted transition-colors hover:bg-surface-input hover:text-fg"
			>
				View
			</button>
			{#if item.status !== 'approved'}
				<button
					type="button"
					onclick={() => void handleApprove(item)}
					class="rounded-lg border border-emerald-900/60 bg-emerald-950/40 px-2 py-1 text-[10px] text-emerald-400 transition-colors hover:bg-emerald-950/60 hover:text-emerald-300"
				>
					Approve
				</button>
			{/if}
			{#if item.status !== 'needs_revision'}
				<button
					type="button"
					onclick={() => void handleFlag(item)}
					class="rounded-lg border border-violet-900/60 bg-violet-950/40 px-2 py-1 text-[10px] text-violet-400 transition-colors hover:bg-violet-950/60 hover:text-violet-300"
				>
					Flag
				</button>
			{/if}
			{#if item.status !== 'rejected'}
				<button
					type="button"
					onclick={() => openRejectModal(item.item_id)}
					class="rounded-lg border border-red-900/60 bg-red-950/40 px-2 py-1 text-[10px] text-red-400 transition-colors hover:bg-red-950/60 hover:text-red-300"
				>
					Reject
				</button>
			{/if}
		</div>
	</div>
{/snippet}

<div class="p-6">
	<Tabs.Root value={tab} onValueChange={(v) => void selectTab(v as Tab)}>
		<Tabs.List variant="line" class="mb-6 w-full justify-start gap-1 border-b border-line pb-0">
			<Tabs.Trigger
				value="queue"
				class="flex-none px-4 py-2 text-sm font-medium text-fg-muted after:bg-indigo-500 hover:text-fg data-active:text-fg"
				>Review queue</Tabs.Trigger
			>
			<Tabs.Trigger
				value="all"
				class="flex-none px-4 py-2 text-sm font-medium text-fg-muted after:bg-indigo-500 hover:text-fg data-active:text-fg"
				>All items</Tabs.Trigger
			>
			<Tabs.Trigger
				value="annotations"
				class="flex-none px-4 py-2 text-sm font-medium text-fg-muted after:bg-indigo-500 hover:text-fg data-active:text-fg"
				>Annotations</Tabs.Trigger
			>
		</Tabs.List>

		<Tabs.Content value="queue" class="outline-none">
			<div class="mb-4 flex items-center justify-between">
				<p class="text-sm text-fg-muted">
					{loading
						? 'Loading…'
						: `${items.length} item${items.length !== 1 ? 's' : ''} need review`}
				</p>
				{#if items.length > 0}
					<button
						type="button"
						onclick={() => void handleBulkApprove()}
						class="rounded-lg border border-emerald-900/60 bg-emerald-900/40 px-3 py-1.5 text-xs text-emerald-400 transition-colors hover:bg-emerald-900/60"
					>
						Approve all pending
					</button>
				{/if}
			</div>
			{#if !loading && items.length === 0}
				<div class="py-16 text-center text-sm text-fg-subtle">
					All caught up — nothing to review.
				</div>
			{/if}
			<div class="space-y-2">
				{#each items as item (item.item_id)}
					{@render itemRow(item)}
				{/each}
			</div>
		</Tabs.Content>

		<Tabs.Content value="all" class="outline-none">
			<div class="mb-4 flex flex-wrap gap-2">
				<select
					value={filterStatus}
					onchange={(e) => setStatusFilter(e.currentTarget.value as ReviewStatus | '')}
					class="rounded-lg border border-line-strong bg-surface-elevated px-3 py-1.5 text-xs text-fg focus:border-indigo-500 focus:outline-none"
					aria-label="Filter by status"
				>
					<option value="">All statuses</option>
					<option value="pending">Pending</option>
					<option value="approved">Approved</option>
					<option value="rejected">Rejected</option>
					<option value="needs_revision">Needs revision</option>
				</select>
				<select
					value={filterDomain}
					onchange={(e) => setDomainFilter(e.currentTarget.value)}
					class="rounded-lg border border-line-strong bg-surface-elevated px-3 py-1.5 text-xs text-fg focus:border-indigo-500 focus:outline-none"
					aria-label="Filter by domain"
				>
					<option value="">All domains</option>
					{#each domains as d (d)}
						<option value={d}>{d}</option>
					{/each}
				</select>
				<select
					value={filterType}
					onchange={(e) => setTypeFilter(e.currentTarget.value as 'builtin' | 'external' | '')}
					class="rounded-lg border border-line-strong bg-surface-elevated px-3 py-1.5 text-xs text-fg focus:border-indigo-500 focus:outline-none"
					aria-label="Filter by type"
				>
					<option value="">All types</option>
					<option value="builtin">Built-in</option>
					<option value="external">Reference library</option>
				</select>
			</div>

			{#if domains.length > 0}
				<div class="mb-4 flex flex-wrap gap-2">
					{#each domains as d (d)}
						<button
							type="button"
							onclick={() => void handleBulkApprove(d)}
							class="rounded-lg border border-line-strong bg-surface-elevated px-2 py-1 text-[10px] text-fg-muted transition-colors hover:border-emerald-900/60 hover:text-emerald-400"
						>
							Approve all pending in {d}
						</button>
					{/each}
				</div>
			{/if}

			{#if loading}
				<p class="text-sm text-fg-subtle">Loading…</p>
			{/if}
			<div class="space-y-2">
				{#each allItems as item (item.item_id)}
					{@render itemRow(item)}
				{/each}
				{#if !loading && allItems.length === 0}
					<p class="py-8 text-center text-sm text-fg-subtle">No items match the filters.</p>
				{/if}
			</div>
		</Tabs.Content>

		<Tabs.Content value="annotations" class="outline-none">
			<p class="mb-4 text-sm text-fg-muted">
				{loading
					? 'Loading…'
					: `${annotations.length} active SME correction${annotations.length !== 1 ? 's' : ''}`}
			</p>
			<div class="space-y-2">
				{#each annotations as ann (ann.annotation_id)}
					<div
						class="flex items-start gap-3 rounded-lg border border-line bg-surface-elevated/40 p-3"
					>
						<div class="flex-1">
							<div class="mb-1 flex items-center gap-2">
								<span
									class="rounded border border-line-strong bg-surface-overlay px-1.5 py-0.5 text-[10px] text-fg-muted"
									>{ann.domain}</span
								>
								<span class="text-[10px] text-fg-subtle">{ann.item_id}</span>
							</div>
							<p class="text-xs text-fg">{ann.correction}</p>
						</div>
						<div class="flex shrink-0 items-center gap-1">
							<button
								type="button"
								onclick={() =>
									void patchAnnotation(ann.annotation_id, { is_active: false }).then(
										loadAnnotations
									)}
								class="rounded-full border border-emerald-900/60 bg-emerald-950/60 px-1.5 py-0.5 text-[10px] text-emerald-400 transition-colors hover:border-red-900/60 hover:bg-red-950/60 hover:text-red-400"
							>
								Active
							</button>
							<button
								type="button"
								onclick={() => void deleteAnnotation(ann.annotation_id).then(loadAnnotations)}
								class="p-0.5 text-fg-subtle transition-colors hover:text-red-400"
								aria-label="Delete correction"
							>
								<Icon name="close" size="w-3.5 h-3.5" />
							</button>
						</div>
					</div>
				{/each}
				{#if !loading && annotations.length === 0}
					<p class="py-8 text-center text-sm text-fg-subtle">
						No active corrections. Open a review item to add one.
					</p>
				{/if}
			</div>
		</Tabs.Content>
	</Tabs.Root>
</div>

<!-- Reject modal -->
<Dialog.Root open={rejectModal !== null} onOpenChange={(open) => !open && (rejectModal = null)}>
	<Dialog.Content
		showCloseButton={false}
		aria-describedby={undefined}
		class="w-[400px] gap-0 rounded-xl border border-line-strong bg-surface-elevated p-5 shadow-2xl ring-0 sm:max-w-[400px]"
	>
		<Dialog.Title class="mb-3 text-sm font-medium text-fg">Reject item</Dialog.Title>
		<textarea
			value={rejectModal?.notes ?? ''}
			oninput={(e) =>
				rejectModal && (rejectModal = { ...rejectModal, notes: e.currentTarget.value })}
			placeholder="Optional notes about why this is rejected…"
			aria-label="Optional notes about why this is rejected"
			class="mb-3 h-24 w-full resize-none rounded-lg border border-line-strong bg-surface-elevated px-3 py-2 text-xs text-fg placeholder:text-fg-subtle focus:border-red-500 focus:outline-none"
		></textarea>
		<div class="flex justify-end gap-2">
			<button
				type="button"
				onclick={() => (rejectModal = null)}
				class="rounded-lg px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
			>
				Cancel
			</button>
			<button
				type="button"
				onclick={() => void handleRejectConfirm()}
				class="rounded-lg border border-red-900/60 bg-red-900/40 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-900/60"
			>
				Reject
			</button>
		</div>
	</Dialog.Content>
</Dialog.Root>

<!-- Slide-over detail panel -->
<Sheet.Root open={selectedItemId !== null} onOpenChange={(open) => !open && closeItem()}>
	<Sheet.Content
		side="right"
		showCloseButton={false}
		aria-describedby={undefined}
		class="w-[600px] max-w-full gap-0 border-l border-line bg-surface-elevated p-0 text-fg data-[side=right]:w-[600px] sm:max-w-[600px] data-[side=right]:sm:max-w-[600px]"
	>
		{#if !detail}
			<div class="flex flex-1 items-center justify-center">
				<span class="text-sm text-fg-muted">Loading…</span>
			</div>
		{:else}
			<div class="flex shrink-0 items-start justify-between border-b border-line px-5 py-4">
				<div>
					<Sheet.Title class="text-sm font-medium text-fg">{detail.item.filename}</Sheet.Title>
					<div class="mt-1.5 flex flex-wrap items-center gap-1.5">
						<span
							class="rounded border border-line-strong bg-surface-overlay px-1.5 py-0.5 text-[10px] text-fg-muted"
							>{detail.item.domain}</span
						>
						<span
							class="rounded border border-line-strong bg-surface-overlay px-1.5 py-0.5 text-[10px] text-fg-muted"
							>{detail.item.content_type}</span
						>
						{@render statusPill(detail.item.status)}
						{@render priorityPill(detail.item.priority)}
					</div>
				</div>
				<button
					type="button"
					onclick={closeItem}
					class="p-1 text-fg-muted hover:text-fg"
					aria-label="Close panel"
				>
					<Icon name="close" size="w-4 h-4" />
				</button>
			</div>

			<div class="flex-1 space-y-6 overflow-y-auto p-5">
				<!-- Builtin file content -->
				{#if detail.item.content_type === 'builtin'}
					<section>
						<div class="mb-2 flex items-center justify-between">
							<p class="text-xs font-medium tracking-wide text-fg-muted uppercase">
								Document content
							</p>
							{#if !editing && content != null}
								<button
									type="button"
									onclick={() => {
										editDraft = content ?? '';
										editing = true;
									}}
									class="text-xs text-indigo-400 transition-colors hover:text-indigo-300"
								>
									Edit
								</button>
							{/if}
						</div>
						{#if editing}
							<div class="space-y-2">
								<textarea
									value={editDraft}
									oninput={(e) => (editDraft = e.currentTarget.value)}
									aria-label="Document content"
									class="h-72 w-full resize-y rounded-lg border border-line-strong bg-surface-elevated px-3 py-2 font-mono text-xs text-fg focus:border-indigo-500 focus:outline-none"
								></textarea>
								<div class="flex gap-2">
									<button
										type="button"
										onclick={() => void handleSaveEdit()}
										disabled={saving}
										class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
									>
										{saving ? 'Saving…' : 'Save'}
									</button>
									<button
										type="button"
										onclick={() => (editing = false)}
										class="rounded-lg px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
									>
										Cancel
									</button>
								</div>
							</div>
						{:else if contentLoading}
							<p class="text-xs text-fg-subtle">Loading…</p>
						{:else if contentError}
							<p class="text-xs text-red-500/70">Could not load file content.</p>
						{:else if content != null}
							<pre
								class="max-h-96 overflow-x-auto rounded-lg border border-line bg-surface-elevated/60 p-3 font-mono text-xs whitespace-pre-wrap text-fg">{content}</pre>
						{/if}
					</section>
				{/if}

				<!-- External source chunks -->
				{#if detail.item.content_type === 'external'}
					<section>
						<div class="mb-2 flex items-center justify-between">
							<p class="text-xs font-medium tracking-wide text-fg-muted uppercase">
								Source content
							</p>
							{#if loadingChunks}
								<span class="text-[10px] text-fg-subtle">Loading…</span>
							{/if}
						</div>
						<p class="mb-3 text-[11px] text-fg-subtle">
							Indexed chunks from <span class="text-fg-muted">{detail.item.filename}</span> — this is
							the text the AI retrieves from this source.
						</p>
						{#if !loadingChunks && externalChunks.length === 0}
							<div class="rounded-lg border border-line bg-surface-elevated/60 p-4 text-center">
								<p class="mb-1 text-xs text-fg-muted">No indexed chunks found.</p>
								<p class="text-[11px] text-fg-subtle">
									Run <code class="rounded bg-surface-overlay px-1 font-mono"
										>openexecutive ingest-oer</code
									> to index this source.
								</p>
							</div>
						{/if}
						<div class="space-y-2">
							{#each externalChunks as chunk (chunk.filename + ':' + chunk.chunk_index)}
								<div class="rounded-lg border border-line bg-surface-elevated/60 p-3">
									<div class="mb-1.5 flex items-center gap-2">
										<span
											class="rounded border border-line-strong bg-surface-overlay px-1.5 py-0.5 text-[10px] text-fg-muted"
											>{chunk.domain}</span
										>
										<span class="font-mono text-[10px] text-fg-subtle"
											>{chunk.filename} · chunk {chunk.chunk_index}</span
										>
									</div>
									<p class="text-xs leading-relaxed text-fg">{chunk.text}</p>
								</div>
							{/each}
						</div>
						{#if externalChunks.length > 0 && externalChunks.length >= externalChunkLimit}
							<button
								type="button"
								onclick={() => void loadMoreChunks()}
								disabled={loadingChunks}
								class="mt-3 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
							>
								Load 10 more chunks…
							</button>
						{/if}
					</section>
				{/if}

				<!-- Notes -->
				<section>
					<p class="mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase">
						Reviewer notes
					</p>
					<textarea
						value={notes}
						oninput={(e) => (notes = e.currentTarget.value)}
						onblur={() => void handleSaveNotes()}
						placeholder="Add your review notes here…"
						aria-label="Reviewer notes"
						class="h-20 w-full resize-none rounded-lg border border-line-strong bg-surface-elevated px-3 py-2 text-xs text-fg placeholder:text-fg-subtle focus:border-indigo-500 focus:outline-none"
					></textarea>
				</section>

				<!-- Annotations -->
				<section>
					<p class="mb-2 text-xs font-medium tracking-wide text-fg-muted uppercase">
						SME corrections
						<span class="ml-1 font-normal text-fg-subtle normal-case"
							>— injected into AI retrieval context</span
						>
					</p>
					<div class="space-y-2">
						{#each detail.annotations as ann (ann.annotation_id)}
							<div
								class={`flex items-start gap-2 rounded-lg border p-2 ${ann.is_active ? 'border-line bg-surface-elevated/60' : 'border-line/40 bg-surface-elevated/20 opacity-50'}`}
							>
								<p class="flex-1 text-xs text-fg">{ann.correction}</p>
								<div class="flex shrink-0 items-center gap-1">
									<button
										type="button"
										onclick={() => void handleToggleAnnotation(ann)}
										class={`rounded-full border px-1.5 py-0.5 text-[10px] transition-colors ${ann.is_active ? 'border-emerald-900/60 bg-emerald-950/60 text-emerald-400 hover:border-red-900/60 hover:bg-red-950/60 hover:text-red-400' : 'border-line-strong/60 bg-surface-overlay/60 text-fg-muted hover:border-emerald-900/60 hover:bg-emerald-950/60 hover:text-emerald-400'}`}
									>
										{ann.is_active ? 'Active' : 'Inactive'}
									</button>
									<button
										type="button"
										onclick={() => void handleDeleteAnnotation(ann.annotation_id)}
										class="p-0.5 text-fg-subtle transition-colors hover:text-red-400"
										aria-label="Delete correction"
									>
										<Icon name="close" size="w-3 h-3" />
									</button>
								</div>
							</div>
						{/each}
						<div class="flex gap-2">
							<input
								value={newCorrection}
								oninput={(e) => (newCorrection = e.currentTarget.value)}
								onkeydown={(e) => {
									if (e.key === 'Enter' && !e.shiftKey) {
										e.preventDefault();
										void handleAddAnnotation();
									}
								}}
								placeholder="Add a correction or clarification…"
								aria-label="Add a correction or clarification"
								class="flex-1 rounded-lg border border-line-strong bg-surface-elevated px-3 py-1.5 text-xs text-fg placeholder:text-fg-subtle focus:border-indigo-500 focus:outline-none"
							/>
							<button
								type="button"
								onclick={() => void handleAddAnnotation()}
								disabled={addingAnnotation || !newCorrection.trim()}
								class="rounded-lg bg-surface-overlay px-3 py-1.5 text-xs text-fg transition-colors hover:bg-surface-input disabled:opacity-40"
							>
								Add
							</button>
						</div>
					</div>
				</section>
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>

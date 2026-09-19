<script lang="ts">
	// Svelte Flow + dagre needed their base stylesheet (React Flow's
	// `@xyflow/react/dist/style.css` equivalent).
	import '@xyflow/svelte/dist/style.css';

	import { afterNavigate } from '$app/navigation';
	import { page } from '$app/state';
	import { Background, Controls, MiniMap, SvelteFlow, type Node } from '@xyflow/svelte';
	import AuditNode from '$lib/components/audit/AuditNode.svelte';
	import EventDetailPanel from '$lib/components/audit/EventDetailPanel.svelte';
	import {
		layoutNodes,
		miniMapNodeColor,
		type FlowNodeData
	} from '$lib/components/audit/session-graph.js';
	import {
		getAuditLog,
		getAuditSession,
		type AuditEvent,
		type AuditEventDetail,
		type AuditSessionResponse
	} from '$lib/api.js';

	// SvelteKit decodes dynamic params before exposing them on `page.params`,
	// so the `decodeURIComponent` the Next.js source applied is not repeated
	// here. The param is read inside `load()` (not captured once at the top)
	// because navigating between two sessions reuses this component.
	let data = $state.raw<AuditSessionResponse | null>(null);
	let loading = $state(true);
	let error = $state<string | null>(null);

	// selected event_id (drives center panel + right drawer fetch)
	let selectedEventId = $state<number | null>(null);
	let detailsCache = $state<Record<number, AuditEventDetail>>({});
	let detail = $state.raw<AuditEventDetail | null>(null);
	let detailLoading = $state(false);
	let drawerExpanded = $state(false);
	let copyState = $state<'idle' | 'ok' | 'fail'>('idle');

	// `afterNavigate` covers both the initial mount (where `onMount` would have
	// been enough) and in-place param changes.
	afterNavigate(() => {
		void load();
	});

	async function load() {
		const sessionId = page.params.id ?? '';
		if (!sessionId) return;
		loading = true;
		error = null;
		selectedEventId = null;
		detail = null;
		try {
			const res = await getAuditSession(sessionId);
			data = res;
			// Default selection: the inbound node, or the OLDEST event. The
			// API returns events newest-first (id DESC); the canvas reads
			// top-to-bottom from oldest, so pick the last entry to anchor the
			// user at the causal start of the session.
			const first =
				res.events.find((e) => e.event_type === 'integration_inbound') ??
				res.events[res.events.length - 1];
			selectedEventId = first ? first.id : null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load session';
		} finally {
			loading = false;
		}
		// The default selection needs its full payload too (React drove this from
		// an effect keyed on the selected id).
		if (selectedEventId !== null) void loadDetail(selectedEventId);
	}

	// Lazy-fetch full payload for the currently selected event (cached by id).
	async function loadDetail(id: number) {
		const cached = detailsCache[id];
		if (cached) {
			detail = cached;
			return;
		}
		detailLoading = true;
		try {
			const d = await getAuditLog(id);
			detailsCache = { ...detailsCache, [d.id]: d };
			detail = d;
		} catch {
			// Detail fetch failure is non-fatal — the center pane still shows the
			// summary `details` from the list payload, just without `full`.
		} finally {
			detailLoading = false;
		}
	}

	async function selectEvent(id: number) {
		if (selectedEventId === id) return;
		selectedEventId = id;
		detail = null;
		await loadDetail(id);
	}

	let flow = $derived(data ? layoutNodes(data.graph) : null);

	let flowNodes = $derived(
		(flow?.nodes ?? []).map((n) => ({ ...n, selected: n.data.event_id === selectedEventId }))
	);

	let selectedEvent = $derived<AuditEvent | null>(
		data && selectedEventId !== null
			? (data.events.find((e) => e.id === selectedEventId) ?? null)
			: null
	);

	// Stat-strip figures: graph shape, channel, token cost, degradations.
	let costChips = $derived.by(() => {
		const cs = data?.cost_summary;
		if (!cs) return null;
		const totalIn = cs.input_tokens + cs.cache_read_input_tokens + cs.cache_creation_input_tokens;
		return {
			calls: cs.calls,
			totalIn,
			output: cs.output_tokens,
			cachedPct: totalIn > 0 ? Math.round((cs.cache_read_input_tokens / totalIn) * 100) : 0
		};
	});

	let degradationCount = $derived((data?.degradations ?? []).reduce((n, d) => n + d.count, 0));

	let degradationTitle = $derived(
		(data?.degradations ?? [])
			.map((d) => `${d.kind} ${d.reason} ×${d.count}` + (d.detail ? ` (${d.detail})` : ''))
			.join('; ')
	);

	const nodeTypes = { audit: AuditNode };

	function handleNodeClick({ node }: { node: Node<FlowNodeData> }): void {
		const eventId = node.data?.event_id;
		if (typeof eventId === 'number') void selectEvent(eventId);
	}

	async function handleCopy() {
		if (!detail) return;
		const payload = JSON.stringify(detail.full ?? detail, null, 2);
		// navigator.clipboard requires a secure context;
		// fall back to a hidden <textarea> for http:// deploys.
		try {
			if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
				await navigator.clipboard.writeText(payload);
			} else {
				const ta = document.createElement('textarea');
				ta.value = payload;
				ta.style.position = 'fixed';
				ta.style.opacity = '0';
				document.body.appendChild(ta);
				ta.select();
				const ok = document.execCommand('copy');
				document.body.removeChild(ta);
				if (!ok) throw new Error('execCommand returned false');
			}
			copyState = 'ok';
		} catch {
			copyState = 'fail';
		}
		// Brief flash then reset.
		setTimeout(() => (copyState = 'idle'), 1500);
	}
</script>

<h1 class="sr-only">Audit — Session</h1>

<main class="flex min-h-0 flex-1">
	{#if loading}
		<div class="flex flex-1 items-center justify-center text-fg-muted" role="status">
			Loading session…
		</div>
	{:else if error}
		<div class="flex flex-1 items-center justify-center p-6 text-sm text-rose-300" role="alert">
			{error}
		</div>
	{:else if flow && data}
		<!-- Left: flow chart canvas. When the drawer is expanded the canvas hides
		     on narrow screens (full-screen JSON) and shrinks on wide ones (so the
		     drawer + canvas can coexist). -->
		<div
			class={`relative border-r border-line bg-surface-elevated/30 transition-all ${
				drawerExpanded ? 'hidden xl:block xl:flex-1' : 'flex-1 md:flex-[3]'
			}`}
		>
			<!-- Stat strip — sits above the canvas as a sticky chip so the user sees
			     graph shape at a glance (turn count, event count, channel) without
			     scanning the whole tree. -->
			<div
				class="absolute top-3 left-3 z-10 flex items-center gap-2 rounded-full border border-line bg-surface-elevated/90 px-3 py-1.5 font-mono text-[11px] text-fg-muted backdrop-blur"
			>
				<span class="text-fg">{flow.nodes.length}</span>
				<span>events</span>
				<span class="text-fg-subtle">·</span>
				<span class="text-fg">{flow.edges.length}</span>
				<span>edges</span>
				{#if data.channel}
					<span class="text-fg-subtle">·</span>
					<span>{data.channel}</span>
				{/if}
				{#if costChips}
					<span class="text-fg-subtle">·</span>
					<span class="text-fg">{costChips.calls}</span>
					<span>calls</span>
					<span class="text-fg-subtle">·</span>
					<span class="text-fg">{costChips.totalIn.toLocaleString()}</span>
					<span>in</span>
					<span class="text-fg-subtle">·</span>
					<span class="text-fg">{costChips.output.toLocaleString()}</span>
					<span>out</span>
					<span class="text-fg-subtle">·</span>
					<span
						class="text-fg"
						title="Share of prompt input served from the cache (≈10x cheaper than fresh input)."
					>
						{costChips.cachedPct}%
					</span>
					<span>cached</span>
				{/if}
				{#if data.degradations.length > 0}
					<span class="text-fg-subtle">·</span>
					<span class="text-amber-400" title={degradationTitle}>⚠ {degradationCount} degraded</span>
				{/if}
			</div>

			{#if flow.nodes.length === 0}
				<div
					class="absolute inset-0 flex items-center justify-center p-6 text-center text-sm text-fg-muted"
				>
					No events recorded for this session.
				</div>
			{/if}

			<SvelteFlow
				nodes={flowNodes}
				edges={flow.edges}
				{nodeTypes}
				onnodeclick={handleNodeClick}
				fitView
				fitViewOptions={{ padding: 0.25, maxZoom: 1.1, minZoom: 0.15 }}
				minZoom={0.15}
				maxZoom={1.5}
				proOptions={{ hideAttribution: true }}
				nodesDraggable
				elementsSelectable
				defaultEdgeOptions={{ type: 'smoothstep' }}
			>
				<!-- Dotted background grid — same 16px rhythm as dagre's spacing
				     constants so node edges align to the grid. -->
				<Background gap={16} size={1.2} patternColor="rgba(255,255,255,0.05)" />
				<Controls
					showLock={false}
					class="border-line! bg-surface-elevated/90! backdrop-blur [&>button]:border-line! [&>button]:bg-transparent! [&>button]:text-fg-muted! [&>button:hover]:bg-surface-input!"
				/>
				<MiniMap
					class="border-line! bg-surface-elevated/80!"
					pannable
					zoomable
					nodeColor={miniMapNodeColor}
					maskColor="rgba(0,0,0,0.5)"
				/>
			</SvelteFlow>
		</div>

		<!-- Center: selected event detail. Same coexistence rule — stays visible
		     on xl+ when the drawer is open. -->
		<div
			class={`border-r border-line bg-surface ${
				drawerExpanded ? 'hidden xl:block xl:w-80 xl:shrink-0' : 'w-80 shrink-0 lg:w-96'
			}`}
		>
			{#if selectedEvent}
				<EventDetailPanel
					event={selectedEvent}
					{detail}
					onOpenDrawer={() => (drawerExpanded = true)}
				/>
			{:else}
				<div class="p-4 text-sm text-fg-muted">Click a node to see what the agent saw.</div>
			{/if}
			{#if detailLoading}
				<div class="px-4 pb-2 text-[10px] text-fg-muted" role="status">loading full payload…</div>
			{/if}
		</div>

		<!-- Right: collapsible JSON drawer -->
		<div
			class={`flex flex-col border-l border-line bg-surface-elevated/60 transition-all ${
				drawerExpanded ? 'flex-1' : 'w-12 shrink-0'
			}`}
		>
			<button
				type="button"
				onclick={() => (drawerExpanded = !drawerExpanded)}
				class="flex h-10 items-center justify-center border-b border-line text-xs text-fg-muted hover:text-fg"
				title={drawerExpanded ? 'Collapse drawer' : 'Expand drawer (full payload)'}
				aria-label={drawerExpanded ? 'Collapse drawer' : 'Expand drawer (full payload)'}
			>
				{drawerExpanded ? '→' : '←'}
			</button>
			{#if drawerExpanded}
				<div class="min-h-0 flex-1 overflow-y-auto p-4">
					<div class="mb-2 flex items-center justify-between">
						<div class="text-[10px] tracking-wide text-fg-muted uppercase">Full payload</div>
						<button
							type="button"
							onclick={handleCopy}
							class="rounded border border-line-strong bg-surface-overlay px-2 py-0.5 text-[10px] hover:bg-surface-input"
						>
							{copyState === 'ok' ? 'Copied!' : copyState === 'fail' ? 'Copy failed' : 'Copy'}
						</button>
					</div>
					<pre
						class="overflow-x-auto rounded-lg bg-black/40 p-3 text-[11px] break-words whitespace-pre-wrap text-fg">{detail
							? JSON.stringify(detail.full ?? detail, null, 2)
							: selectedEvent
								? JSON.stringify(selectedEvent.details, null, 2)
								: '(select a node)'}</pre>
				</div>
			{/if}
		</div>
	{/if}
</main>

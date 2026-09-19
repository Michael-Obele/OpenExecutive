<script lang="ts" module>
	const PAGE_SIZE = 100;

	const TYPE_COLORS: Record<string, string> = {
		chat_turn: 'bg-indigo-500/20 text-indigo-300 border-indigo-500/30',
		specialist_consult: 'bg-violet-500/20 text-violet-300 border-violet-500/30',
		tool_invocation: 'bg-amber-500/20 text-amber-300 border-amber-500/30',
		scheduled_action: 'bg-sky-500/20 text-sky-300 border-sky-500/30',
		alert: 'bg-rose-500/20 text-rose-300 border-rose-500/30',
		integration_inbound: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/30'
	};

	function typePillClass(t: string): string {
		return TYPE_COLORS[t] ?? 'bg-surface-input/40 text-fg border-line-strong/40';
	}

	function formatTs(ts: string): string {
		try {
			const d = new Date(ts);
			return d.toLocaleString();
		} catch {
			return ts;
		}
	}

	// Human-relative phrase like "2m ago" / "3h ago" / "5d ago". Picks the
	// largest unit whose magnitude is ≥1 so the result is one word + "ago".
	// Intl.RelativeTimeFormat handles locale + pluralization for us.
	const RELATIVE_FORMATTER = new Intl.RelativeTimeFormat(undefined, {
		numeric: 'auto',
		style: 'narrow'
	});
	const RELATIVE_DIVISIONS: { amount: number; name: Intl.RelativeTimeFormatUnit }[] = [
		{ amount: 60, name: 'seconds' },
		{ amount: 60, name: 'minutes' },
		{ amount: 24, name: 'hours' },
		{ amount: 7, name: 'days' },
		{ amount: 4.34524, name: 'weeks' },
		{ amount: 12, name: 'months' },
		{ amount: Number.POSITIVE_INFINITY, name: 'years' }
	];
	function formatRelative(ts: string): string {
		try {
			let duration = (new Date(ts).getTime() - Date.now()) / 1000;
			for (const div of RELATIVE_DIVISIONS) {
				if (Math.abs(duration) < div.amount) {
					return RELATIVE_FORMATTER.format(Math.round(duration), div.name);
				}
				duration /= div.amount;
			}
			return ts;
		} catch {
			return ts;
		}
	}

	// Pretty duration between two ISO timestamps. <1s → "ms", <60s → "Xs",
	// <60m → "Xm Ys", else "Xh Ym". Always returns a compact 1–2 token string.
	function formatSpan(firstTs: string, lastTs: string): string {
		try {
			const first = new Date(firstTs).getTime();
			const last = new Date(lastTs).getTime();
			const ms = Math.abs(last - first);
			if (ms < 1000) return `${ms}ms`;
			const s = Math.floor(ms / 1000);
			if (s < 60) return `${s}s`;
			const m = Math.floor(s / 60);
			const remS = s % 60;
			if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
			const h = Math.floor(m / 60);
			const remM = m % 60;
			return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
		} catch {
			return '—';
		}
	}

	// Channel → dot color. Pulls from the same emerald/sky/etc palette as the
	// event-type pills so the visual language stays unified. Fall back to a
	// neutral fg-muted dot for unknown channels.
	const CHANNEL_DOT: Record<string, string> = {
		discord: 'bg-emerald-400',
		slack: 'bg-fuchsia-400',
		telegram: 'bg-sky-400',
		email: 'bg-amber-400',
		google_chat: 'bg-rose-400'
	};

	// Shape-summary: replaces the unbounded chip wall with a bounded set of
	// "kind × count" badges. Keys are event_type, values are occurrence
	// counts. Sorted by a stable canonical order so badges read the same
	// way every render (inbound first, response last — matches turn flow).
	const TYPE_ORDER: Record<string, number> = {
		integration_inbound: 0,
		memory_snapshot: 1,
		chat_turn: 2,
		knowledge_retrieval: 3,
		specialist_consult: 4,
		tool_invocation: 5,
		cache_event: 6,
		scheduled_action: 7,
		alert: 8
		// Anything unknown lands after the known canonical types.
	};
	function summarizeShape(items: AuditEvent[]): { type: string; count: number }[] {
		const counts = new Map<string, number>();
		for (const evt of items) {
			counts.set(evt.event_type, (counts.get(evt.event_type) ?? 0) + 1);
		}
		return [...counts.entries()]
			.map(([type, count]) => ({ type, count }))
			.sort((a, b) => {
				const ao = TYPE_ORDER[a.type] ?? 99;
				const bo = TYPE_ORDER[b.type] ?? 99;
				return ao - bo;
			});
	}

	// Friendly short label for the shape-summary badges. Matches what an
	// engineer would say out loud ("4 specialists" rather than
	// "4 specialist_consults"). Falls back to the raw event_type when no
	// alias is defined so new event types still render correctly.
	const SHAPE_LABEL: Record<string, { singular: string; plural: string }> = {
		integration_inbound: { singular: 'inbound', plural: 'inbound' },
		memory_snapshot: { singular: 'memory', plural: 'memory' },
		chat_turn: { singular: 'turn', plural: 'turns' },
		knowledge_retrieval: { singular: 'knowledge', plural: 'knowledge' },
		specialist_consult: { singular: 'specialist', plural: 'specialists' },
		tool_invocation: { singular: 'tool', plural: 'tools' },
		cache_event: { singular: 'cache', plural: 'cache' },
		scheduled_action: { singular: 'scheduled', plural: 'scheduled' },
		alert: { singular: 'alert', plural: 'alerts' }
	};
	function shapeLabel(type: string, count: number): string {
		const alias = SHAPE_LABEL[type];
		if (!alias) return `${count} ${type}`;
		return `${count} ${count === 1 ? alias.singular : alias.plural}`;
	}

	function formatTimeOnly(ts: string): string {
		try {
			return new Date(ts).toLocaleTimeString();
		} catch {
			return ts;
		}
	}
</script>

<script lang="ts">
	import { onDestroy, onMount } from 'svelte';
	import { page } from '$app/state';
	import {
		getAuditLog,
		listAuditLogs,
		type AuditEvent,
		type AuditEventDetail,
		type AuditQuery
	} from '$lib/api.js';

	// Deep links (e.g. the briefing's "Handled" rail linking a move to its
	// evidence — `handledProofHref()` in `$lib/handled.js`) pre-fill the type
	// and text filters from the query string.
	let eventType = $state<string>(page.url.searchParams.get('event_type') ?? '');
	let q = $state<string>(page.url.searchParams.get('q') ?? '');
	let sessionId = $state<string>('');
	let since = $state<string>('');
	let until = $state<string>('');
	let offset = $state<number>(0);

	let items = $state.raw<AuditEvent[]>([]);
	let total = $state(0);
	let eventTypes = $state.raw<string[]>([]);
	let loading = $state(true);
	let error = $state<string | null>(null);

	let expandedId = $state<number | null>(null);
	let details = $state<Record<number, AuditEventDetail>>({});
	let detailLoadingId = $state<number | null>(null);
	let detailError = $state<string | null>(null);

	// Sessions view is the default surface — most "what happened?" questions
	// start at the session level (one Discord message produced this turn,
	// here's the shape), and users drop into Events view by clicking a
	// session_id to chase chronological detail.
	let groupBySession = $state<boolean>(true);
	let collapsedSessions = $state<Record<string, boolean>>({});

	const filters = $derived.by<AuditQuery>(() => ({
		event_type: eventType || undefined,
		session_id: sessionId || undefined,
		q: q || undefined,
		// `datetime-local` returns naive strings like "2026-05-19T14:30". The
		// backend `ts` column stores ISO with offset, and SQLite filters via
		// string comparison — so we must normalize to ISO with offset here.
		since: since ? new Date(since).toISOString() : undefined,
		until: until ? new Date(until).toISOString() : undefined,
		limit: PAGE_SIZE,
		offset
	}));

	// Refetches are debounced 250ms so typing in the search box doesn't fire a
	// request per keystroke. React drove this from a `useEffect` keyed on the
	// filter object; here every filter change calls `scheduleRefresh()`
	// directly (no `$effect` — see the porting notes for why).
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	function scheduleRefresh() {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			debounceTimer = null;
			void refresh();
		}, 250);
	}

	onMount(() => {
		scheduleRefresh();
	});

	onDestroy(() => {
		if (debounceTimer !== null) clearTimeout(debounceTimer);
	});

	async function refresh() {
		loading = true;
		error = null;
		try {
			const res = await listAuditLogs(filters);
			items = res.items;
			total = res.total;
			eventTypes = res.event_types;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load';
		} finally {
			loading = false;
		}
	}

	// Every filter change resets to page 0 (but a raw offset change must not).
	function handleEventType(value: string) {
		eventType = value;
		offset = 0;
		scheduleRefresh();
	}

	function handleSessionId(value: string) {
		sessionId = value;
		offset = 0;
		scheduleRefresh();
	}

	function handleQ(value: string) {
		q = value;
		offset = 0;
		scheduleRefresh();
	}

	function handleSince(value: string) {
		since = value;
		offset = 0;
		scheduleRefresh();
	}

	function handleUntil(value: string) {
		until = value;
		offset = 0;
		scheduleRefresh();
	}

	function handleClearFilters() {
		eventType = '';
		sessionId = '';
		q = '';
		since = '';
		until = '';
		offset = 0;
		scheduleRefresh();
	}

	function handleOffset(next: number) {
		offset = Math.max(0, next);
		scheduleRefresh();
	}

	// Lazy-fetch the un-truncated drill-down payload when a row expands.
	// Cache per-id so toggling closed/open doesn't re-fetch.
	async function loadDetail(id: number) {
		if (details[id]) return;
		detailLoadingId = id;
		detailError = null;
		try {
			const d = await getAuditLog(id);
			details = { ...details, [d.id]: d };
		} catch (e) {
			detailError = e instanceof Error ? e.message : 'Failed to load detail';
		} finally {
			detailLoadingId = null;
		}
	}

	function toggleExpanded(id: number) {
		if (expandedId === id) {
			expandedId = null;
			detailError = null;
			return;
		}
		expandedId = id;
		void loadDetail(id);
	}

	function toggleSessionCollapsed(key: string) {
		collapsedSessions = { ...collapsedSessions, [key]: !collapsedSessions[key] };
	}

	// Once the user picks a single session, the "compare sessions" job is
	// done — they want chronological detail. Auto-switching to Events view
	// saves them a manual toggle. Called from every clickable session_id
	// affordance (card header, table row, event-row session column).
	function focusSession(sid: string) {
		sessionId = sid;
		groupBySession = false;
		offset = 0;
		scheduleRefresh();
	}

	// Contiguous run of events sharing one session_id. Events without a
	// session_id form singleton groups (merged into one tail bucket later).
	// Contiguous run of events sharing one session_id. Events without a
	// session_id form singleton groups (merged into one tail bucket later).
	type SessionGroup = {
		key: string;
		sessionId: string | null;
		actor: string | null;
		channel: string | null;
		firstTs: string;
		lastTs: string;
		items: AuditEvent[];
	};

	// Cluster the current page into contiguous runs of the same session_id.
	// Ordering within a group preserves API order (id DESC).
	let sessionGroups = $derived.by<SessionGroup[]>(() => {
		if (!groupBySession) return [];
		const groups: SessionGroup[] = [];
		for (const evt of items) {
			const sid = evt.session_id ?? null;
			const channelFromDetails =
				evt.details && typeof evt.details === 'object' && 'channel' in evt.details
					? String((evt.details as Record<string, unknown>).channel ?? '')
					: '';
			const last = groups[groups.length - 1];
			if (last && last.sessionId === sid && sid !== null) {
				last.items.push(evt);
				last.lastTs = evt.ts;
				if (!last.actor && evt.actor) last.actor = evt.actor;
				if (!last.channel && channelFromDetails) last.channel = channelFromDetails;
			} else {
				groups.push({
					key: sid ? `s:${sid}:${evt.id}` : `n:${evt.id}`,
					sessionId: sid,
					actor: evt.actor ?? null,
					channel: channelFromDetails || null,
					firstTs: evt.ts,
					lastTs: evt.ts,
					items: [evt]
				});
			}
		}
		return groups;
	});

	// Consolidate the per-event "no-session" singletons into a single tail
	// bucket so the cards list isn't dominated by orphan rows from before
	// PR #158 (when integration_inbound didn't propagate session_id). Real
	// sessions render in their original chronological order; unattributed
	// events all collapse into one card at the end.
	let sessionCards = $derived.by<SessionGroup[]>(() => {
		if (!groupBySession) return [];
		const real = sessionGroups.filter((g) => g.sessionId !== null);
		const orphans = sessionGroups.filter((g) => g.sessionId === null);
		if (orphans.length === 0) return real;
		const merged = orphans.flatMap((g) => g.items);
		const firstTs = merged.length > 0 ? merged[merged.length - 1].ts : '';
		const lastTs = merged.length > 0 ? merged[0].ts : '';
		return [
			...real,
			{
				key: 'unattributed',
				sessionId: null,
				actor: null,
				channel: 'unattributed',
				firstTs,
				lastTs,
				items: merged
			}
		];
	});

	let hasPrev = $derived(offset > 0);
	let hasNext = $derived(offset + PAGE_SIZE < total);
	let pageNumber = $derived(Math.floor(offset / PAGE_SIZE) + 1);
	let pageCount = $derived(Math.max(1, Math.ceil(total / PAGE_SIZE)));
</script>

{#snippet detailBlock(evt: AuditEvent)}
	<div class="mb-2 grid grid-cols-2 gap-2 text-xs text-fg-muted">
		<div>id: <span class="font-mono text-fg">{evt.id}</span></div>
		<div>turn_id: <span class="font-mono text-fg">{evt.turn_id ?? '—'}</span></div>
		<div>session_id: <span class="font-mono text-fg">{evt.session_id ?? '—'}</span></div>
		<div>ts: <span class="font-mono text-fg">{evt.ts}</span></div>
	</div>
	<div class="mb-1 text-[10px] tracking-wide text-fg-muted uppercase">Details (summary)</div>
	<pre
		class="overflow-x-auto rounded-lg bg-black/40 p-3 text-xs break-words whitespace-pre-wrap text-fg">{JSON.stringify(
			evt.details,
			null,
			2
		)}</pre>
	{#if detailLoadingId === evt.id && !details[evt.id]}
		<div class="mt-3 text-xs text-fg-muted" role="status">Loading full payload…</div>
	{/if}
	{#if detailError && expandedId === evt.id && !details[evt.id]}
		<div class="mt-3 text-xs text-rose-300" role="alert">
			Failed to load full payload: {detailError}
		</div>
	{/if}
	{#if details[evt.id]?.full}
		<div class="mt-4 mb-1 text-[10px] tracking-wide text-fg-muted uppercase">Full payload</div>
		<pre
			class="max-h-[60vh] overflow-x-auto rounded-lg bg-black/40 p-3 text-xs break-words whitespace-pre-wrap text-fg">{JSON.stringify(
				details[evt.id].full,
				null,
				2
			)}</pre>
	{/if}
{/snippet}

<main class="min-h-0 flex-1 overflow-y-auto">
	<div class="mx-auto max-w-6xl px-6 py-6">
		<h1 class="text-xl font-semibold text-fg">Audit log</h1>
		<p class="mt-2 text-sm text-fg-muted">
			Searchable event log of every chat turn, specialist consult, tool call, and scheduled action.
		</p>

		<div class="mt-6 mb-4 grid grid-cols-1 gap-3 md:grid-cols-5">
			<input
				type="search"
				placeholder="Search summary…"
				aria-label="Search summary"
				value={q}
				oninput={(e) => handleQ(e.currentTarget.value)}
				class="rounded-lg border border-line bg-surface-elevated px-3 py-1.5 text-sm placeholder-fg-subtle focus:border-indigo-500 focus:outline-none md:col-span-2"
			/>
			<select
				aria-label="Event type"
				value={eventType}
				onchange={(e) => handleEventType(e.currentTarget.value)}
				class="rounded-lg border border-line bg-surface-elevated px-3 py-1.5 text-sm focus:border-indigo-500 focus:outline-none"
			>
				<option value="">All event types</option>
				{#each eventTypes as t (t)}
					<option value={t}>{t}</option>
				{/each}
			</select>
			<input
				type="text"
				placeholder="Session id"
				aria-label="Session id"
				value={sessionId}
				oninput={(e) => handleSessionId(e.currentTarget.value)}
				class="rounded-lg border border-line bg-surface-elevated px-3 py-1.5 text-sm placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
			/>
			<button
				type="button"
				onclick={handleClearFilters}
				class="rounded-lg border border-line-strong bg-surface-overlay px-3 py-1.5 text-sm hover:bg-surface-input"
			>
				Clear filters
			</button>
		</div>

		<div class="mb-6 grid grid-cols-1 gap-3 md:grid-cols-4">
			<label class="flex flex-col gap-1 text-xs text-fg-muted">
				From
				<input
					type="datetime-local"
					value={since}
					oninput={(e) => handleSince(e.currentTarget.value)}
					class="rounded-lg border border-line bg-surface-elevated px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none"
				/>
			</label>
			<label class="flex flex-col gap-1 text-xs text-fg-muted">
				Until
				<input
					type="datetime-local"
					value={until}
					oninput={(e) => handleUntil(e.currentTarget.value)}
					class="rounded-lg border border-line bg-surface-elevated px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none"
				/>
			</label>
			<div class="self-end pb-1 text-xs text-fg-muted" role="status">
				{loading ? 'Loading…' : `${total.toLocaleString()} events`}
			</div>
			<!-- Segmented view switcher — communicates "these are distinct
			     surfaces" rather than the checkbox's "annotation on top".
			     Events view = the chronological table; Sessions view = the
			     grouped card list. -->
			<div
				role="tablist"
				aria-label="View mode"
				class="inline-flex self-end rounded-lg border border-line bg-surface-elevated p-0.5 pb-1 text-xs"
			>
				<button
					type="button"
					role="tab"
					aria-selected={!groupBySession}
					onclick={() => (groupBySession = false)}
					class={`rounded-md px-2.5 py-1 transition-colors ${!groupBySession ? 'bg-surface-input text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
				>
					Events
				</button>
				<button
					type="button"
					role="tab"
					aria-selected={groupBySession}
					onclick={() => (groupBySession = true)}
					class={`rounded-md px-2.5 py-1 transition-colors ${groupBySession ? 'bg-surface-input text-fg shadow-sm' : 'text-fg-muted hover:text-fg'}`}
				>
					Sessions
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

		{#if groupBySession}
			<!-- Sessions view — a vertical stack of session cards. The detailed
			     event transcript lives at /audit/session/[id] (the flow chart);
			     this surface is the *map* of sessions, optimized for scanning. -->
			<div class="flex flex-col gap-3">
				{#if sessionCards.length === 0 && !loading}
					<div
						class="rounded-xl border border-line bg-surface-elevated/30 px-4 py-8 text-center text-sm text-fg-muted"
					>
						No sessions match these filters.
						<button
							type="button"
							onclick={() => (groupBySession = false)}
							class="text-indigo-300 underline-offset-2 hover:text-indigo-200 hover:underline"
						>
							Switch to Events view
						</button>
					</div>
				{/if}
				{#each sessionCards as g (g.key)}
					{@const collapsed = !!collapsedSessions[g.key]}
					{@const shape = summarizeShape(g.items)}
					<!-- Items arrive newest-first (id DESC); SessionGroup preserves
					     that order. For the peek we want the most recent first too. -->
					{@const peekItems = g.items.slice(0, collapsed ? g.items.length : 3)}
					{@const hiddenCount = g.items.length - peekItems.length}
					{@const dotClass = CHANNEL_DOT[(g.channel ?? '').toLowerCase()] ?? 'bg-fg-muted'}
					<div
						class="group rounded-xl border border-line bg-surface-elevated/30 transition-colors hover:border-line-strong hover:bg-surface-elevated/60"
					>
						<!-- Identity strip — channel · session_id · relative · span.
						     Lives in its own row so the eye lands on identity
						     before scanning shape. -->
						<div class="flex items-center gap-2 px-4 pt-3 text-xs">
							<span
								class={`inline-block h-2 w-2 shrink-0 rounded-full ${dotClass}`}
								aria-hidden="true"
							></span>
							<span class="text-fg-muted">{g.channel ?? '—'}</span>
							<span class="text-fg-subtle">·</span>
							{#if g.sessionId}
								<button
									type="button"
									onclick={() => focusSession(g.sessionId ?? '')}
									class="max-w-[40ch] truncate font-mono text-indigo-300 underline-offset-2 hover:text-indigo-200 hover:underline"
									title={`Filter by ${g.sessionId}`}
								>
									{g.sessionId}
								</button>
							{:else}
								<span class="font-mono text-fg-muted italic">unattributed</span>
							{/if}
							<span class="text-fg-subtle">·</span>
							<span class="text-fg-muted" title={formatTs(g.lastTs)}>
								{formatRelative(g.lastTs)}
							</span>
							{#if g.firstTs !== g.lastTs}
								<span class="text-fg-subtle">·</span>
								<span class="text-fg-muted">span {formatSpan(g.firstTs, g.lastTs)}</span>
							{/if}
							{#if g.sessionId}
								<a
									href={`/audit/session/${encodeURIComponent(g.sessionId)}`}
									class="ml-auto whitespace-nowrap text-indigo-300 underline-offset-2 hover:text-indigo-200 hover:underline"
									title="Open the session flow chart"
								>
									Open flow chart →
								</a>
							{/if}
						</div>

						<!-- Shape summary — bounded count badges per event type.
						     Reads as "1 inbound · 4 specialists · 6 tools" rather
						     than the previous unbounded chip wall. -->
						<div class="flex flex-wrap items-center gap-1.5 px-4 pt-2.5 text-[11px]">
							{#each shape as { type, count } (type)}
								<span
									class={`inline-flex items-center gap-1 rounded-md border px-2 py-0.5 font-medium ${typePillClass(
										type
									)}`}
									title={`${count} × ${type}`}
								>
									<span class="tabular-nums">{count}</span>
									<span class="opacity-80">{shapeLabel(type, count).replace(/^\d+\s+/, '')}</span>
								</span>
							{/each}
						</div>

						<!-- Recent events peek — three lines of HH:MM:SS · type · summary.
						     Each line reuses the same JSON drill-down state as the table,
						     so clicking opens the same detail panel. Expanding (chevron)
						     widens this peek to the full set. -->
						<ul
							class="mx-4 mt-2 mb-3 divide-y divide-line/70 overflow-hidden rounded-md border border-line/60 bg-surface/40 text-xs"
						>
							{#each peekItems as evt (evt.id)}
								{@const isOpen = expandedId === evt.id}
								<li>
									<button
										type="button"
										onclick={() => toggleExpanded(evt.id)}
										aria-expanded={isOpen}
										class="flex w-full items-center gap-3 px-3 py-1.5 text-left hover:bg-surface-elevated/60"
									>
										<span class="w-[7ch] font-mono text-[10px] whitespace-nowrap text-fg-muted">
											{formatTimeOnly(evt.ts)}
										</span>
										<span
											class={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-medium whitespace-nowrap ${typePillClass(
												evt.event_type
											)}`}
										>
											{evt.event_type}
										</span>
										<span class="truncate text-fg">{evt.summary}</span>
									</button>
									{#if isOpen}
										<div class="border-t border-line/70 bg-surface/60 px-4 py-3">
											{@render detailBlock(evt)}
										</div>
									{/if}
								</li>
							{/each}
							{#if hiddenCount > 0}
								<li>
									<button
										type="button"
										onclick={() => toggleSessionCollapsed(g.key)}
										class="w-full px-3 py-1.5 text-left text-fg-muted hover:bg-surface-elevated/60 hover:text-fg"
									>
										+ {hiddenCount} earlier event{hiddenCount === 1 ? '' : 's'}
									</button>
								</li>
							{/if}
							{#if collapsed && g.items.length > 3}
								<li>
									<button
										type="button"
										onclick={() => toggleSessionCollapsed(g.key)}
										class="w-full px-3 py-1.5 text-left text-fg-muted hover:bg-surface-elevated/60 hover:text-fg"
									>
										▴ Collapse
									</button>
								</li>
							{/if}
						</ul>
					</div>
				{/each}
			</div>
		{:else}
			<!-- Events view — the original chronological table, untouched. -->
			<div class="overflow-hidden rounded-xl border border-line">
				<table class="w-full text-sm">
					<thead class="bg-surface-elevated/60 text-xs text-fg-muted uppercase">
						<tr>
							<th scope="col" class="px-3 py-2 text-left font-medium">Time</th>
							<th scope="col" class="px-3 py-2 text-left font-medium">Type</th>
							<th scope="col" class="px-3 py-2 text-left font-medium">Actor</th>
							<th scope="col" class="px-3 py-2 text-left font-medium">Summary</th>
							<th scope="col" class="px-3 py-2 text-left font-medium">Session</th>
						</tr>
					</thead>
					<tbody>
						{#if items.length === 0 && !loading}
							<tr>
								<td colspan="5" class="px-3 py-8 text-center text-fg-muted">
									No audit events match these filters.
								</td>
							</tr>
						{/if}
						{#each items as evt (evt.id)}
							{@const isOpen = expandedId === evt.id}
							<tr class="border-t border-line hover:bg-surface-elevated/40">
								<td class="px-3 py-2 font-mono text-xs whitespace-nowrap text-fg-muted">
									<button
										type="button"
										onclick={() => toggleExpanded(evt.id)}
										aria-expanded={isOpen}
										class="cursor-pointer"
									>
										{formatTs(evt.ts)}
									</button>
								</td>
								<td class="px-3 py-2">
									<span
										class={`inline-block rounded-full border px-2 py-0.5 text-[10px] font-medium ${typePillClass(
											evt.event_type
										)}`}
									>
										{evt.event_type}
									</span>
								</td>
								<td class="px-3 py-2 whitespace-nowrap text-fg">{evt.actor ?? '—'}</td>
								<td class="px-3 py-2 text-fg">{evt.summary}</td>
								<td class="px-3 py-2 font-mono text-xs">
									{#if evt.session_id}
										<button
											type="button"
											onclick={() => focusSession(evt.session_id ?? '')}
											class="text-indigo-300 underline-offset-2 hover:text-indigo-200 hover:underline"
											title={`Filter by session ${evt.session_id}`}
										>
											{evt.session_id.slice(0, 8)}
										</button>
									{:else}
										<span class="text-fg-muted">—</span>
									{/if}
								</td>
							</tr>
							{#if isOpen}
								<tr class="border-t border-line bg-surface-elevated/30">
									<td colspan="5" class="px-4 py-3">
										{@render detailBlock(evt)}
									</td>
								</tr>
							{/if}
						{/each}
					</tbody>
				</table>
			</div>
		{/if}

		<div class="mt-4 flex items-center justify-between text-sm">
			<div class="text-fg-muted">Page {pageNumber} of {pageCount}</div>
			<div class="flex gap-2">
				<button
					type="button"
					disabled={!hasPrev}
					onclick={() => handleOffset(offset - PAGE_SIZE)}
					class="rounded-lg border border-line-strong bg-surface-overlay px-3 py-1.5 hover:bg-surface-input disabled:cursor-not-allowed disabled:opacity-40"
				>
					← Prev
				</button>
				<button
					type="button"
					disabled={!hasNext}
					onclick={() => handleOffset(offset + PAGE_SIZE)}
					class="rounded-lg border border-line-strong bg-surface-overlay px-3 py-1.5 hover:bg-surface-input disabled:cursor-not-allowed disabled:opacity-40"
				>
					Next →
				</button>
			</div>
		</div>
	</div>
</main>

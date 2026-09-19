<script lang="ts">
	import { onMount } from 'svelte';
	import type { DailyActivityCount, ScheduledAction } from '$lib/api.js';
	import {
		getActivityDaily,
		listAdvice,
		listDecisions,
		listInitiatives,
		listScheduledActions
	} from '$lib/api.js';
	import {
		STAT_VALUE_TONE,
		formatRunAt,
		groupByRhythm,
		metaFor,
		type StatTone
	} from './shared.svelte.js';

	// The Pulse header is the page's at-a-glance band: a strip of headline metrics
	// plus the "heartbeat" — a GitHub-contributions-style heatmap of the
	// Executive's self-initiated activity over the last 90 days. Every metric is
	// derived from data the page already needs (pending scheduled actions + the
	// three memory lists); only the per-day heatmap requires its own endpoint,
	// since /today/activity returns the last-N items, not a daily timeline.

	const HEATMAP_DAYS = 90;

	interface HeaderData {
		pending: ScheduledAction[];
		memoriesTotal: number;
		heatmap: DailyActivityCount[];
	}

	let data = $state<HeaderData | null>(null);
	let loading = $state(true);

	onMount(() => {
		const controller = new AbortController();
		let cancelled = false;
		loading = true;

		void Promise.all([
			listScheduledActions('pending', 200, controller.signal),
			listDecisions(),
			listInitiatives(),
			listAdvice(),
			getActivityDaily(HEATMAP_DAYS, controller.signal)
		])
			.then(([pending, decisions, initiatives, advice, daily]) => {
				if (cancelled) return;
				data = {
					pending,
					memoriesTotal: decisions.length + initiatives.length + advice.length,
					heatmap: daily.days
				};
			})
			.catch((err) => {
				if ((err as Error)?.name !== 'AbortError' && !cancelled) data = null;
			})
			.finally(() => {
				if (!cancelled) loading = false;
			});

		return () => {
			cancelled = true;
			controller.abort();
		};
	});

	const stats = $derived(data ? deriveStats(data) : null);

	// --------------------------------------------------------------------------- //
	// Stat derivation
	// --------------------------------------------------------------------------- //

	interface Stat {
		label: string;
		value: string | number;
		hint?: string;
		tone?: StatTone;
	}

	function deriveStats({ pending, memoriesTotal, heatmap }: HeaderData): Stat[] {
		const groups = groupByRhythm(pending);
		const followups = pending.filter((a) => a.kind === 'ad_hoc').length;

		// Soonest pending fire = the literal "next beat".
		const soonest = pending.reduce<ScheduledAction | null>((best, a) => {
			if (!best) return a;
			return a.run_at.localeCompare(best.run_at) < 0 ? a : best;
		}, null);
		const nextBeat = soonest
			? { value: formatRunAt(soonest.run_at).relative || 'soon', hint: metaFor(soonest).label }
			: { value: '—', hint: 'nothing scheduled' };

		// The heatmap is oldest → newest, so the last entry is today.
		const beatsToday = heatmap.length > 0 ? heatmap[heatmap.length - 1].count : 0;

		return [
			{ label: 'Beats today', value: beatsToday, tone: 'emerald', hint: 'actions fired' },
			{ label: 'Next beat', value: nextBeat.value, tone: 'accent', hint: nextBeat.hint },
			{ label: 'Daily rhythms', value: groups.daily.length },
			{ label: 'Dept check-ins', value: groups.departments.length },
			{ label: 'Follow-ups', value: followups },
			{ label: 'Memories', value: memoriesTotal }
		];
	}

	// --------------------------------------------------------------------------- //
	// Heatmap — GitHub-contributions-style grid (weeks as columns, weekdays as rows)
	// --------------------------------------------------------------------------- //

	// Intensity → background. Step 0 is an idle cell (surface), 1–4 ramp emerald.
	// These read correctly in both light and dark mode.
	const LEVEL_BG = [
		'bg-surface-input/60',
		'bg-emerald-500/30',
		'bg-emerald-500/55',
		'bg-emerald-400/80',
		'bg-emerald-400'
	];

	// Inclusive upper bound of each non-max step; a day's count maps to the first
	// step it fits under, else the top level. Length is LEVEL_BG.length − 1 so the
	// two arrays stay in lockstep (steps 0..3 here, step 4 = "more than 6").
	const INTENSITY_STOPS = [0, 1, 3, 6];

	function intensity(count: number): number {
		for (let i = 0; i < INTENSITY_STOPS.length; i++) {
			if (count <= INTENSITY_STOPS[i]) return i;
		}
		return INTENSITY_STOPS.length; // top level (= LEVEL_BG.length − 1)
	}

	/** UTC weekday (0=Sun) of a YYYY-MM-DD date string. */
	function weekday(date: string): number {
		return new Date(`${date}T00:00:00Z`).getUTCDay();
	}

	/** Chunk the dense day list into weekday-aligned columns of 7. */
	function toWeeks(days: DailyActivityCount[]): (DailyActivityCount | null)[][] {
		if (days.length === 0) return [];
		const cells: (DailyActivityCount | null)[] = [];
		for (let i = 0; i < weekday(days[0].date); i++) cells.push(null); // lead padding
		cells.push(...days);
		while (cells.length % 7 !== 0) cells.push(null); // trailing padding
		const weeks: (DailyActivityCount | null)[][] = [];
		for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
		return weeks;
	}
</script>

{#snippet skeleton(className: string)}
	<div
		class={`animate-pulse rounded-md bg-surface-input/60 motion-reduce:animate-none ${className}`}
		aria-hidden="true"
	></div>
{/snippet}

{#snippet livePulse(label = 'Live')}
	<span class="inline-flex items-center gap-1.5">
		<span class="relative flex h-2 w-2" aria-hidden="true">
			<span
				class="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75 motion-reduce:hidden"
			></span>
			<span class="relative inline-flex h-2 w-2 rounded-full bg-emerald-400"></span>
		</span>
		{#if label}
			<span class="text-[11px] font-medium tracking-wide text-emerald-300 uppercase">{label}</span>
		{/if}
	</span>
{/snippet}

{#snippet statTile(label: string, value: string | number, hint: string, tone: StatTone)}
	<div class="min-w-0 rounded-xl border border-line bg-surface-elevated px-4 py-3">
		<div class="truncate text-[11px] font-medium tracking-wide text-fg-subtle uppercase">
			{label}
		</div>
		<div class={`mt-1 truncate text-2xl font-semibold tabular-nums ${STAT_VALUE_TONE[tone]}`}>
			{value}
		</div>
		{#if hint}
			<div class="mt-0.5 truncate text-[11px] text-fg-muted">{hint}</div>
		{/if}
	</div>
{/snippet}

{#snippet heatmap(days: DailyActivityCount[])}
	{@const weeks = toWeeks(days)}
	{@const total = days.reduce((n, d) => n + d.count, 0)}
	<div>
		<div
			class="flex gap-1 overflow-x-auto pb-1"
			role="img"
			aria-label={`Activity heatmap: ${total} actions over the last ${days.length} days`}
		>
			<!-- Weeks and weekday cells are a fixed calendar grid: index keys are correct here. -->
			{#each weeks as week, wi (wi)}
				<div class="flex flex-col gap-1">
					{#each week as cell, di (di)}
						{#if cell === null}
							<div class="h-3 w-3"></div>
						{:else}
							<div
								class={`h-3 w-3 rounded-[3px] ${LEVEL_BG[intensity(cell.count)]}`}
								title={`${cell.date}: ${cell.count} ${cell.count === 1 ? 'action' : 'actions'}`}
								aria-label={`${cell.date}: ${cell.count} ${cell.count === 1 ? 'action' : 'actions'}`}
							></div>
						{/if}
					{/each}
				</div>
			{/each}
		</div>

		<!-- Legend -->
		<div class="mt-2 flex items-center justify-end gap-1.5 text-[11px] text-fg-subtle">
			<span>less</span>
			{#each LEVEL_BG as bg, i (i)}
				<span class={`h-3 w-3 rounded-[3px] ${bg}`} aria-hidden="true"></span>
			{/each}
			<span>more</span>
		</div>
	</div>
{/snippet}

<header class="space-y-6">
	<div>
		<h1 class="text-2xl font-semibold text-fg">Pulse</h1>
		<p class="mt-1 max-w-2xl text-sm text-fg-muted">
			What the Executive knows, and the rhythm it runs on — the briefs, reflections, and check-ins
			that fire on their own while you're away.
		</p>
	</div>

	<!-- Stat strip -->
	<div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
		{#if loading || !stats}
			{#each Array.from({ length: 6 }) as _, i (i)}
				<div class="rounded-xl border border-line bg-surface-elevated px-4 py-3">
					{@render skeleton('h-3 w-16')}
					{@render skeleton('mt-2 h-7 w-10')}
				</div>
			{/each}
		{:else}
			{#each stats as s (s.label)}
				{@render statTile(s.label, s.value, s.hint ?? '', s.tone ?? 'default')}
			{/each}
		{/if}
	</div>

	<!-- Heartbeat heatmap -->
	<section class="rounded-xl border border-line bg-surface-elevated p-4">
		<div class="mb-3 flex items-center justify-between gap-3">
			<div class="flex items-center gap-2">
				<h2 class="text-sm font-semibold text-fg">Heartbeat</h2>
				<span class="text-xs text-fg-subtle">last {HEATMAP_DAYS} days</span>
			</div>
			{@render livePulse()}
		</div>
		{#if loading || !data}
			{@render skeleton('h-24 w-full')}
		{:else}
			{@render heatmap(data.heatmap)}
		{/if}
	</section>
</header>

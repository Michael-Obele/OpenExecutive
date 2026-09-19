<script module lang="ts">
	// The company-profile section editors, extracted from app/company-profile/page.tsx
	// so the onboarding draft-review screen can reuse the exact editing surface the
	// user gets permanently afterwards.
	//
	// The seam is `onSave`: the page passes a function that PATCHes the backend,
	// while onboarding passes one that merges into local draft state. Nothing else
	// differs, so there is only ever one implementation of these nine sections.
	import type { CompanyProfile } from '$lib/api.js';

	function textToList(text: string): string[] {
		return text
			.split('\n')
			.map((s) => s.trim())
			.filter(Boolean);
	}

	// ── Ask OE plumbing ──────────────────────────────────────────────────────
	// The profile page registers one flat form descriptor covering every section;
	// when Ask OE proposes values they are handed to `applyValues` below, which
	// merges each section's own keys into its draft state and flips it into edit
	// mode — so the user reviews through the section's normal Save button.

	/** Accepts a string[] or a newline-joined string (models send either). */
	export function coerceList(raw: unknown): string[] | null {
		if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === 'string');
		if (typeof raw === 'string') return textToList(raw);
		return null;
	}

	export const TEXT_FIELDS = new Set([
		'name',
		'industry',
		'stage',
		'mission',
		'vision',
		'target_customer_profile',
		'north_star_metric'
	]);
	export const NUM_FIELDS = new Set([
		'founding_year',
		'headcount',
		'annual_revenue_arr',
		'burn_rate_monthly',
		'runway_months'
	]);
	export const LIST_FIELDS = new Set([
		'pain_points',
		'primary_competitors',
		'competitive_advantages',
		'priorities',
		'culture_values',
		'operating_principles',
		'departments',
		'leadership_team',
		'vendors',
		'tickers'
	]);

	/** Flat snapshot of the SAVED profile — feeds both the Ask OE form
	 * descriptor (getFields) and the undo restore values. */
	export function snapshotProfile(profile: CompanyProfile): Record<string, unknown> {
		return {
			name: profile.name,
			industry: profile.industry,
			stage: profile.stage,
			founding_year: profile.founding_year,
			headcount: profile.headcount,
			annual_revenue_arr: profile.annual_revenue_arr,
			mission: profile.mission,
			vision: profile.vision,
			target_customer_profile: profile.target_customer.profile,
			pain_points: profile.target_customer.pain_points,
			primary_competitors: profile.competitive_landscape.primary_competitors,
			competitive_advantages: profile.competitive_landscape.competitive_advantages,
			vendors: profile.vendors ?? [],
			tickers: profile.tickers ?? [],
			priorities: profile.strategic_priorities.current_year,
			north_star_metric: profile.strategic_priorities.north_star_metric,
			culture_values: profile.culture.values,
			operating_principles: profile.culture.operating_principles,
			departments: profile.org_structure.departments,
			leadership_team: profile.org_structure.leadership_team,
			burn_rate_monthly: profile.financials.burn_rate_monthly,
			runway_months: profile.financials.runway_months
		};
	}
</script>

<script lang="ts">
	// React held one draft-state block per section component. Svelte keeps one
	// component per file, so the drafts are hoisted here and every section is
	// rendered through the shared `sectionShell` snippet. Drafts are seeded from
	// the SAVED profile when a section enters edit mode (the upstream per-section
	// `useEffect(..., [profile])` did the same, only eagerly).
	import type { Snippet } from 'svelte';

	function listToText(items: string[]): string {
		return items.join('\n');
	}

	const INPUT_CLS =
		'w-full rounded-lg border border-line-strong bg-surface-overlay px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-2 focus:ring-indigo-500/50 focus:border-indigo-500/50 transition-colors';
	const TEXTAREA_CLS = `${INPUT_CLS} resize-none`;

	const PH_PAIN_POINTS = 'Too slow to onboard\nNo visibility into data';
	const PH_COMPETITORS = 'Salesforce\nHubSpot';
	const PH_ADVANTAGES = '10x faster onboarding\nOpen source';
	const PH_VENDORS = 'Stripe\nAWS';
	const PH_TICKERS = 'CRM\nHUBS';
	const PH_PRIORITIES = 'Launch v1\nHire 3 engineers';
	const PH_VALUES = 'Transparency\nBias for action';
	const PH_PRINCIPLES = 'Default to async\nWrite it down';
	const PH_DEPARTMENTS = 'Engineering\nProduct\nGTM';
	const PH_LEADERSHIP = 'Alice Chen, CEO\nBob Smith, CTO';

	type SectionId =
		| 'basics'
		| 'mission'
		| 'customer'
		| 'competitive'
		| 'dependencies'
		| 'priorities'
		| 'culture'
		| 'org'
		| 'financials';

	const SECTION_ORDER: { id: SectionId; title: string }[] = [
		{ id: 'basics', title: 'Company Basics' },
		{ id: 'mission', title: 'Mission & Vision' },
		{ id: 'customer', title: 'Target Customer' },
		{ id: 'competitive', title: 'Competitive Landscape' },
		// vendors + tickers the research policy may watch on its own
		{ id: 'dependencies', title: 'External Dependencies' },
		{ id: 'priorities', title: 'Strategic Priorities' },
		{ id: 'culture', title: 'Culture & Values' },
		{ id: 'org', title: 'Org Structure' },
		{ id: 'financials', title: 'Financials' }
	];

	interface Props {
		profile: CompanyProfile;
		saving: boolean;
		/** PATCHes the backend on the profile page; merges into local state on the
		 * onboarding draft screen. That swap is the whole reason this is a component. */
		onSave: (patch: Partial<CompanyProfile>) => Promise<void>;
		/** Sections to leave out. Onboarding omits "org" because org_structure is
		 * derived from its people and department tables at commit time — rendering
		 * it here too would give the user two places to edit the same thing. */
		omit?: SectionId[];
	}

	let { profile, saving, onSave, omit = [] }: Props = $props();

	// ── drafts (one block per section, as upstream) ───────────────────────────
	let name = $state('');
	let industry = $state('');
	let stage = $state('');
	let foundingYear = $state('');
	let headcount = $state('');
	let arr = $state('');

	let mission = $state('');
	let vision = $state('');

	let customerProfile = $state('');
	let painPoints = $state('');

	let competitors = $state('');
	let advantages = $state('');

	let vendors = $state('');
	let tickers = $state('');

	let priorities = $state('');
	let northStar = $state('');

	let cultureValues = $state('');
	let principles = $state('');

	let departments = $state('');
	let leadership = $state('');

	let burn = $state('');
	let runway = $state('');

	const editing = $state<Record<SectionId, boolean>>({
		basics: false,
		mission: false,
		customer: false,
		competitive: false,
		dependencies: false,
		priorities: false,
		culture: false,
		org: false,
		financials: false
	});
	const errors = $state<Record<SectionId, string | null>>({
		basics: null,
		mission: null,
		customer: null,
		competitive: null,
		dependencies: null,
		priorities: null,
		culture: null,
		org: null,
		financials: null
	});

	/** Pulls a section's drafts from the SAVED profile — mirrors the upstream
	 * `useEffect(() => { setX(profile.x); ... }, [profile])` in each section. */
	const SEEDS: Record<SectionId, () => void> = {
		basics: () => {
			name = profile.name;
			industry = profile.industry;
			stage = profile.stage;
			foundingYear = profile.founding_year?.toString() ?? '';
			headcount = profile.headcount?.toString() ?? '';
			arr = profile.annual_revenue_arr?.toString() ?? '';
		},
		mission: () => {
			mission = profile.mission;
			vision = profile.vision;
		},
		customer: () => {
			customerProfile = profile.target_customer.profile;
			painPoints = listToText(profile.target_customer.pain_points);
		},
		competitive: () => {
			competitors = listToText(profile.competitive_landscape.primary_competitors);
			advantages = listToText(profile.competitive_landscape.competitive_advantages);
		},
		dependencies: () => {
			vendors = listToText(profile.vendors ?? []);
			tickers = listToText(profile.tickers ?? []);
		},
		priorities: () => {
			priorities = listToText(profile.strategic_priorities.current_year);
			northStar = profile.strategic_priorities.north_star_metric;
		},
		culture: () => {
			cultureValues = listToText(profile.culture.values);
			principles = listToText(profile.culture.operating_principles);
		},
		org: () => {
			departments = listToText(profile.org_structure.departments);
			leadership = listToText(profile.org_structure.leadership_team);
		},
		financials: () => {
			burn = profile.financials.burn_rate_monthly?.toString() ?? '';
			runway = profile.financials.runway_months?.toString() ?? '';
		}
	};

	const PATCHES: Record<SectionId, () => Partial<CompanyProfile>> = {
		basics: () => ({
			name,
			industry,
			stage,
			founding_year: foundingYear ? parseInt(foundingYear) : null,
			headcount: headcount ? parseInt(headcount) : null,
			annual_revenue_arr: arr ? parseFloat(arr) : null
		}),
		mission: () => ({ mission, vision }),
		customer: () => ({
			target_customer: {
				profile: customerProfile,
				pain_points: textToList(painPoints)
			}
		}),
		competitive: () => ({
			competitive_landscape: {
				primary_competitors: textToList(competitors),
				competitive_advantages: textToList(advantages)
			}
		}),
		dependencies: () => ({
			vendors: textToList(vendors),
			tickers: textToList(tickers)
		}),
		priorities: () => ({
			strategic_priorities: {
				current_year: textToList(priorities),
				north_star_metric: northStar
			}
		}),
		culture: () => ({
			culture: {
				values: textToList(cultureValues),
				operating_principles: textToList(principles)
			}
		}),
		org: () => ({
			org_structure: {
				departments: textToList(departments),
				leadership_team: textToList(leadership)
			}
		}),
		financials: () => ({
			financials: {
				burn_rate_monthly: burn ? parseFloat(burn) : null,
				runway_months: runway ? parseFloat(runway) : null,
				key_metrics: profile.financials.key_metrics
			}
		})
	};

	/** Flat key → section + draft setter, the Svelte equivalent of the upstream
	 * `usePendingSection(pending, appliers)` maps. Values arrive already
	 * validated/coerced by the page. */
	const APPLIERS: Record<string, { section: SectionId; apply: (v: unknown) => void }> = {
		name: { section: 'basics', apply: (v) => (name = String(v)) },
		industry: { section: 'basics', apply: (v) => (industry = String(v)) },
		stage: { section: 'basics', apply: (v) => (stage = String(v)) },
		founding_year: {
			section: 'basics',
			apply: (v) => (foundingYear = v == null ? '' : String(v))
		},
		headcount: { section: 'basics', apply: (v) => (headcount = v == null ? '' : String(v)) },
		annual_revenue_arr: { section: 'basics', apply: (v) => (arr = v == null ? '' : String(v)) },
		mission: { section: 'mission', apply: (v) => (mission = String(v)) },
		vision: { section: 'mission', apply: (v) => (vision = String(v)) },
		target_customer_profile: {
			section: 'customer',
			apply: (v) => (customerProfile = String(v))
		},
		pain_points: { section: 'customer', apply: (v) => (painPoints = listToText(v as string[])) },
		primary_competitors: {
			section: 'competitive',
			apply: (v) => (competitors = listToText(v as string[]))
		},
		competitive_advantages: {
			section: 'competitive',
			apply: (v) => (advantages = listToText(v as string[]))
		},
		vendors: { section: 'dependencies', apply: (v) => (vendors = listToText(v as string[])) },
		tickers: { section: 'dependencies', apply: (v) => (tickers = listToText(v as string[])) },
		priorities: {
			section: 'priorities',
			apply: (v) => (priorities = listToText(v as string[]))
		},
		north_star_metric: { section: 'priorities', apply: (v) => (northStar = String(v)) },
		culture_values: {
			section: 'culture',
			apply: (v) => (cultureValues = listToText(v as string[]))
		},
		operating_principles: {
			section: 'culture',
			apply: (v) => (principles = listToText(v as string[]))
		},
		departments: { section: 'org', apply: (v) => (departments = listToText(v as string[])) },
		leadership_team: { section: 'org', apply: (v) => (leadership = listToText(v as string[])) },
		burn_rate_monthly: {
			section: 'financials',
			apply: (v) => (burn = v == null ? '' : String(v))
		},
		runway_months: {
			section: 'financials',
			apply: (v) => (runway = v == null ? '' : String(v))
		}
	};

	function enterEdit(id: SectionId) {
		if (!editing[id]) SEEDS[id]();
		editing[id] = true;
	}

	function cancelEdit(id: SectionId) {
		editing[id] = false;
		errors[id] = null;
	}

	async function handleSave(id: SectionId) {
		errors[id] = null;
		try {
			await onSave(PATCHES[id]());
			editing[id] = false;
		} catch {
			errors[id] = 'Save failed. Please try again.';
		}
	}

	/**
	 * Apply Ask OE values (flat keys) into the matching sections' drafts and open
	 * those sections for review. A no-op for unknown keys. Called by the page
	 * through `bind:this` — the panel's patch has to land in THIS component's
	 * state, so props alone cannot carry it.
	 */
	export function applyValues(values: Record<string, unknown>): void {
		const touched: SectionId[] = [];
		for (const [key, raw] of Object.entries(values)) {
			const entry = APPLIERS[key];
			if (!entry) continue;
			if (!editing[entry.section]) SEEDS[entry.section]();
			entry.apply(raw);
			if (!touched.includes(entry.section)) touched.push(entry.section);
		}
		for (const id of touched) editing[id] = true;
	}
</script>

<!-- ── shared pieces ──────────────────────────────────────────────────────── -->

{#snippet fieldLabel(text: string)}
	<p class="mb-1 text-xs font-medium tracking-wide text-fg-muted uppercase">{text}</p>
{/snippet}

{#snippet fieldValue(value: string | number | null | undefined)}
	<p class="text-sm text-fg">
		{#if value === '' || value === null || value === undefined}
			<span class="text-fg-subtle italic">Not set</span>
		{:else}
			{value}
		{/if}
	</p>
{/snippet}

{#snippet pills(items: string[])}
	{#if !items.length}
		<span class="text-sm text-fg-subtle italic">Not set</span>
	{:else}
		<div class="flex flex-wrap gap-1.5">
			{#each items as item, i (i)}
				<span class="inline-block rounded-md bg-surface-overlay px-2 py-0.5 text-xs text-fg"
					>{item}</span
				>
			{/each}
		</div>
	{/if}
{/snippet}

{#snippet sectionShell(id: SectionId, title: string, view: Snippet, edit: Snippet)}
	<div class="rounded-xl border border-line bg-surface-elevated p-5">
		<div class="mb-4 flex items-center justify-between">
			<h2 class="text-sm font-semibold text-fg">{title}</h2>
			{#if !editing[id]}
				<button
					type="button"
					onclick={() => enterEdit(id)}
					class="text-xs text-indigo-400 transition-colors hover:text-indigo-300"
				>
					Edit
				</button>
			{/if}
		</div>

		{#if editing[id]}
			{@render edit()}
		{:else}
			{@render view()}
		{/if}

		{#if editing[id]}
			{#if errors[id]}
				<p class="mt-3 text-xs text-red-400" role="alert">{errors[id]}</p>
			{/if}
			<div class="mt-4 flex gap-2">
				<button
					type="button"
					onclick={() => void handleSave(id)}
					disabled={saving}
					class="rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-600 disabled:opacity-40"
				>
					{saving ? 'Saving…' : 'Save'}
				</button>
				<button
					type="button"
					onclick={() => cancelEdit(id)}
					disabled={saving}
					class="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
				>
					Cancel
				</button>
			</div>
		{/if}
	</div>
{/snippet}

<!-- ── Company Basics ─────────────────────────────────────────────────────── -->

{#snippet viewBasics()}
	<div class="grid grid-cols-2 gap-x-8 gap-y-4">
		<div>{@render fieldLabel('Name')}{@render fieldValue(profile.name)}</div>
		<div>{@render fieldLabel('Industry')}{@render fieldValue(profile.industry)}</div>
		<div>{@render fieldLabel('Stage')}{@render fieldValue(profile.stage)}</div>
		<div>
			{@render fieldLabel('Founded')}{@render fieldValue(profile.founding_year?.toString())}
		</div>
		<div>
			{@render fieldLabel('Headcount')}{@render fieldValue(profile.headcount?.toString())}
		</div>
		<div>
			{@render fieldLabel('ARR')}
			{@render fieldValue(
				profile.annual_revenue_arr != null
					? `$${profile.annual_revenue_arr.toLocaleString()}`
					: undefined
			)}
		</div>
	</div>
{/snippet}

{#snippet editBasics()}
	<div class="grid grid-cols-2 gap-3">
		<div>
			{@render fieldLabel('Name')}
			<input bind:value={name} placeholder="Acme Corp" aria-label="Name" class={INPUT_CLS} />
		</div>
		<div>
			{@render fieldLabel('Industry')}
			<input bind:value={industry} placeholder="B2B SaaS" aria-label="Industry" class={INPUT_CLS} />
		</div>
		<div>
			{@render fieldLabel('Stage')}
			<input bind:value={stage} placeholder="Series A" aria-label="Stage" class={INPUT_CLS} />
		</div>
		<div>
			{@render fieldLabel('Founded')}
			<input
				value={foundingYear}
				oninput={(e) => (foundingYear = e.currentTarget.value)}
				type="number"
				placeholder="2022"
				aria-label="Founded"
				class={INPUT_CLS}
			/>
		</div>
		<div>
			{@render fieldLabel('Headcount')}
			<input
				value={headcount}
				oninput={(e) => (headcount = e.currentTarget.value)}
				type="number"
				placeholder="40"
				aria-label="Headcount"
				class={INPUT_CLS}
			/>
		</div>
		<div>
			{@render fieldLabel('ARR ($)')}
			<input
				value={arr}
				oninput={(e) => (arr = e.currentTarget.value)}
				type="number"
				placeholder="500000"
				aria-label="ARR"
				class={INPUT_CLS}
			/>
		</div>
	</div>
{/snippet}

<!-- ── Mission & Vision ───────────────────────────────────────────────────── -->

{#snippet viewMission()}
	<div class="space-y-4">
		<div>{@render fieldLabel('Mission')}{@render fieldValue(profile.mission)}</div>
		<div>{@render fieldLabel('Vision')}{@render fieldValue(profile.vision)}</div>
	</div>
{/snippet}

{#snippet editMission()}
	<div class="space-y-3">
		<div>
			{@render fieldLabel('Mission')}
			<textarea
				bind:value={mission}
				rows={2}
				placeholder="Why does this company exist?"
				aria-label="Mission"
				class={TEXTAREA_CLS}></textarea>
		</div>
		<div>
			{@render fieldLabel('Vision')}
			<textarea
				bind:value={vision}
				rows={2}
				placeholder="Where are you in 5 years?"
				aria-label="Vision"
				class={TEXTAREA_CLS}></textarea>
		</div>
	</div>
{/snippet}

<!-- ── Target Customer ────────────────────────────────────────────────────── -->

{#snippet viewCustomer()}
	<div class="space-y-4">
		<div>
			{@render fieldLabel('Customer Profile')}
			{@render fieldValue(profile.target_customer.profile)}
		</div>
		<div>
			{@render fieldLabel('Pain Points')}{@render pills(profile.target_customer.pain_points)}
		</div>
	</div>
{/snippet}

{#snippet editCustomer()}
	<div class="space-y-3">
		<div>
			{@render fieldLabel('Customer Profile')}
			<textarea
				bind:value={customerProfile}
				rows={2}
				placeholder="Who is your ideal customer?"
				aria-label="Customer Profile"
				class={TEXTAREA_CLS}></textarea>
		</div>
		<div>
			{@render fieldLabel('Pain Points (one per line)')}
			<textarea
				bind:value={painPoints}
				rows={3}
				placeholder={PH_PAIN_POINTS}
				aria-label="Pain Points (one per line)"
				class={TEXTAREA_CLS}></textarea>
		</div>
	</div>
{/snippet}

<!-- ── Competitive Landscape ──────────────────────────────────────────────── -->

{#snippet viewCompetitive()}
	<div class="space-y-4">
		<div>
			{@render fieldLabel('Primary Competitors')}
			{@render pills(profile.competitive_landscape.primary_competitors)}
		</div>
		<div>
			{@render fieldLabel('Our Advantages')}
			{@render pills(profile.competitive_landscape.competitive_advantages)}
		</div>
	</div>
{/snippet}

{#snippet editCompetitive()}
	<div class="space-y-3">
		<div>
			{@render fieldLabel('Competitors (one per line)')}
			<textarea
				bind:value={competitors}
				rows={3}
				placeholder={PH_COMPETITORS}
				aria-label="Competitors (one per line)"
				class={TEXTAREA_CLS}></textarea>
		</div>
		<div>
			{@render fieldLabel('Our Advantages (one per line)')}
			<textarea
				bind:value={advantages}
				rows={3}
				placeholder={PH_ADVANTAGES}
				aria-label="Our Advantages (one per line)"
				class={TEXTAREA_CLS}></textarea>
		</div>
	</div>
{/snippet}

<!-- ── External Dependencies ──────────────────────────────────────────────── -->

{#snippet viewDependencies()}
	<div class="space-y-4">
		<p class="text-xs text-fg-subtle">
			Named here, a vendor or ticker counts as company data: the Executive will start watching its
			status page or filings on its own instead of asking you first.
		</p>
		<div>
			{@render fieldLabel('Vendors & dependencies')}
			{@render pills(profile.vendors ?? [])}
		</div>
		<div>
			{@render fieldLabel('Tracked tickers')}
			{@render pills(profile.tickers ?? [])}
		</div>
	</div>
{/snippet}

{#snippet editDependencies()}
	<div class="space-y-3">
		<div>
			{@render fieldLabel('Vendors (one per line)')}
			<textarea
				bind:value={vendors}
				rows={3}
				placeholder={PH_VENDORS}
				aria-label="Vendors (one per line)"
				class={TEXTAREA_CLS}></textarea>
		</div>
		<div>
			{@render fieldLabel('Tickers (one per line — yours and competitors&apos;)')}
			<textarea
				bind:value={tickers}
				rows={3}
				placeholder={PH_TICKERS}
				aria-label="Tickers (one per line)"
				class={TEXTAREA_CLS}></textarea>
		</div>
	</div>
{/snippet}

<!-- ── Strategic Priorities ───────────────────────────────────────────────── -->

{#snippet viewPriorities()}
	<div class="space-y-4">
		<div>
			{@render fieldLabel("This Year's Priorities")}
			{@render pills(profile.strategic_priorities.current_year)}
		</div>
		<div>
			{@render fieldLabel('North Star Metric')}
			{@render fieldValue(profile.strategic_priorities.north_star_metric)}
		</div>
	</div>
{/snippet}

{#snippet editPriorities()}
	<div class="space-y-3">
		<div>
			{@render fieldLabel('Priorities (one per line)')}
			<textarea
				bind:value={priorities}
				rows={3}
				placeholder={PH_PRIORITIES}
				aria-label="Priorities (one per line)"
				class={TEXTAREA_CLS}></textarea>
		</div>
		<div>
			{@render fieldLabel('North Star Metric')}
			<input
				bind:value={northStar}
				placeholder="MRR or DAU"
				aria-label="North Star Metric"
				class={INPUT_CLS}
			/>
		</div>
	</div>
{/snippet}

<!-- ── Culture & Values ───────────────────────────────────────────────────── -->

{#snippet viewCulture()}
	<div class="space-y-4">
		<div>{@render fieldLabel('Values')}{@render pills(profile.culture.values)}</div>
		<div>
			{@render fieldLabel('Operating Principles')}
			{@render pills(profile.culture.operating_principles)}
		</div>
	</div>
{/snippet}

{#snippet editCulture()}
	<div class="space-y-3">
		<div>
			{@render fieldLabel('Values (one per line)')}
			<textarea
				bind:value={cultureValues}
				rows={3}
				placeholder={PH_VALUES}
				aria-label="Values (one per line)"
				class={TEXTAREA_CLS}></textarea>
		</div>
		<div>
			{@render fieldLabel('Operating Principles (one per line)')}
			<textarea
				bind:value={principles}
				rows={3}
				placeholder={PH_PRINCIPLES}
				aria-label="Operating Principles (one per line)"
				class={TEXTAREA_CLS}></textarea>
		</div>
	</div>
{/snippet}

<!-- ── Org Structure ──────────────────────────────────────────────────────── -->

{#snippet viewOrg()}
	<div class="space-y-4">
		<div>
			{@render fieldLabel('Departments')}
			{@render pills(profile.org_structure.departments)}
		</div>
		<div>
			{@render fieldLabel('Leadership Team')}
			{@render pills(profile.org_structure.leadership_team)}
		</div>
	</div>
{/snippet}

{#snippet editOrg()}
	<div class="space-y-3">
		<div>
			{@render fieldLabel('Departments (one per line)')}
			<textarea
				bind:value={departments}
				rows={3}
				placeholder={PH_DEPARTMENTS}
				aria-label="Departments (one per line)"
				class={TEXTAREA_CLS}></textarea>
		</div>
		<div>
			{@render fieldLabel('Leadership Team (one per line)')}
			<textarea
				bind:value={leadership}
				rows={3}
				placeholder={PH_LEADERSHIP}
				aria-label="Leadership Team (one per line)"
				class={TEXTAREA_CLS}></textarea>
		</div>
	</div>
{/snippet}

<!-- ── Financials ─────────────────────────────────────────────────────────── -->

{#snippet viewFinancials()}
	<div class="grid grid-cols-2 gap-x-8 gap-y-4">
		<div>
			{@render fieldLabel('Monthly Burn')}
			{@render fieldValue(
				profile.financials.burn_rate_monthly != null
					? `$${profile.financials.burn_rate_monthly.toLocaleString()}/mo`
					: undefined
			)}
		</div>
		<div>
			{@render fieldLabel('Runway')}
			{@render fieldValue(
				profile.financials.runway_months != null
					? `${profile.financials.runway_months} months`
					: undefined
			)}
		</div>
	</div>
{/snippet}

{#snippet editFinancials()}
	<div class="grid grid-cols-2 gap-3">
		<div>
			{@render fieldLabel('Monthly Burn ($)')}
			<input
				value={burn}
				oninput={(e) => (burn = e.currentTarget.value)}
				type="number"
				placeholder="50000"
				aria-label="Monthly Burn"
				class={INPUT_CLS}
			/>
		</div>
		<div>
			{@render fieldLabel('Runway (months)')}
			<input
				value={runway}
				oninput={(e) => (runway = e.currentTarget.value)}
				type="number"
				placeholder="18"
				aria-label="Runway (months)"
				class={INPUT_CLS}
			/>
		</div>
	</div>
{/snippet}

<!-- ── composed section list ──────────────────────────────────────────────── -->

<div class="flex flex-col gap-4">
	{#each SECTION_ORDER as section (section.id)}
		{#if !omit.includes(section.id)}
			{#if section.id === 'basics'}
				{@render sectionShell(section.id, section.title, viewBasics, editBasics)}
			{:else if section.id === 'mission'}
				{@render sectionShell(section.id, section.title, viewMission, editMission)}
			{:else if section.id === 'customer'}
				{@render sectionShell(section.id, section.title, viewCustomer, editCustomer)}
			{:else if section.id === 'competitive'}
				{@render sectionShell(section.id, section.title, viewCompetitive, editCompetitive)}
			{:else if section.id === 'dependencies'}
				{@render sectionShell(section.id, section.title, viewDependencies, editDependencies)}
			{:else if section.id === 'priorities'}
				{@render sectionShell(section.id, section.title, viewPriorities, editPriorities)}
			{:else if section.id === 'culture'}
				{@render sectionShell(section.id, section.title, viewCulture, editCulture)}
			{:else if section.id === 'org'}
				{@render sectionShell(section.id, section.title, viewOrg, editOrg)}
			{:else}
				{@render sectionShell(section.id, section.title, viewFinancials, editFinancials)}
			{/if}
		{/if}
	{/each}
</div>

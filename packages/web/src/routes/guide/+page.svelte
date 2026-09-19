<script lang="ts" module>
	// The section nav is hardcoded so the sidebar renders instantly without
	// waiting for the backend. IDs must match the GUIDE_SECTIONS registry in
	// packages/core/openexecutive/guide/sections.py.
	const SECTIONS = [
		{
			id: 'chat',
			label: 'Chat & Briefing',
			sub: "The main surface — talk to the Executive, and land on a briefing of what's happened."
		},
		{
			id: 'ask_oe',
			label: 'Ask OE',
			sub: 'The page-aware assistant panel — explains any screen and fills forms for you to review.'
		},
		{
			id: 'today',
			label: 'Today / Morning Brief',
			sub: 'What needs you right now: proposals, department health, and people with open items.'
		},
		{
			id: 'pulse',
			label: 'Pulse (Memory)',
			sub: "The Executive's running memory — decisions made, initiatives in flight, advice gathered."
		},
		{
			id: 'review',
			label: 'Review Queue',
			sub: 'Approve, reject, or correct incoming knowledge before the Executive relies on it.'
		},
		{
			id: 'jobs',
			label: 'Jobs (Workflows)',
			sub: 'Multi-step workflows that produce a deliverable — board prep, GTM plan, perf review.'
		},
		{
			id: 'artifacts',
			label: 'Artifacts',
			sub: 'Your library of finished documents — drafts and workflow outputs in one place.'
		},
		{
			id: 'watchlist',
			label: 'Watch List',
			sub: 'External monitors — stock tickers, RSS feeds, status pages, web queries — that raise alerts.'
		},
		{
			id: 'departments',
			label: 'Departments',
			sub: 'Org units, each with goals, an authority level, and a specialist behind it.'
		},
		{
			id: 'people',
			label: 'People',
			sub: 'Your roster — who the Executive coordinates with, their SLAs, channels, and approval scopes.'
		},
		{
			id: 'talent',
			label: 'Talent',
			sub: 'Candidate searches and hiring — engagements, pipeline stages, scoring, and offers.'
		},
		{
			id: 'staff_onboarding',
			label: 'Staff onboarding',
			sub: 'Templated ramp-up plans for new hires — tasks, phases, check-ins, and welcome briefs.'
		},
		{
			id: 'company_profile',
			label: 'Company Profile & Onboarding',
			sub: "Your company's identity and strategy — set up once, edited any time."
		},
		{
			id: 'knowledge',
			label: 'Knowledge base',
			sub: 'Upload company documents so the Executive can ground its answers in your context.'
		},
		{
			id: 'skills',
			label: 'Skills',
			sub: 'Reusable how-to procedures the Executive can pull up — checklists, playbooks, templates.'
		},
		{
			id: 'council',
			label: 'Agent Council',
			sub: "Configure the specialists — models, prompts, reasoning depth, and the Executive's voice."
		},
		{
			id: 'audit',
			label: 'Audit Log',
			sub: 'A searchable record of every turn, consult, tool call, alert, and scheduled action.'
		},
		{
			id: 'token_usage',
			label: 'Token Usage',
			sub: 'Where your spend goes — tokens and cost by day, model, and session.'
		},
		{
			id: 'simulator',
			label: 'Company Simulator',
			sub: 'Load a realistic test company to try the Executive before trusting it with real data.'
		},
		{
			id: 'clients',
			label: 'Client Companies',
			sub: 'Multi-client mode for fractional work — switch the live company between named client slots.'
		},
		{
			id: 'integrations',
			label: 'Integrations',
			sub: 'Reach the Executive where you already work — Slack, Discord, Telegram, email, Google Chat, MCP.'
		},
		{
			id: 'settings',
			label: 'Settings & Advanced',
			sub: 'The hub for power-user tools that sit outside the day-to-day nav — including this guide.'
		}
	];

	interface SectionMeta {
		id: string;
		fresh: boolean;
		generated_at: string | null;
	}
</script>

<script lang="ts">
	// User Guide route.
	// Ported from `packages/ui/src/app/guide/page.tsx`.
	import { onMount } from 'svelte';
	import DynamicSection from '$lib/components/architecture/DynamicSection.svelte';

	let activeSection = $state('chat');
	let sectionMeta = $state.raw<Record<string, SectionMeta>>({});
	let observer: IntersectionObserver | null = null;

	onMount(() => {
		// Single cheap listing call — no generation triggered.
		fetch('/api/backend/guide/sections')
			.then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
			.then((data: { sections: SectionMeta[] }) => {
				const map: Record<string, SectionMeta> = {};
				for (const s of data.sections) map[s.id] = s;
				sectionMeta = map;
			})
			.catch(() => {});

		// External side effect: an IntersectionObserver tracking which section is
		// in view, so the sidebar can highlight it.
		observer = new IntersectionObserver(
			(entries) => {
				for (const e of entries) if (e.isIntersecting) activeSection = e.target.id;
			},
			{ rootMargin: '-20% 0px -70% 0px', threshold: 0 }
		);
		for (const { id } of SECTIONS) {
			const el = document.getElementById(id);
			if (el) observer.observe(el);
		}

		return () => observer?.disconnect();
	});

	let freshCount = $derived(Object.values(sectionMeta).filter((s) => s.fresh).length);
	const totalCount = SECTIONS.length;

	function handleNavClick(event: MouseEvent, id: string) {
		event.preventDefault();
		document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
	}
</script>

<div class="flex min-h-0 flex-1 overflow-hidden bg-surface text-fg">
	<aside class="flex w-52 shrink-0 flex-col border-r border-line bg-surface-elevated">
		<div class="px-3 py-4">
			<p class="mb-2 px-2 text-[10px] font-semibold tracking-widest text-fg-subtle uppercase">
				User Guide
			</p>
			<nav class="space-y-0.5">
				{#each SECTIONS as { id, label } (id)}
					<a
						href={`#${id}`}
						onclick={(e) => handleNavClick(e, id)}
						class={`flex items-center gap-2 rounded-lg px-2 py-1.5 text-xs transition-colors ${
							activeSection === id
								? 'bg-indigo-500/10 text-indigo-400'
								: 'text-fg-muted hover:bg-surface-overlay/60 hover:text-fg'
						}`}
					>
						<span
							class={`inline-block h-1.5 w-1.5 rounded-full ${
								sectionMeta[id]?.fresh ? 'bg-emerald-500/60' : 'bg-surface-input'
							}`}
						></span>
						<span>{label}</span>
					</a>
				{/each}
			</nav>
		</div>

		<div class="mt-auto space-y-1.5 border-t border-line px-4 py-4">
			<p class="mb-2 text-[10px] font-semibold tracking-widest text-fg-subtle uppercase">
				Reference
			</p>
			<div class="flex justify-between text-xs">
				<span class="text-fg-subtle">Features</span>
				<span class="font-mono text-fg-muted">{freshCount} / {totalCount}</span>
			</div>
			<p class="text-[10px] leading-relaxed text-fg-subtle">
				Plain-language overviews of what each feature is and what it does. For how the system is
				built, see the Architecture reference.
			</p>
		</div>
	</aside>

	<main class="flex-1 overflow-y-auto">
		<div class="mx-auto max-w-4xl space-y-20 px-8 py-10">
			<div>
				<h1 class="text-2xl font-bold text-fg">Open Executive — User Guide</h1>
				<p class="mt-2 text-sm text-fg-muted">
					A quick tour of every feature: what it is, and what it does for you. Not a manual — just
					enough to know where to go and why. For the technical internals, see the Architecture
					reference.
				</p>
			</div>

			{#each SECTIONS as { id, label, sub } (id)}
				<DynamicSection {id} title={label} {sub} basePath="guide" />
			{/each}
		</div>
	</main>
</div>

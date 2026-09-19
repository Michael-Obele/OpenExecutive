<script lang="ts" module>
	// The section nav is hardcoded so the sidebar renders instantly without
	// waiting for the backend. IDs must match the SECTIONS registry in
	// packages/core/openexecutive/architecture/sections.py.
	const SECTIONS = [
		// "Without the Jargon" — plain-language landing cluster for non-engineers.
		{
			id: 'nojargon_what_it_is',
			label: 'Without the Jargon: What It Is',
			sub: 'The 90-second version. A virtual executive with a council of specialists.'
		},
		{
			id: 'nojargon_authority',
			label: 'Without the Jargon: How It Decides To Act',
			sub: 'Three modes — act on its own, propose for approval, or escalate to you.'
		},
		{
			id: 'nojargon_proactive',
			label: "Without the Jargon: When You're Not Watching",
			sub: "Morning brief, check-ins, nudges — Open Executive doesn't wait to be asked."
		},
		{
			id: 'nojargon_org',
			label: 'Without the Jargon: Who Approves What',
			sub: 'Departments, heads, and approval tags — how proposals find the right person.'
		},
		{
			id: 'overview',
			label: 'System Overview',
			sub: 'High-level topology: clients, API, orchestrator, specialist agents, knowledge layer.'
		},
		{
			id: 'lifecycle',
			label: 'Request Lifecycle',
			sub: 'Full round-trip of a single chat message, including tool-use loop and parallel specialist calls.'
		},
		{
			id: 'agents',
			label: 'Agent Council',
			sub: 'The Executive orchestrator and its specialist sub-agents — roles, models, and domains.'
		},
		{
			id: 'caching',
			label: 'Prompt Caching',
			sub: 'How the system prompt is partitioned for Anthropic prompt caching, and what breaks the cache.'
		},
		{
			id: 'rag',
			label: 'Knowledge & RAG',
			sub: 'ChromaDB collections, per-specialist domain filtering, and where retrieved context is injected.'
		},
		{
			id: 'review',
			label: 'SME Knowledge Review',
			sub: 'The pending-review queue, priority ordering, and how rejected/approved items affect retrieval.'
		},
		{
			id: 'memory',
			label: 'Memory System',
			sub: 'Episodic SQLite memory (decisions, initiatives, advice, scheduled actions) and how it’s surfaced.'
		},
		{
			id: 'peer_memory',
			label: 'Peer Memory (Person + Department)',
			sub: 'External peer-keyed memory. Per-person scope keyed by Person.id for cross-channel continuity, and per-department scope keyed by department_<slug> for institutional voice. Dialectic prefetch, fire-and-forget sync, peer-graph cross-pollination, per-fixture workspace isolation.'
		},
		{
			id: 'org',
			label: 'Org Structure',
			sub: 'Departments, goals, checklists, cadences; people registry; authority gates and channel resolution (Discord/Telegram/email).'
		},
		{
			id: 'audit',
			label: 'Audit Log',
			sub: 'Searchable, append-only record of chat turns, specialist consults, tool calls, scheduled actions, alerts, and inbound integrations.'
		},
		{
			id: 'schemas',
			label: 'Data Schemas',
			sub: 'Key Pydantic models and database tables — the shape of the data flowing through the system.'
		},
		{
			id: 'workflows',
			label: 'Workflows',
			sub: 'Deterministic, multi-step orchestrations that produce structured artifacts, including the wait-for-human pause primitive.'
		},
		{
			id: 'scheduler',
			label: 'Scheduler & Cadences',
			sub: 'The async scheduler runner, cadence DSL, scheduled_actions, and proactive nudges through the user’s last-used channel.'
		},
		{
			id: 'integrations',
			label: 'Integrations',
			sub: 'External channels (Slack, Discord, email, Telegram, Google Chat, MCP gateway), attachments, and how they connect.'
		},
		{
			id: 'external_monitoring',
			label: 'External Monitoring',
			sub: 'Polls the watchlist (vendor status pages, RSS / Atom feeds, stock tickers) and routes qualifying signals through the same alert pipeline as inbound email / Slack. Watchlist editable from chat.'
		},
		{
			id: 'today',
			label: 'Today / Morning Brief',
			sub: 'The /today route — per-department goal health, a roster with awaiting-action counts, and proposals routed to a person.'
		},
		{
			id: 'api',
			label: 'API Reference',
			sub: 'The FastAPI HTTP surface — endpoints grouped by router.'
		},
		{
			id: 'mcp_server',
			label: 'MCP Server',
			sub: 'Open Executive exposed as an MCP server — company context as resources and the specialist council as tools, over Streamable-HTTP at /mcp for external agents.'
		},
		{
			id: 'user_guide',
			label: 'User Guide Surface',
			sub: "The /guide page — plain-language, per-feature overviews served from static prebuilt JSON, sharing this page's loader and renderer but separate from this technical reference."
		},
		{
			id: 'talent',
			label: 'Talent / Executive Search',
			sub: 'The in-house hiring vertical: engagements (searches), candidates, the ChromaDB matching graph, and the draft-and-approve recruiting workflows — surfaced in the /talent UI.'
		},
		{
			id: 'staff_onboarding',
			label: 'Staff Onboarding',
			sub: 'Role-tailored onboarding for new hires: reusable templates, per-hire plans with phased task checklists, the role_onboarding brief workflow, a bounded ramp drip, and chat + /today integration.'
		},
		{
			id: 'clients',
			label: 'Client Companies (Slots)',
			sub: 'Multi-client mode for fractional executives: named save files of the full company context, one active at a time, with save-back switching and per-client MCP tool configs.'
		}
	];

	interface SectionMeta {
		id: string;
		fresh: boolean;
		generated_at: string | null;
	}

	const LEGEND_ITEMS: { label: string; color: string; border: string }[] = [
		{ label: 'Entry / Client', color: '#1e3a8a', border: '#60a5fa' },
		{ label: 'Compute / Agent', color: '#312e81', border: '#a5b4fc' },
		{ label: 'Storage', color: '#365314', border: '#a3e635' },
		{ label: 'Cached', color: '#713f12', border: '#facc15' },
		{ label: 'External', color: '#3f3f46', border: '#a1a1aa' },
		{ label: 'Hot / Not cached', color: '#7f1d1d', border: '#fca5a5' }
	];
</script>

<script lang="ts">
	// Architecture reference route.
	// Ported from `packages/ui/src/app/architecture/page.tsx`.
	import { onMount } from 'svelte';
	import DynamicSection from '$lib/components/architecture/DynamicSection.svelte';

	let activeSection = $state('overview');
	let sectionMeta = $state.raw<Record<string, SectionMeta>>({});
	let observer: IntersectionObserver | null = null;

	onMount(() => {
		// Single cheap listing call — no generation triggered.
		fetch('/api/backend/architecture/sections')
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

{#snippet diagramLegend()}
	<div class="rounded-lg border border-line bg-surface px-4 py-3">
		<p class="mb-2 text-[10px] font-semibold tracking-widest text-fg-subtle uppercase">
			Diagram legend
		</p>
		<div class="flex flex-wrap gap-x-4 gap-y-2">
			{#each LEGEND_ITEMS as it (it.label)}
				<div class="flex items-center gap-1.5 text-xs">
					<span
						class="inline-block h-3 w-3 rounded-sm"
						style={`background: ${it.color}; border: 1.5px solid ${it.border}`}
					></span>
					<span class="text-fg-muted">{it.label}</span>
				</div>
			{/each}
		</div>
	</div>
{/snippet}

<div class="flex min-h-0 flex-1 overflow-hidden bg-surface text-fg">
	<aside class="flex w-52 shrink-0 flex-col border-r border-line bg-surface-elevated">
		<div class="px-3 py-4">
			<p class="mb-2 px-2 text-[10px] font-semibold tracking-widest text-fg-subtle uppercase">
				Architecture
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
						<!-- Content ships with the image, so a section is either
						     present (green) or, if a file is somehow missing, absent (grey). -->
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
				<span class="text-fg-subtle">Sections</span>
				<span class="font-mono text-fg-muted">{freshCount} / {totalCount}</span>
			</div>
			<p class="text-[10px] leading-relaxed text-fg-subtle">
				A map of how the running system is built — components, data flow, and the invariants that
				hold it together.
			</p>
		</div>
	</aside>

	<main class="flex-1 overflow-y-auto">
		<div class="mx-auto max-w-4xl space-y-20 px-8 py-10">
			<div class="space-y-4">
				<div>
					<h1 class="text-2xl font-bold text-fg">Open Executive — Architecture</h1>
					<p class="mt-2 text-sm text-fg-muted">
						A reference map of how Open Executive is built — the components, data flow, and
						invariants of the running system, from the Executive orchestrator and its specialist
						council to the knowledge, memory, scheduling, and integration layers.
					</p>
				</div>
				{@render diagramLegend()}
			</div>

			{#each SECTIONS as { id, label, sub } (id)}
				<DynamicSection {id} title={label} {sub} />
			{/each}
		</div>
	</main>
</div>

<script lang="ts">
	// Mermaid diagram renderer (single diagram).
	// Ported from `packages/ui/src/components/architecture/MermaidDiagram.tsx`.
	//
	// Mermaid parses into real DOM nodes, so rendering only happens in the
	// browser. The library is imported dynamically inside the effect — exactly as
	// upstream does — so mermaid never lands in the initial bundle.
	import { browser } from '$app/environment';

	interface Props {
		definition: string;
		id: string;
	}

	let { definition, id }: Props = $props();

	// Shared classDef rules appended to every diagram so node *roles* are visually
	// distinct across all diagrams. Each role corresponds to a chip in the
	// architecture page's <DiagramLegend />.
	const SHARED_CLASSDEFS = `
classDef entry fill:#1e3a8a,stroke:#60a5fa,stroke-width:1.5px,color:#dbeafe
classDef compute fill:#312e81,stroke:#a5b4fc,stroke-width:1.5px,color:#e0e7ff
classDef storage fill:#365314,stroke:#a3e635,stroke-width:1.5px,color:#ecfccb
classDef cache fill:#713f12,stroke:#facc15,stroke-width:1.5px,color:#fef3c7
classDef external fill:#3f3f46,stroke:#a1a1aa,stroke-width:1.5px,color:#fafafa
classDef hot fill:#7f1d1d,stroke:#fca5a5,stroke-width:1.5px,color:#fecaca
`;

	function withSharedStyles(def: string): string {
		// classDef is flowchart-only — sequence diagrams reject it.
		const trimmed = def.trim();
		if (trimmed.startsWith('sequenceDiagram')) return def;
		return `${def}\n${SHARED_CLASSDEFS}`;
	}

	// Holding the SVG in state (instead of mutating the container's innerHTML
	// directly) is what lets the component safely re-render on regenerate. Prior
	// implementations mutated the DOM outside the framework's knowledge, which
	// caused `NotFoundError: Failed to execute 'removeChild' on 'Node'` when the
	// framework later tried to reconcile a child it hadn't inserted.
	let svg = $state<string | null>(null);
	let error = $state<string | null>(null);

	// External side effect: mermaid is a third-party library that needs a real DOM
	// and is loaded lazily, so this cannot be expressed as `$derived`.
	$effect(() => {
		if (!browser) return;

		const diagramId = id;
		const source = definition;
		let cancelled = false;

		async function render() {
			try {
				const mermaid = (await import('mermaid')).default;
				mermaid.initialize({
					startOnLoad: false,
					theme: 'dark',
					darkMode: true,
					securityLevel: 'loose', // required for <br/> in node labels
					flowchart: {
						padding: 24,
						nodeSpacing: 60,
						rankSpacing: 80,
						curve: 'basis',
						useMaxWidth: true,
						htmlLabels: true
					},
					sequence: {
						actorMargin: 70,
						boxMargin: 14,
						messageMargin: 45,
						mirrorActors: false
					},
					themeVariables: {
						background: 'transparent',
						// Bumped from 14px so labels are readable inside dense flowcharts.
						fontSize: '15px',
						primaryColor: '#1e293b',
						primaryTextColor: '#f4f4f5',
						primaryBorderColor: '#a5b4fc',
						lineColor: '#a1a1aa',
						secondaryColor: '#27272a',
						tertiaryColor: '#3f3f46',
						clusterBkg: '#18181b',
						clusterBorder: '#52525b',
						edgeLabelBackground: '#18181b',
						// Sequence diagram specifics
						actorBkg: '#1e3a8a',
						actorBorder: '#60a5fa',
						actorTextColor: '#dbeafe',
						actorLineColor: '#71717a',
						signalColor: '#d4d4d8',
						signalTextColor: '#f4f4f5',
						labelBoxBkgColor: '#312e81',
						labelBoxBorderColor: '#a5b4fc',
						labelTextColor: '#e0e7ff',
						noteBkgColor: '#365314',
						noteBorderColor: '#a3e635',
						noteTextColor: '#ecfccb'
					}
				});

				// mermaid.render appends a temporary <div id="…"> to <body> while
				// rendering. Use a unique id per call so concurrent renders on a
				// remount don't collide.
				const uniqueId = `mermaid-${diagramId}-${Math.random().toString(36).slice(2, 10)}`;
				const result = await mermaid.render(uniqueId, withSharedStyles(source));
				if (!cancelled) {
					svg = result.svg;
					error = null;
				}
			} catch (e) {
				if (!cancelled) {
					const msg = e instanceof Error ? e.message : 'Diagram render failed';
					// Strip the noisy "Parse error on line N" stack — keep only the
					// first line so the inline message stays compact.
					error = msg.split('\n')[0];
					svg = null;
					// Keep the console error for devs; users see the inline fallback.
					console.error('Mermaid render failed:', e);
				}
			}
		}

		void render();
		return () => {
			cancelled = true;
		};
	});
</script>

{#if error}
	<div class="rounded-lg border border-line bg-surface px-4 py-3 text-xs text-fg-muted">
		<span class="font-medium text-fg-muted">Diagram unavailable.</span>
		<span class="text-fg-muted">This diagram could not be rendered.</span>
	</div>
{:else if svg}
	<!-- The only sanctioned `{@html}` outside Markdown.svelte: the markup comes
	     from mermaid's own renderer, never from user input. -->
	<div
		class="overflow-x-auto rounded-lg border border-line bg-surface-elevated p-6 [&_svg]:h-auto [&_svg]:max-w-full"
	>
		{@html svg}
	</div>
{:else}
	<div
		class="animate-pulse rounded-lg border border-line bg-surface-elevated p-6 text-xs text-fg-subtle"
		style="min-height: 200px"
	>
		Rendering diagram…
	</div>
{/if}

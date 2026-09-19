// Session flow chart — layout + visual tokens.
// Ported from `packages/ui/src/app/audit/session/[id]/page.tsx`. Pure helpers
// only (no framework state), so the route component stays focused on data and
// panes and the custom node component stays presentational.
import Dagre from '@dagrejs/dagre';
import { MarkerType, type Edge, type Node } from '@xyflow/svelte';
import type { AuditGraph, AuditGraphNode } from '$lib/api.js';

// ---------------------------------------------------------------------------
// Visual tokens — color per node kind. Matches and extends the palette
// already used by /audit (TYPE_COLORS). Tailwind needs literal class strings
// so they're enumerated here; the lookup falls back gracefully for unknown
// kinds (future event types still render, just with neutral styling).
// ---------------------------------------------------------------------------

export const KIND_COLORS: Record<
	string,
	{ ring: string; bg: string; text: string; label: string }
> = {
	inbound: {
		ring: 'ring-emerald-500/40',
		bg: 'bg-emerald-500/20',
		text: 'text-emerald-200',
		label: 'Inbound'
	},
	memory: {
		ring: 'ring-rose-500/40',
		bg: 'bg-rose-500/15',
		text: 'text-rose-200',
		label: 'Memory'
	},
	knowledge: {
		ring: 'ring-sky-500/40',
		bg: 'bg-sky-500/15',
		text: 'text-sky-200',
		label: 'Knowledge'
	},
	specialist: {
		ring: 'ring-violet-500/40',
		bg: 'bg-violet-500/20',
		text: 'text-violet-200',
		label: 'Specialist'
	},
	tool: {
		ring: 'ring-amber-500/40',
		bg: 'bg-amber-500/20',
		text: 'text-amber-200',
		label: 'Tool'
	},
	cache: {
		ring: 'ring-slate-500/40',
		bg: 'bg-slate-500/20',
		text: 'text-slate-200',
		label: 'Cache'
	},
	committee: {
		ring: 'ring-fuchsia-500/40',
		bg: 'bg-fuchsia-500/15',
		text: 'text-fuchsia-200',
		label: 'Committee'
	},
	response: {
		ring: 'ring-indigo-500/40',
		bg: 'bg-indigo-500/20',
		text: 'text-indigo-200',
		label: 'Response'
	},
	alert: {
		ring: 'ring-rose-500/40',
		bg: 'bg-rose-500/20',
		text: 'text-rose-300',
		label: 'Alert'
	},
	scheduled: {
		ring: 'ring-sky-500/40',
		bg: 'bg-sky-500/15',
		text: 'text-sky-200',
		label: 'Scheduled'
	}
};

export function kindStyle(kind: string) {
	return (
		KIND_COLORS[kind] ?? {
			ring: 'ring-line-strong/40',
			bg: 'bg-surface-input/40',
			text: 'text-fg',
			label: kind
		}
	);
}

// MiniMap can't read Tailwind classes — needs literal CSS colors per kind.
// Kept in sync with KIND_COLORS so the minimap reads as a faithful zoom-out
// preview of the canvas.
export const MINIMAP_COLORS: Record<string, string> = {
	inbound: 'rgb(52 211 153)', // emerald-400
	memory: 'rgb(251 113 133)', // rose-400
	knowledge: 'rgb(56 189 248)', // sky-400
	specialist: 'rgb(167 139 250)', // violet-400
	tool: 'rgb(251 191 36)', // amber-400
	cache: 'rgb(148 163 184)', // slate-400
	committee: 'rgb(232 121 249)', // fuchsia-400
	response: 'rgb(129 140 248)', // indigo-400
	alert: 'rgb(251 113 133)', // rose-400
	scheduled: 'rgb(56 189 248)' // sky-400
};

export function miniMapNodeColor(node: Node): string {
	const kind = String((node.data as FlowNodeData | undefined)?.kind ?? '');
	return MINIMAP_COLORS[kind] ?? 'rgb(100 116 139)';
}

export function formatTs(ts: string): string {
	try {
		return new Date(ts).toLocaleTimeString();
	} catch {
		return ts;
	}
}

// The node payload as it reaches the canvas. React Flow's `Node<T>` required
// `T extends Record<string, unknown>`, so the index signature was widened
// there; Svelte Flow's node components read the same shape off their props.
export type FlowNodeData = AuditGraphNode & {
	selected?: boolean;
	[key: string]: unknown;
};

// Fixed node footprint — dagre needs deterministic dimensions to compute a
// non-overlapping layout. Picking explicit values (rather than min-/max-)
// means same-depth siblings won't collide because dagre allocates rank
// columns based on the largest node it sees.
export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 92;

// ---------------------------------------------------------------------------
// Auto-layout via @dagrejs/dagre.
//
// The previous hand-rolled longest-path algorithm collided when multiple
// nodes shared a depth — same-depth siblings stacked along a single row
// without accounting for node width. Dagre solves the layered-graph
// coordinate assignment problem properly: it allocates rank columns based
// on node footprint and inserts gaps to avoid overlap.
//
// Direction "TB" (top→bottom) matches how a chat turn reads — inbound at
// top, response at bottom. nodesep is the gap between siblings at the
// same rank; ranksep is the vertical gap between layers.
// ---------------------------------------------------------------------------

export function layoutNodes(graph: AuditGraph): {
	nodes: Node<FlowNodeData>[];
	edges: Edge[];
} {
	const g = new Dagre.graphlib.Graph({ multigraph: false, compound: false });
	g.setDefaultEdgeLabel(() => ({}));
	g.setGraph({
		rankdir: 'TB',
		nodesep: 48, // horizontal gap between sibling nodes
		ranksep: 80, // vertical gap between ranks
		marginx: 24,
		marginy: 24
	});

	for (const n of graph.nodes) {
		g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
	}
	for (const e of graph.edges) {
		// Skip self-loops or edges pointing at unknown nodes (defensive: server
		// shouldn't produce these but it would crash dagre if it ever did).
		if (e.source === e.target) continue;
		if (!g.hasNode(e.source) || !g.hasNode(e.target)) continue;
		g.setEdge(e.source, e.target);
	}

	Dagre.layout(g);

	const flowNodes: Node<FlowNodeData>[] = graph.nodes.map((n) => {
		const pos = g.node(n.id);
		// dagre returns center coordinates; the canvas expects top-left.
		const x = (pos?.x ?? 0) - NODE_WIDTH / 2;
		const y = (pos?.y ?? 0) - NODE_HEIGHT / 2;
		const data: FlowNodeData = { ...n };
		return {
			id: n.id,
			type: 'audit',
			position: { x, y },
			data,
			// Pin width/height so dagre's layout reflects what's painted.
			width: NODE_WIDTH,
			height: NODE_HEIGHT
		};
	});

	// Edge styling: causal edges read as the primary spine of a turn
	// (specialist → tool, inbound → memory). Order edges are secondary —
	// they show "this happened next" but don't carry causal meaning, so
	// they're rendered subtler. Svelte Flow takes edge styles as a CSS string
	// (React Flow took a style object).
	const flowEdges: Edge[] = graph.edges.map((e, i) => {
		const isCause = e.relation === 'cause';
		const stroke = isCause ? 'rgb(165 180 252)' : 'rgb(100 116 139)';
		return {
			id: `e${i}`,
			source: e.source,
			target: e.target,
			type: 'smoothstep',
			animated: isCause,
			style: `stroke: ${stroke}; stroke-width: ${isCause ? 1.75 : 1.25}; opacity: ${
				isCause ? 0.9 : 0.55
			};`,
			markerEnd: {
				type: MarkerType.ArrowClosed,
				width: 14,
				height: 14,
				color: stroke
			}
		};
	});

	return { nodes: flowNodes, edges: flowEdges };
}

export function deriveKind(eventType: string): string {
	const map: Record<string, string> = {
		integration_inbound: 'inbound',
		chat_turn: 'response',
		specialist_consult: 'specialist',
		tool_invocation: 'tool',
		knowledge_retrieval: 'knowledge',
		cache_event: 'cache',
		memory_snapshot: 'memory',
		committee_review: 'committee'
	};
	return map[eventType] ?? eventType;
}

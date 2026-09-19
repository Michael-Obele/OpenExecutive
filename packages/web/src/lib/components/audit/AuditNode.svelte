<script lang="ts">
	// Custom node for the session flow chart — one audit event per card.
	// Ported from the `AuditNode` component in
	// `packages/ui/src/app/audit/session/[id]/page.tsx`.
	//
	// Handles sit on top + bottom only because dagre lays out top-to-bottom by
	// default. Svelte Flow passes the node payload through `data` and the live
	// selection flag through `selected`, exactly like React Flow did.
	import { Handle, Position, type Node, type NodeProps } from '@xyflow/svelte';
	import {
		formatTs,
		kindStyle,
		NODE_HEIGHT,
		NODE_WIDTH,
		type FlowNodeData
	} from './session-graph.js';

	let { data, selected }: NodeProps<Node<FlowNodeData>> = $props();

	let style = $derived(kindStyle(data.kind));
</script>

<div
	class={`group relative cursor-pointer overflow-hidden rounded-xl border border-line text-xs transition-all duration-150 ${style.bg} ${style.text} ${
		selected
			? 'shadow-lg ring-2 shadow-indigo-500/20 ring-indigo-400'
			: 'shadow-md ring-1 ring-line-strong/30 hover:shadow-lg hover:ring-2 hover:ring-fg-muted/40'
	}`}
	style="width: {NODE_WIDTH}px; height: {NODE_HEIGHT}px"
>
	<Handle
		type="target"
		position={Position.Top}
		class="h-2! w-2! border-line-strong! bg-line-strong!"
	/>
	<div class="flex h-full flex-col px-3 py-2">
		<div class="mb-1.5 flex shrink-0 items-center justify-between gap-2">
			<span
				class={`inline-block rounded px-1.5 py-[1px] text-[9px] font-bold tracking-widest uppercase ${style.bg} ${style.text} ring-1 ring-current/20 ring-inset`}
			>
				{style.label}
			</span>
			<span class="font-mono text-[10px] opacity-50">{formatTs(data.ts)}</span>
		</div>
		<div class="line-clamp-2 flex-1 text-[12px] leading-tight font-medium break-words">
			{data.label}
		</div>
		{#if data.actor}
			<div class="mt-1 shrink-0 truncate font-mono text-[10px] opacity-60">@{data.actor}</div>
		{/if}
	</div>
	<Handle
		type="source"
		position={Position.Bottom}
		class="h-2! w-2! border-line-strong! bg-line-strong!"
	/>
</div>

<script lang="ts" module>
	let uidCounter = 0;
</script>

<script lang="ts">
	// Lightweight hover/focus/tap tooltip primitive — used to attach contextual
	// explanations to UI labels (e.g. "what is a Department?"). Hand-rolled
	// because the codebase has no popover library.
	// Ported from `packages/ui/src/components/InfoTip.tsx`.
	//
	// Behaviour:
	//  - Opens on hover, focus, OR tap (touch devices have no hover state, so
	//    we cannot rely on it alone).
	//  - Closes on blur, mouse-leave (with a 200ms grace period so the user
	//    can mouse INTO the tip if it has links / interactive content),
	//    Escape, and outside-click.
	//  - `aria-describedby` links the trigger to the tooltip while open.
	import type { Snippet } from 'svelte';
	import Icon from './Icon.svelte';

	interface Props {
		/** Tip content — text or rich markup. */
		children: Snippet;
		/** Optional aria-label for the trigger. Default: "More info". */
		label?: string;
		/** Horizontal alignment of the popover relative to the trigger. */
		align?: 'left' | 'center' | 'right';
	}

	let { children, label = 'More info', align = 'center' }: Props = $props();

	let open = $state(false);
	let wrapEl = $state<HTMLSpanElement | null>(null);
	let closeTimer: ReturnType<typeof setTimeout> | null = null;
	const tipId = `infotip-${++uidCounter}`;

	function cancelClose() {
		if (closeTimer != null) {
			clearTimeout(closeTimer);
			closeTimer = null;
		}
	}

	// 200ms grace gives the cursor plenty of time to cross the visual gap
	// between trigger and popover before the close fires. Industry standard
	// (Radix, Reach) uses similar deferred-close timing.
	function scheduleClose() {
		cancelClose();
		closeTimer = setTimeout(() => (open = false), 200);
	}

	// Outside click + Escape — only attach listeners while open so we're not
	// firing on every page interaction in the steady state.
	$effect(() => {
		if (!open) return;
		function onDown(e: MouseEvent) {
			if (!wrapEl?.contains(e.target as Node)) open = false;
		}
		function onKey(e: KeyboardEvent) {
			if (e.key === 'Escape') open = false;
		}
		document.addEventListener('mousedown', onDown);
		document.addEventListener('keydown', onKey);
		return () => {
			document.removeEventListener('mousedown', onDown);
			document.removeEventListener('keydown', onKey);
		};
	});

	// Clear any pending close timer on unmount.
	$effect(() => () => cancelClose());

	let alignClass = $derived(
		align === 'left' ? 'left-0' : align === 'right' ? 'right-0' : 'left-1/2 -translate-x-1/2'
	);
</script>

<span bind:this={wrapEl} class="relative inline-flex items-center">
	<button
		type="button"
		aria-label={label}
		aria-describedby={open ? tipId : undefined}
		aria-expanded={open}
		aria-controls={open ? tipId : undefined}
		onmouseenter={() => {
			cancelClose();
			open = true;
		}}
		onmouseleave={scheduleClose}
		onfocus={() => {
			cancelClose();
			open = true;
		}}
		onblur={scheduleClose}
		onclick={(e) => {
			e.preventDefault();
			open = !open;
		}}
		class="inline-flex cursor-help items-center justify-center rounded-full text-fg-subtle hover:text-fg-muted focus:text-fg-muted focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400"
	>
		<Icon name="info" size="w-3.5 h-3.5" />
	</button>
	{#if open}
		<span
			role="tooltip"
			id={tipId}
			onmouseenter={cancelClose}
			onmouseleave={scheduleClose}
			class={`absolute top-full mt-1.5 ${alignClass} z-40 w-72 max-w-[80vw] rounded-md border border-line bg-surface-overlay px-3 py-2 text-xs leading-snug text-fg-muted shadow-lg`}
		>
			{@render children()}
		</span>
	{/if}
</span>

<script lang="ts">
	import type { SVGAttributes } from 'svelte/elements';
	import { ICON_PATHS, type IconName } from '$lib/icons.js';

	interface Props extends SVGAttributes<SVGSVGElement> {
		name: IconName;
		/** Tailwind size class. Default w-4 h-4. */
		size?: string;
	}

	let { name, size = 'w-4 h-4', class: className = '', ...rest }: Props = $props();
	let path = $derived(ICON_PATHS[name]);
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width={1.5}
	stroke-linecap="round"
	stroke-linejoin="round"
	aria-hidden="true"
	focusable="false"
	class={`${size} shrink-0 ${className}`.trim()}
	{...rest}
>
	<path d={path} />
</svg>

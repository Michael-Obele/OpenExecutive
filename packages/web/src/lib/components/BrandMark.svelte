<script lang="ts">
	type Size = 'sm' | 'md' | 'lg';

	const BOX_CLASSES: Record<Size, string> = {
		sm: 'flex h-7 w-7 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/20',
		md: 'flex h-7 w-7 items-center justify-center rounded-full bg-gradient-to-br from-indigo-500 to-violet-600 shadow-lg shadow-indigo-500/20',
		lg: 'flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-600 shadow-xl shadow-indigo-500/25'
	};

	const TEXT_CLASSES: Record<Size, string> = {
		sm: 'text-[10px] font-bold tracking-tight text-white',
		md: 'text-[10px] font-semibold tracking-tight text-white',
		lg: 'text-base font-bold tracking-tight text-white'
	};

	interface Props {
		size?: Size;
	}

	let { size = 'sm' }: Props = $props();
</script>

<div class={BOX_CLASSES[size]} aria-hidden="true">
	<span class={TEXT_CLASSES[size]}>OE</span>
</div>

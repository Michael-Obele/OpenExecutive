<script lang="ts">
	import { signOut, useSession } from '$lib/auth-client.js';
	import { goto } from '$app/navigation';

	interface Props {
		/** "sidebar" (vertical, with sign-out below name) or "compact" (single row, name only). */
		variant?: 'sidebar' | 'compact';
	}

	let { variant = 'compact' }: Props = $props();

	const sessionStore = useSession();
	// nanostores Atom — subscribe via $effect-tracked `.get()`.
	let snap = $state(sessionStore.get());
	$effect(() => {
		const unsub = sessionStore.subscribe((v) => {
			snap = v;
		});
		return unsub;
	});

	let email = $derived(snap?.data?.user?.email ?? null);
	let name = $derived(snap?.data?.user?.name ?? email ?? '');
	let image = $derived(snap?.data?.user?.image ?? null);
	let loading = $derived(snap?.isPending ?? false);

	let initials = $derived(
		(name || email || '?').split(/[\s@]/)[0]?.slice(0, 2).toUpperCase() || '?'
	);

	async function handleSignOut() {
		await signOut();
		await goto('/signin');
	}
</script>

{#if loading}
	<div class="flex items-center gap-2 text-xs text-fg-subtle">
		<div class="h-6 w-6 animate-pulse rounded-full bg-surface-overlay"></div>
		<span class="hidden sm:inline">Loading…</span>
	</div>
{:else if email}
	{#if variant === 'sidebar'}
		<div class="flex shrink-0 items-center gap-2.5 border-t border-line px-3 py-3">
			{#if image}
				<img
					src={image}
					alt=""
					referrerpolicy="no-referrer"
					class="h-7 w-7 shrink-0 rounded-full"
				/>
			{:else}
				<div
					class="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-indigo-500 to-violet-600 text-[10px] font-semibold text-white"
				>
					{initials}
				</div>
			{/if}
			<div class="min-w-0 flex-1">
				<p class="truncate text-xs font-medium text-fg">{name}</p>
				<p class="truncate text-[10px] text-fg-muted">{email}</p>
			</div>
			<button
				type="button"
				onclick={handleSignOut}
				class="shrink-0 cursor-pointer text-[10px] text-fg-muted transition-colors hover:text-fg"
				title="Sign out"
			>
				Sign out
			</button>
		</div>
	{:else}
		<div class="flex items-center gap-2 text-xs text-fg-muted">
			{#if image}
				<img
					src={image}
					alt=""
					referrerpolicy="no-referrer"
					class="h-6 w-6 shrink-0 rounded-full"
				/>
			{:else}
				<div
					class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-linear-to-br from-indigo-500 to-violet-600 text-[10px] font-semibold text-white"
				>
					{initials}
				</div>
			{/if}
			<span class="hidden max-w-40 truncate sm:inline">{name}</span>
			<button
				type="button"
				onclick={handleSignOut}
				class="cursor-pointer text-[10px] whitespace-nowrap text-fg-muted transition-colors hover:text-fg"
				title={`Sign out ${email}`}
			>
				Sign out
			</button>
		</div>
	{/if}
{/if}

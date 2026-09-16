<script lang="ts">
	import { page } from '$app/state';
	import BrandMark from '$lib/components/BrandMark.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import UserBadge from '$lib/components/UserBadge.svelte';
	import {
		ADVANCED_ITEMS,
		BRIEFING_DESCRIPTION,
		GUIDE_NAV_ITEM,
		MOBILE_PRIMARY,
		NEW_CHAT_DESCRIPTION,
		PULSE_NAV_ITEM,
		SETTINGS_NAV_ITEM,
		buildPrimaryNav,
		type NavItem
	} from '$lib/navigation.js';

	interface Props {
		children?: import('svelte').Snippet;
	}

	let { children }: Props = $props();

	let drawerOpen = $state(false);
	let pathname = $derived(page.url.pathname);

	// Routes that own their full layout — sign-in, onboarding wizard,
	// chat home (owns its own sidebar), API routes.
	const EXEMPT_PREFIXES = ['/signin', '/onboard', '/api'];
	const EXEMPT_EXACT = new Set(['/']);

	let isExempt = $derived(
		EXEMPT_EXACT.has(pathname) ||
			EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))
	);

	let navGroups = $derived(buildPrimaryNav());
	let segments = $derived(pathname.split('/').filter(Boolean));

	function isActive(href: string): boolean {
		if (href === '/') return pathname === '/';
		return pathname === href || pathname.startsWith(`${href}/`);
	}

	const SEGMENT_LABELS: Record<string, string> = {
		today: 'Today',
		talent: 'Talent',
		candidates: 'Candidate',
		searches: 'Searches',
		engagements: 'Engagement',
		review: 'Review',
		proposals: 'Proposals',
		people: 'People',
		departments: 'Departments',
		skills: 'Skills',
		memories: 'Pulse',
		knowledge: 'Knowledge base',
		jobs: 'Jobs',
		artifacts: 'Artifacts',
		runs: 'Runs',
		new: 'New',
		audit: 'Audit log',
		usage: 'Token usage',
		session: 'Session',
		council: 'Agent Council',
		architecture: 'Architecture',
		'company-profile': 'Company profile',
		'staff-onboarding': 'Staff onboarding',
		demo: 'Company Simulator',
		onboard: 'Setup',
		watchlist: 'Watch list',
		settings: 'Settings',
		guide: 'User Guide',
		clients: 'Client Companies'
	};

	function labelFor(segment: string): string {
		return SEGMENT_LABELS[segment] ?? segment;
	}
</script>

{#if isExempt}
	{@render children?.()}
{:else}
	<div class="flex h-full bg-surface text-fg">
		{#if drawerOpen}
			<div
				class="fixed top-8 right-0 bottom-0 left-0 z-30 bg-black/50 lg:hidden"
				onclick={() => (drawerOpen = false)}
				aria-hidden="true"
			></div>
		{/if}

		<!-- Left rail -->
		<aside
			class={`
        fixed top-8 bottom-0 left-0 z-40 flex w-64 shrink-0 flex-col border-r border-line bg-surface-elevated
        transition-transform duration-200 lg:relative lg:top-0 lg:w-56 lg:translate-x-0 lg:transition-none
        ${drawerOpen ? 'translate-x-0' : '-translate-x-full'}
      `}
		>
			<div class="flex shrink-0 items-center justify-between border-b border-line px-4 py-4">
				<a
					href="/"
					onclick={() => (drawerOpen = false)}
					class="flex min-w-0 items-center gap-2.5 text-fg transition-opacity hover:opacity-80"
				>
					<BrandMark size="sm" />
					<span class="truncate text-sm font-semibold">Open Executive</span>
				</a>
				<button
					type="button"
					aria-label="Close menu"
					onclick={() => (drawerOpen = false)}
					class="min-h-touch min-w-touch flex cursor-pointer items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-overlay hover:text-fg lg:hidden"
				>
					<Icon name="close" size="w-5 h-5" />
				</button>
			</div>

			<nav class="flex-1 space-y-4 overflow-y-auto px-2 py-3" aria-label="Primary">
				<div class="space-y-0.5">
					<a
						href="/?new=1"
						onclick={() => (drawerOpen = false)}
						title={NEW_CHAT_DESCRIPTION}
						class="min-h-touch flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm text-indigo-300 transition-colors hover:bg-surface-overlay hover:text-indigo-200"
					>
						<Icon name="plus" size="w-4 h-4" />
						<span class="flex-1 truncate">New chat</span>
					</a>
					<a
						href="/"
						onclick={() => (drawerOpen = false)}
						title={BRIEFING_DESCRIPTION}
						class={`min-h-touch flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${pathname === '/' ? 'bg-surface-overlay font-medium text-fg' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'}`}
					>
						<Icon name="clipboard" size="w-4 h-4" />
						<span class="flex-1 truncate">Briefing</span>
					</a>
					<a
						href={PULSE_NAV_ITEM.href}
						onclick={() => (drawerOpen = false)}
						title={PULSE_NAV_ITEM.description}
						class={`min-h-touch flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${isActive(PULSE_NAV_ITEM.href) ? 'bg-surface-overlay font-medium text-fg' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'}`}
					>
						<Icon name={PULSE_NAV_ITEM.icon} size="w-4 h-4" />
						<span class="flex-1 truncate">{PULSE_NAV_ITEM.label}</span>
					</a>
				</div>

				{#each navGroups as group (group.key)}
					<div>
						<p class="mb-1 px-3 text-[10px] font-semibold tracking-widest text-fg-subtle uppercase">
							{group.label}
						</p>
						<div class="space-y-0.5">
							{#each group.items as item (item.href)}
								<a
									href={item.href}
									onclick={() => (drawerOpen = false)}
									title={item.description}
									class={`min-h-touch flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${isActive(item.href) ? 'bg-surface-overlay font-medium text-fg' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'}`}
								>
									<Icon name={item.icon} size="w-4 h-4" />
									<span class="flex-1 truncate">{item.label}</span>
								</a>
							{/each}
						</div>
					</div>
				{/each}
			</nav>

			<div class="space-y-0.5 border-t border-line px-2 pt-2 pb-1">
				<a
					href={GUIDE_NAV_ITEM.href}
					onclick={() => (drawerOpen = false)}
					title={GUIDE_NAV_ITEM.description}
					class={`min-h-touch flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${isActive(GUIDE_NAV_ITEM.href) ? 'bg-surface-overlay font-medium text-fg' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'}`}
				>
					<Icon name={GUIDE_NAV_ITEM.icon} size="w-4 h-4" />
					<span class="flex-1 truncate">{GUIDE_NAV_ITEM.label}</span>
				</a>
				<a
					href={SETTINGS_NAV_ITEM.href}
					onclick={() => (drawerOpen = false)}
					title={SETTINGS_NAV_ITEM.description}
					class={`min-h-touch flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${isActive(SETTINGS_NAV_ITEM.href) ? 'bg-surface-overlay font-medium text-fg' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'}`}
				>
					<Icon name={SETTINGS_NAV_ITEM.icon} size="w-4 h-4" />
					<span class="flex-1 truncate">{SETTINGS_NAV_ITEM.label}</span>
				</a>
			</div>

			<UserBadge variant="sidebar" />
		</aside>

		<!-- Main column -->
		<div class="flex min-w-0 flex-1 flex-col">
			<header
				class="flex h-14 shrink-0 items-center justify-between gap-3 border-b border-line px-4 sm:px-6"
			>
				<div class="flex min-w-0 items-center gap-2">
					<button
						type="button"
						aria-label="Open menu"
						onclick={() => (drawerOpen = true)}
						class="min-h-touch min-w-touch flex cursor-pointer items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-overlay hover:text-fg lg:hidden"
					>
						<Icon name="menu" size="w-5 h-5" />
					</button>
					<nav aria-label="Breadcrumb" class="flex min-w-0 items-center gap-1.5">
						{#if segments.length === 0}
							<span class="text-sm text-fg-muted">Open Executive</span>
						{:else}
							{#each segments as segment, i (i)}
								<span class="flex min-w-0 items-center gap-1.5">
									{#if i > 0}
										<Icon name="chevron-right" size="w-3 h-3" class="shrink-0 text-fg-subtle" />
									{/if}
									{#if i === 0 && i !== segments.length - 1}
										<a
											href={'/' + segment}
											class="truncate text-sm text-fg-muted transition-colors hover:text-fg"
										>
											{labelFor(segment)}
										</a>
									{:else}
										<span
											class={`max-w-50 truncate text-sm sm:max-w-none ${i === segments.length - 1 ? 'font-medium text-fg' : 'text-fg-muted'}`}
										>
											{labelFor(segment)}
										</span>
									{/if}
								</span>
							{/each}
						{/if}
					</nav>
				</div>
				<UserBadge variant="compact" />
			</header>
			<div class="flex min-h-0 flex-1 flex-col overflow-y-auto">
				{@render children?.()}
			</div>
			<!-- Mobile bottom nav -->
			<nav
				aria-label="Mobile"
				class="flex shrink-0 items-center justify-around border-t border-line bg-surface-elevated px-2 py-1 lg:hidden"
			>
				{#each MOBILE_PRIMARY as item (item.href)}
					<a
						href={item.href}
						title={item.description}
						class={`min-h-touch min-w-touch flex flex-col items-center justify-center gap-0.5 rounded-lg px-2 text-[10px] transition-colors ${isActive(item.href) ? 'text-fg' : 'text-fg-muted hover:text-fg'}`}
					>
						<Icon name={item.icon} size="w-5 h-5" />
						<span class="truncate">{item.label}</span>
					</a>
				{/each}
				<button
					type="button"
					aria-label="More"
					onclick={() => (drawerOpen = true)}
					class="min-h-touch min-w-touch flex cursor-pointer flex-col items-center justify-center gap-0.5 rounded-lg px-2 text-[10px] text-fg-muted transition-colors hover:text-fg"
				>
					<Icon name="menu" size="w-5 h-5" />
					<span>More</span>
				</button>
			</nav>
		</div>
	</div>
{/if}

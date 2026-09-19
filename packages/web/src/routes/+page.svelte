<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import Chat from '$lib/components/Chat.svelte';
	import Briefing from '$lib/components/Briefing.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import type { ChatMessage, DebugEvent, ReviewStats, SessionSummary } from '$lib/api.js';
	import {
		deleteSession as apiDeleteSession,
		getReviewStats,
		getSessionMessages,
		listSessions
	} from '$lib/api.js';
	import { formatRelativeTime } from '$lib/helpers.js';

	let health = $state<{
		company_profile_loaded: boolean;
		company_name?: string;
		status: string;
	} | null>(null);
	let debugOpen = $state(false);
	let debugEvents = $state<DebugEvent[]>([]);
	let sessions = $state<SessionSummary[]>([]);
	let activeSessionId = $state<string | undefined>(undefined);
	let activeMessages = $state<ChatMessage[]>([]);
	let reviewStats = $state<ReviewStats | null>(null);
	let mode = $state<'briefing' | 'chat'>('briefing');
	let pendingPrompt = $state<string | undefined>(undefined);

	let firstName = $derived(page.data?.user?.name?.trim().split(/\s+/)[0] ?? '');

	onMount(() => {
		fetch('/api/backend/health')
			.then((r) => r.json())
			.then((v) => (health = v))
			.catch(() => (health = { status: 'error', company_profile_loaded: false }));
		void refreshSessions();
		getReviewStats()
			.then((v) => (reviewStats = v))
			.catch(() => {});
		if (page.url.searchParams.get('new') === '1') {
			handleNewChat();
			goto('/', { replaceState: true });
		}
	});

	async function refreshSessions() {
		try {
			sessions = await listSessions();
		} catch {
			/* ignore */
		}
	}
	async function handleSelectSession(sessionId: string) {
		try {
			const msgs = await getSessionMessages(sessionId);
			activeSessionId = sessionId;
			activeMessages = msgs;
			debugEvents = [];
			mode = 'chat';
			pendingPrompt = undefined;
		} catch {
			/* ignore */
		}
	}
	function handleNewChat() {
		activeSessionId = undefined;
		activeMessages = [];
		debugEvents = [];
		mode = 'chat';
		pendingPrompt = undefined;
	}
	function handleContinueFromBriefing(prompt: string) {
		activeSessionId = undefined;
		activeMessages = [];
		debugEvents = [];
		mode = 'chat';
		pendingPrompt = prompt;
	}
	function handleBackToBriefing() {
		activeSessionId = undefined;
		activeMessages = [];
		debugEvents = [];
		mode = 'briefing';
		pendingPrompt = undefined;
	}
	async function handleDeleteSession(sessionId: string) {
		if (!confirm('Delete this chat? This cannot be undone.')) return;
		try {
			await apiDeleteSession(sessionId);
			if (activeSessionId === sessionId) {
				activeSessionId = undefined;
				activeMessages = [];
				mode = 'briefing';
			}
			await refreshSessions();
		} catch {
			/* ignore */
		}
	}
</script>

<div class="flex h-full">
	<aside class="hidden w-64 shrink-0 flex-col border-r border-line bg-surface-elevated lg:flex">
		<div class="flex items-center gap-2.5 border-b border-line px-4 py-4">
			<button
				type="button"
				onclick={handleBackToBriefing}
				class="flex min-w-0 items-center gap-2.5 text-fg transition-opacity hover:opacity-80"
			>
				<span
					class="flex h-7 w-7 items-center justify-center rounded-lg bg-linear-to-br from-indigo-500 to-violet-600 text-[10px] font-bold text-white shadow-lg shadow-indigo-500/20"
					aria-hidden="true">OE</span
				>
				<span class="truncate text-sm font-semibold">Open Executive</span>
			</button>
		</div>
		<div class="flex flex-1 flex-col overflow-hidden">
			<div class="space-y-0.5 px-2 pt-3">
				<button
					type="button"
					onclick={handleNewChat}
					class={`min-h-touch flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors ${mode === 'chat' && !activeSessionId ? 'bg-surface-overlay text-fg' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'}`}
				>
					<Icon name="plus" size="w-4 h-4" /> New chat
				</button>
				<button
					type="button"
					onclick={handleBackToBriefing}
					class={`min-h-touch flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-left text-sm font-medium transition-colors ${mode === 'briefing' ? 'bg-surface-overlay text-fg' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'}`}
				>
					<Icon name="clipboard" size="w-4 h-4" /> Briefing
				</button>
			</div>
			<div class="mt-4 flex-1 overflow-y-auto px-2">
				<p class="mb-2 px-3 text-[10px] font-semibold tracking-widest text-fg-subtle uppercase">
					Recent chats
				</p>
				{#if sessions.length === 0}
					<p class="px-3 py-2 text-xs text-fg-subtle">No chats yet.</p>
				{:else}
					<div class="space-y-0.5">
						{#each sessions as s (s.session_id)}
							<div class="group flex items-center gap-1">
								<button
									type="button"
									onclick={() => void handleSelectSession(s.session_id)}
									class={`min-h-touch flex flex-1 cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-sm transition-colors ${activeSessionId === s.session_id ? 'bg-surface-overlay text-fg' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'}`}
								>
									<span class="flex-1 truncate">{s.title || 'Untitled chat'}</span>
									<span class="shrink-0 text-[10px] text-fg-subtle"
										>{formatRelativeTime(s.updated_at)}</span
									>
								</button>
								<button
									type="button"
									onclick={() => void handleDeleteSession(s.session_id)}
									class="hidden cursor-pointer rounded p-1 text-fg-subtle group-hover:block hover:bg-surface-overlay hover:text-fg"
									aria-label="Delete chat"
								>
									<Icon name="trash" size="w-3.5 h-3.5" />
								</button>
							</div>
						{/each}
					</div>
				{/if}
			</div>
			{#if reviewStats && reviewStats.pending + reviewStats.needs_revision > 0}
				<div class="border-t border-line px-3 py-3">
					<a
						href="/review"
						class="flex items-center gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-xs text-amber-300 transition-colors hover:bg-amber-500/20"
					>
						<Icon name="flag" size="w-3.5 h-3.5" />
						{reviewStats.pending + reviewStats.needs_revision} items need review
					</a>
				</div>
			{/if}
		</div>
	</aside>
	<div class="flex min-w-0 flex-1 flex-col">
		{#if mode === 'briefing'}
			<!-- Briefing-first landing: the whole home page content for this mode.
			     The company-profile nudge stays a sibling so the briefing keeps the
			     rest of the column's height (same wrapper the chat branch uses). -->
			{#if health && !health.company_profile_loaded}
				<div class="px-4 sm:px-6">
					<div class="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3">
						<p class="text-sm text-amber-200">
							Company profile not set up yet. <a
								href="/onboard"
								class="underline hover:no-underline">Set it up now</a
							>.
						</p>
					</div>
				</div>
			{/if}
			<div class="flex min-h-0 flex-1 flex-col">
				<Briefing onContinue={handleContinueFromBriefing} showHeader {firstName} />
			</div>
		{:else}
			{#key activeSessionId ?? 'new'}
				<div class="flex min-h-0 flex-1 flex-col">
					<Chat
						initialMessages={activeMessages}
						initialSessionId={activeSessionId}
						initialInput={pendingPrompt}
						autoSubmitInitialInput={pendingPrompt !== undefined}
						onTurnComplete={(id) => {
							activeSessionId = id;
							void refreshSessions();
						}}
						onDebugEvent={(ev: DebugEvent) => (debugEvents = [...debugEvents, ev])}
					/>
				</div>
			{/key}
		{/if}
	</div>
	{#if debugOpen}
		<div class="hidden w-80 shrink-0 flex-col border-l border-line bg-surface-elevated lg:flex">
			<div class="flex items-center justify-between border-b border-line px-3 py-2">
				<span class="text-xs font-semibold text-fg">Debug</span>
				<button
					type="button"
					onclick={() => (debugOpen = false)}
					class="cursor-pointer rounded p-1 text-fg-muted hover:bg-surface-overlay hover:text-fg"
					aria-label="Close debug panel"><Icon name="close" size="w-4 h-4" /></button
				>
			</div>
			<div class="flex-1 overflow-y-auto p-3">
				{#if debugEvents.length === 0}<p class="text-xs text-fg-subtle">
						No events yet.
					</p>{:else}<div class="space-y-1">
						{#each debugEvents as ev, i (i)}<pre
								class="rounded bg-surface-overlay px-2 py-1.5 text-[11px] break-words whitespace-pre-wrap text-fg-muted">{JSON.stringify(
									ev,
									null,
									2
								)}</pre>{/each}
					</div>{/if}
			</div>
		</div>
	{/if}
</div>
{#if !debugOpen}
	<button
		type="button"
		onclick={() => (debugOpen = true)}
		class="fixed right-4 bottom-4 z-20 cursor-pointer rounded-full border border-line bg-surface-elevated px-3 py-1.5 text-xs text-fg-muted shadow-lg transition-colors hover:bg-surface-overlay hover:text-fg"
		>Debug</button
	>
{/if}

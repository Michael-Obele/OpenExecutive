<script lang="ts">
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import OnboardWizard from '$lib/components/onboard/OnboardWizard.svelte';
	import OnboardConversation, {
		type Bubble
	} from '$lib/components/onboard/OnboardConversation.svelte';
	import OnboardDraftReview from '$lib/components/onboard/OnboardDraftReview.svelte';
	import type { OnboardTurn } from '$lib/api.js';

	// Onboarding is a focused full-screen flow — exempt from the AppShell chrome
	// (see AppShell.svelte EXEMPT_PREFIXES) so it owns the whole viewport.
	//
	// Default is the conversational flow: describe the business, answer a few
	// clarifying questions, then review and edit a drafted profile. The original
	// step-by-step wizard stays reachable at /onboard?mode=form — it needs no API
	// key beyond the profile save, so it is also the fallback when the
	// conversation cannot run.

	let turn = $state<OnboardTurn | null>(null);
	let resumeTurns = $state<Bubble[]>([]);
	let conversationTurn = $state<OnboardTurn | null>(null);

	const formMode = $derived(page.url.searchParams.get('mode') === 'form');

	function finish() {
		void goto('/');
	}
</script>

<div class="flex h-full flex-col bg-surface">
	<main class="flex-1 overflow-y-auto">
		{#if formMode}
			<div class="mx-auto w-full max-w-3xl">
				<OnboardWizard onComplete={finish} />
				<p class="pb-10 text-center text-xs text-fg-muted">
					<a href="/onboard" class="transition-colors hover:text-fg">
						← Describe your business instead
					</a>
				</p>
			</div>
		{:else if turn?.phase === 'draft'}
			{@const currentTurn = turn}
			<div class="mx-auto w-full max-w-3xl px-6 py-10">
				<OnboardDraftReview
					turn={currentTurn}
					onBackToConversation={() => {
						// Keep the session and its transcript — "ask me more" must not
						// throw away the interview.
						conversationTurn = { ...currentTurn, phase: 'question', question: null };
						turn = null;
					}}
					onSaved={finish}
				/>
			</div>
		{:else}
			<div class="mx-auto w-full max-w-2xl px-6 py-16">
				<div class="mb-8">
					<h1 class="text-xl font-semibold text-fg">Set up your Executive</h1>
					<p class="mt-1 text-sm text-fg-muted">
						A few minutes now, and every answer you get afterwards is grounded in your company
						rather than a generic one.
					</p>
				</div>

				<OnboardConversation
					initialTurn={conversationTurn}
					initialTurns={resumeTurns}
					onDraft={(next, bubbles) => {
						resumeTurns = bubbles;
						turn = next;
					}}
				/>

				<p class="mt-10 text-center text-xs text-fg-subtle">
					<a href="/onboard?mode=form" class="transition-colors hover:text-fg-muted">
						Prefer a form? Use the step-by-step version
					</a>
				</p>
			</div>
		{/if}
	</main>
</div>

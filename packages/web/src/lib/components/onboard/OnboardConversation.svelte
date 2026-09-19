<script module lang="ts">
	export interface Bubble {
		role: 'user' | 'assistant';
		text: string;
	}
</script>

<script lang="ts">
	import {
		forceOnboardDraft,
		sendOnboardMessage,
		startOnboardInterview,
		type OnboardTurn
	} from '$lib/api.js';

	const MAX_FILES = 8;

	const FOLLOWUP_PROMPT = 'Anything else I should know? Tell me what to change, or draft again.';
	const INTRO_PROMPT =
		"Tell me about your company — what you do, who you sell to, roughly how big you are, and what you're focused on this year. Write it however you like; I'll ask about anything I'm missing. You can also attach a deck, a one-pager, or anything else that describes the business.";
	const ANSWER_PLACEHOLDER = 'Your answer… (Enter to send, Shift+Enter for a new line)';
	const DESCRIPTION_PLACEHOLDER =
		"e.g. We're Northwind Tools — we sell industrial supplies to construction crews in the Midwest. About 40 people, bootstrapped, doing roughly $12M a year. This year we're trying to launch same-day delivery without blowing up margins.";

	interface Props {
		/** Prior turns when resuming a session, oldest first. */
		initialTurns?: Bubble[];
		initialTurn: OnboardTurn | null;
		onDraft: (turn: OnboardTurn, turns: Bubble[]) => void;
	}

	let { initialTurns = [], initialTurn, onDraft }: Props = $props();

	// svelte-ignore state_referenced_locally
	let turn = $state<OnboardTurn | null>(initialTurn);
	// svelte-ignore state_referenced_locally
	let bubbles = $state<Bubble[]>(initialTurns);
	let input = $state('');
	let files = $state<File[]>([]);
	let busy = $state(false);
	let error = $state<string | null>(null);
	let bottomRef: HTMLDivElement | undefined = $state(undefined);

	const started = $derived(turn !== null);

	// The header shows the current question. Drop it from the history only when
	// the last bubble IS that question — on resume from a draft the transcript
	// ends on the user's own message, which must stay visible.
	const headline = $derived(turn?.question ?? null);
	const earlier = $derived(
		headline && bubbles.length > 0 && bubbles[bubbles.length - 1].text === headline
			? bubbles.slice(0, -1)
			: bubbles
	);

	$effect(() => {
		void bubbles;
		void busy;
		bottomRef?.scrollIntoView({ behavior: 'smooth' });
	});

	function applyTurn(next: OnboardTurn, sent: Bubble[]) {
		if (next.phase === 'draft') {
			onDraft(next, [...bubbles, ...sent]);
			return;
		}
		turn = next;
		bubbles = [...bubbles, ...sent, { role: 'assistant', text: next.question ?? '' }];
	}

	async function send() {
		const text = input.trim();
		if ((!text && files.length === 0) || busy) return;
		busy = true;
		error = null;
		try {
			const sent: Bubble[] = text ? [{ role: 'user', text }] : [];
			const next = started
				? await sendOnboardMessage(turn!.session_id, text)
				: await startOnboardInterview(text, files);
			input = '';
			files = [];
			applyTurn(next, sent);
		} catch (err) {
			error = (err as Error).message;
		} finally {
			busy = false;
		}
	}

	async function draftNow() {
		if (!turn || busy) return;
		const sessionId = turn.session_id;
		busy = true;
		error = null;
		try {
			onDraft(await forceOnboardDraft(sessionId), bubbles);
		} catch (err) {
			error = (err as Error).message;
			busy = false;
		}
	}
</script>

<div class="flex flex-col gap-5">
	<div class="flex flex-col gap-4">
		<div class="rounded-xl border border-line bg-surface-elevated px-5 py-4">
			<p class="text-sm whitespace-pre-wrap text-fg">
				{headline ?? (started ? FOLLOWUP_PROMPT : INTRO_PROMPT)}
			</p>
			{#if turn?.question_hint}
				<p class="mt-2 text-xs text-fg-muted">{turn.question_hint}</p>
			{/if}
		</div>

		{#if earlier.length > 0}
			<details class="text-xs text-fg-muted">
				<summary class="cursor-pointer transition-colors hover:text-fg">
					{`Earlier in this conversation (${earlier.length} ${earlier.length === 1 ? 'message' : 'messages'})`}
				</summary>
				<div class="mt-3 flex flex-col gap-3">
					{#each earlier as b, i (i)}
						<div class={b.role === 'user' ? 'pl-6' : ''}>
							<p class="mb-0.5 text-[10px] tracking-wide text-fg-subtle uppercase">
								{b.role === 'user' ? 'You' : 'Setup'}
							</p>
							<p class="text-xs whitespace-pre-wrap text-fg">{b.text}</p>
						</div>
					{/each}
				</div>
			</details>
		{/if}
	</div>

	<div class="flex flex-col gap-2">
		<!-- svelte-ignore a11y_autofocus -->
		<textarea
			value={input}
			oninput={(e) => (input = e.currentTarget.value)}
			onkeydown={(e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					void send();
				}
			}}
			rows={started ? 3 : 7}
			disabled={busy}
			autofocus
			aria-label={started ? 'Your answer' : 'Describe your company'}
			placeholder={started ? ANSWER_PLACEHOLDER : DESCRIPTION_PLACEHOLDER}
			class="w-full resize-none rounded-lg border border-line-strong bg-surface-overlay px-3 py-2 text-sm text-fg transition-colors placeholder:text-fg-subtle focus:border-indigo-500/50 focus:ring-2 focus:ring-indigo-500/50 focus:outline-none disabled:opacity-50"
		></textarea>

		{#if !started}
			<div class="flex items-center gap-3">
				<label
					class="cursor-pointer text-xs text-indigo-400 transition-colors hover:text-indigo-300"
				>
					Attach files
					<input
						type="file"
						multiple
						class="hidden"
						accept=".pdf,.docx,.doc,.xlsx,.xlsm,.csv,.md,.txt"
						onchange={(e) => (files = Array.from(e.currentTarget.files ?? []).slice(0, MAX_FILES))}
					/>
				</label>
				{#if files.length > 0}
					<p class="text-xs text-fg-muted">
						{files.map((f) => f.name).join(', ')}
					</p>
				{/if}
			</div>
		{/if}

		{#if error}
			<p class="text-xs text-red-400" role="alert">{error}</p>
		{/if}

		<div class="mt-1 flex items-center gap-3">
			<button
				type="button"
				onclick={() => void send()}
				disabled={busy || (!input.trim() && files.length === 0)}
				class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-600 disabled:opacity-40"
			>
				{busy ? 'Thinking…' : started ? 'Send' : 'Get started'}
			</button>
			{#if started}
				<button
					type="button"
					onclick={() => void draftNow()}
					disabled={busy}
					class="text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
				>
					Skip ahead — draft my profile now
				</button>
			{/if}
			{#if turn}
				<span class="ml-auto text-xs text-fg-subtle">
					{turn.questions_asked} of {turn.max_questions} questions
				</span>
			{/if}
		</div>
	</div>

	<div bind:this={bottomRef}></div>
</div>

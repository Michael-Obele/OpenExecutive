<script lang="ts">
	import { onMount } from 'svelte';
	import Message from '$lib/components/Message.svelte';
	import CommitteePhaseIndicator from '$lib/components/CommitteePhaseIndicator.svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { mergePickedFiles } from '$lib/helpers.js';
	import {
		type ActionTaken,
		type ChatMessage,
		type CommitteePhase,
		type DebugEvent,
		streamChat
	} from '$lib/api.js';

	interface Props {
		onDebugEvent?: (event: DebugEvent) => void;
		initialMessages?: ChatMessage[];
		initialSessionId?: string;
		initialInput?: string;
		autoSubmitInitialInput?: boolean;
		onTurnComplete?: (sessionId: string) => void;
		onTurnStart?: () => void;
	}

	let {
		onDebugEvent,
		initialMessages = [],
		initialSessionId,
		initialInput = '',
		autoSubmitInitialInput = false,
		onTurnComplete,
		onTurnStart
	}: Props = $props();

	const SUGGESTED_PROMPTS = [
		"Where did we land on this quarter's priorities?",
		"Pull the team in on a decision I'm sitting on.",
		"Let's review the board update before it goes out.",
		"What's changed since our last sync?"
	];
	const FALLBACK_SUBTITLE =
		'Pick up where we left off — decisions to revisit, drafts to push forward, people to pull in.';

	let messages = $state<ChatMessage[]>(initialMessages);
	let input = $state(initialInput);
	let isLoading = $state(false);
	let sessionId = $state<string | undefined>(initialSessionId);
	let streamingContent = $state('');
	let streamingActions = $state<ActionTaken[]>([]);
	let isConsulting = $state(false);
	let committeeEnabled = $state(false);
	let committeePhase = $state<CommitteePhase | null>(null);
	let suggested = $state<string[]>([]);
	let subtitle = $state(FALLBACK_SUBTITLE);
	let isLoadingPrompts = $state(true);
	let pendingFiles = $state<File[]>([]);
	let fileError = $state<string | null>(null);

	let bottomRef: HTMLDivElement | undefined = $state(undefined);
	let textareaRef: HTMLTextAreaElement | undefined = $state(undefined);
	let fileInputRef: HTMLInputElement | undefined = $state(undefined);
	let adoptedSessionId: string | undefined = initialSessionId;
	let didAutoSubmit = false;

	onMount(() => {
		const ctrl = new AbortController();
		import('$lib/api.js').then(({ getSuggestedPrompts }) => {
			getSuggestedPrompts(ctrl.signal)
				.then((r) => {
					if (r.prompts.length >= 4) suggested = r.prompts.slice(0, 4);
					else suggested = SUGGESTED_PROMPTS;
					if (r.subtitle) subtitle = r.subtitle;
					isLoadingPrompts = false;
				})
				.catch((err: unknown) => {
					if (err instanceof DOMException && err.name === 'AbortError') return;
					suggested = SUGGESTED_PROMPTS;
					isLoadingPrompts = false;
				});
		});
		return () => ctrl.abort();
	});

	$effect(() => {
		if (initialSessionId === adoptedSessionId) return;
		adoptedSessionId = initialSessionId;
		messages = initialMessages ?? [];
		sessionId = initialSessionId;
		streamingContent = '';
	});

	$effect(() => {
		void messages;
		void streamingContent;
		bottomRef?.scrollIntoView({ behavior: 'smooth' });
	});

	$effect(() => {
		if (didAutoSubmit) return;
		if (!autoSubmitInitialInput) return;
		const seed = (initialInput ?? '').trim();
		if (!seed) return;
		didAutoSubmit = true;
		void handleSend(seed);
	});

	async function handleSend(text?: string) {
		const message = (text ?? input).trim();
		if ((!message && pendingFiles.length === 0) || isLoading) return;

		const filesForTurn = pendingFiles;
		const userBubbleContent = filesForTurn.length
			? `${message}${message ? '\n\n' : ''}📎 ${filesForTurn.length} file${filesForTurn.length === 1 ? '' : 's'} attached`
			: message;

		input = '';
		pendingFiles = [];
		fileError = null;
		messages = [...messages, { role: 'user', content: userBubbleContent }];
		isLoading = true;
		streamingContent = '';
		streamingActions = [];
		isConsulting = false;
		committeePhase = null;
		onTurnStart?.();
		if (textareaRef) textareaRef.style.height = 'auto';

		try {
			let accumulated = '';
			const turnActions: ActionTaken[] = [];

			for await (const item of streamChat(message, sessionId, {
				committeeReview: committeeEnabled,
				files: filesForTurn
			})) {
				if (item.type === 'debug_event') {
					onDebugEvent?.(item as DebugEvent);
					continue;
				}
				if (item.type === 'chunk' && item.content) {
					accumulated += item.content;
					isConsulting = false;
					streamingContent = accumulated;
				} else if (item.type === 'thinking') {
					isConsulting = true;
				} else if (item.type === 'phase' && (item as { phase?: CommitteePhase }).phase) {
					committeePhase = (item as { phase: CommitteePhase }).phase;
					isConsulting = false;
				} else if (item.type === 'action_taken') {
					turnActions.push(item as ActionTaken);
					streamingActions = [...turnActions];
				} else if (item.type === 'done') {
					const done = item as { session_id?: string };
					if (done.session_id) {
						adoptedSessionId = done.session_id;
						sessionId = done.session_id;
						onTurnComplete?.(done.session_id);
					}
				} else if (item.type === 'error') {
					throw new Error((item as { message?: string }).message);
				}
			}

			messages = [
				...messages,
				{
					role: 'assistant',
					content: accumulated,
					actions: turnActions.length > 0 ? turnActions : undefined
				}
			];
			streamingContent = '';
			streamingActions = [];
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err);
			messages = [...messages, { role: 'assistant', content: `Something went wrong: ${detail}` }];
			streamingContent = '';
			streamingActions = [];
		} finally {
			isLoading = false;
			isConsulting = false;
			committeePhase = null;
			textareaRef?.focus();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void handleSend();
		}
	}

	function handleTextareaInput(e: Event) {
		const el = e.target as HTMLTextAreaElement;
		input = el.value;
		el.style.height = 'auto';
		el.style.height = Math.min(el.scrollHeight, 160) + 'px';
	}

	function handleFilesPicked(e: Event) {
		const el = e.target as HTMLInputElement;
		const picked = Array.from(el.files ?? []);
		el.value = '';
		if (picked.length === 0) return;
		const result = mergePickedFiles(pendingFiles, picked);
		pendingFiles = result.files;
		fileError = result.rejected.length > 0 ? result.rejected.join(' ') : null;
	}

	function removePendingFile(index: number) {
		pendingFiles = pendingFiles.filter((_, i) => i !== index);
	}

	function formatFileSize(bytes: number): string {
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}
</script>

<div class="flex h-full flex-col">
	<!-- Messages -->
	<div class="flex-1 overflow-y-auto px-4 py-6 sm:px-6">
		{#if messages.length === 0 && !streamingContent}
			<div class="mx-auto max-w-2xl py-12 text-center">
				<h2 class="text-lg font-semibold text-fg">How can I help?</h2>
				<p class="mt-2 text-sm text-fg-muted">{subtitle}</p>
				{#if isLoadingPrompts}
					<div class="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
						{#each Array(4) as _, i (i)}
							<div
								class="h-12 animate-pulse rounded-xl border border-line bg-surface-overlay"
							></div>
						{/each}
					</div>
				{:else}
					<div class="mt-6 grid grid-cols-1 gap-2 sm:grid-cols-2">
						{#each suggested as prompt (prompt)}
							<button
								type="button"
								onclick={() => {
									input = prompt;
									textareaRef?.focus();
								}}
								class="cursor-pointer rounded-xl border border-line bg-surface-overlay px-4 py-3 text-left text-sm text-fg transition-colors hover:bg-surface-hover"
							>
								{prompt}
							</button>
						{/each}
					</div>
				{/if}
			</div>
		{:else}
			<div class="mx-auto max-w-2xl">
				{#each messages as msg, i (i)}
					<Message role={msg.role} content={msg.content} actions={msg.actions} />
				{/each}
				{#if streamingContent || isConsulting || committeePhase}
					{#if committeePhase}
						<div class="mb-4">
							<CommitteePhaseIndicator phase={committeePhase} />
						</div>
					{/if}
					{#if isConsulting && !streamingContent}
						<div class="mb-4 flex items-center gap-2 text-sm text-fg-muted">
							<span class="h-2 w-2 animate-pulse rounded-full bg-indigo-400"></span>
							Consulting specialists…
						</div>
					{/if}
					{#if streamingContent}
						<Message
							role="assistant"
							content={streamingContent}
							isStreaming={isLoading}
							actions={streamingActions}
						/>
					{/if}
				{/if}
				<div bind:this={bottomRef}></div>
			</div>
		{/if}
	</div>

	<!-- Composer -->
	<div class="shrink-0 border-t border-line bg-surface-elevated px-4 py-3 sm:px-6">
		{#if pendingFiles.length > 0}
			<div class="mx-auto mb-2 flex max-w-2xl flex-wrap gap-1.5">
				{#each pendingFiles as file, idx (file.name + file.size)}
					<span
						class="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface-overlay px-2.5 py-1 text-xs text-fg"
					>
						{file.name} ({formatFileSize(file.size)})
						<button
							type="button"
							onclick={() => removePendingFile(idx)}
							class="cursor-pointer text-fg-muted hover:text-fg"
							aria-label="Remove {file.name}"
						>
							<Icon name="close" size="w-3 h-3" />
						</button>
					</span>
				{/each}
			</div>
		{/if}
		{#if fileError}
			<p class="mx-auto mb-2 max-w-2xl text-xs text-red-400" role="alert">{fileError}</p>
		{/if}
		<div class="mx-auto flex max-w-2xl items-end gap-2">
			<input
				bind:this={fileInputRef}
				type="file"
				multiple
				class="hidden"
				onchange={handleFilesPicked}
			/>
			<button
				type="button"
				onclick={() => fileInputRef?.click()}
				class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl border border-line bg-surface-overlay text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
				aria-label="Attach files"
			>
				<Icon name="paperclip" size="w-4 h-4" />
			</button>
			<textarea
				bind:this={textareaRef}
				value={input}
				oninput={handleTextareaInput}
				onkeydown={handleKeydown}
				placeholder="Ask the Executive…"
				rows={1}
				class="max-h-40 min-h-9 flex-1 resize-none rounded-xl border border-line bg-surface-overlay px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:ring-1 focus:ring-accent focus:outline-none"
			></textarea>
			<button
				type="button"
				onclick={() => void handleSend()}
				disabled={isLoading || (!input.trim() && pendingFiles.length === 0)}
				class="flex h-9 w-9 shrink-0 cursor-pointer items-center justify-center rounded-xl bg-indigo-600 text-white transition-colors hover:bg-indigo-500 disabled:opacity-40"
				aria-label="Send"
			>
				<Icon name="arrow-send" size="w-4 h-4" />
			</button>
		</div>
		<div class="mx-auto mt-2 flex max-w-2xl items-center justify-between">
			<label class="flex cursor-pointer items-center gap-1.5 text-xs text-fg-muted">
				<input type="checkbox" bind:checked={committeeEnabled} class="rounded border-line" />
				Committee review
			</label>
			<span class="text-[10px] text-fg-subtle">Shift+Enter for new line</span>
		</div>
	</div>
</div>

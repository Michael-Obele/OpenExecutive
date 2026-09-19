<script lang="ts">
	// Ask OE slide-over panel — page-aware assistant with form-fill.
	// Ported from `packages/ui/src/components/askoe/AskOEPanel.tsx`.
	import Icon from '$lib/components/Icon.svelte';
	import Message from '$lib/components/Message.svelte';
	import { getAskOE } from './askoe.svelte.js';
	import { streamChat, type ActionTaken, type FormPatch } from '$lib/api.js';

	// One proposal card per form_patch event: what was applied/skipped, the
	// Executive's rationale, and an Undo that restores the pre-patch values.
	interface PatchCardData {
		patch: FormPatch;
		applied: string[];
		skipped: string[];
		/** True when no matching form was on screen at delivery time. */
		stale: boolean;
		undone: boolean;
		undo?: () => void;
	}

	interface PanelMessage {
		role: 'user' | 'assistant';
		content: string;
		actions?: ActionTaken[];
		patches?: PatchCardData[];
	}

	const ctx = getAskOE();

	let messages = $state<PanelMessage[]>([]);
	let input = $state('');
	let streaming = $state(false);
	let streamingContent = $state('');
	let sessionId = $state<string | undefined>(undefined);
	let error = $state<string | null>(null);
	let scrollEl = $state<HTMLDivElement | null>(null);
	let inputEl = $state<HTMLTextAreaElement | null>(null);
	// Synchronous in-flight guard: `streaming` state updates async, so two
	// rapid Enter presses could both pass the state check before re-render.
	let sending = false;

	$effect(() => {
		// Re-run when the transcript or the live stream grows.
		void messages;
		void streamingContent;
		scrollEl?.scrollTo({ top: scrollEl.scrollHeight });
	});

	$effect(() => {
		if (ctx.open) inputEl?.focus();
	});

	function handlePatch(item: FormPatch): PatchCardData {
		const form = ctx.getForm();
		if (form && form.formId === item.form_id) {
			const result = form.applyPatch(item.fields);
			ctx.markSuggested(result.applied);
			return {
				patch: item,
				applied: result.applied,
				skipped: result.skipped,
				stale: false,
				undone: false,
				undo: result.undo
			};
		}
		return {
			patch: item,
			applied: [],
			skipped: Object.keys(item.fields),
			stale: true,
			undone: false
		};
	}

	async function send(text: string) {
		const trimmed = text.trim();
		if (!trimmed || streaming || sending) return;
		sending = true;
		error = null;
		input = '';
		messages = [...messages, { role: 'user', content: trimmed }];
		streaming = true;
		streamingContent = '';

		let content = '';
		const actions: ActionTaken[] = [];
		const patches: PatchCardData[] = [];
		try {
			// Page context is snapshotted per turn — current route, form
			// descriptor, and live field values at the moment of sending.
			const pageContext = ctx.buildPageContext();
			for await (const item of streamChat(trimmed, sessionId, { pageContext })) {
				if (item.type === 'chunk' && item.content) {
					content += item.content;
					streamingContent = content;
				} else if (item.type === 'form_patch') {
					patches.push(handlePatch(item));
				} else if (item.type === 'action_taken') {
					actions.push(item);
				} else if (item.type === 'error') {
					error = item.message ?? 'Something went wrong.';
				} else if (item.type === 'done' && item.session_id) {
					sessionId = item.session_id;
				}
				// thinking / phase / debug_event: no panel surface needed.
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Request failed.';
		} finally {
			// Don't append an empty assistant turn when the request failed
			// before producing anything — the error box is the only signal.
			if (content || actions.length > 0 || patches.length > 0) {
				messages = [
					...messages,
					{
						role: 'assistant',
						content,
						actions: actions.length ? actions : undefined,
						patches: patches.length ? patches : undefined
					}
				];
			}
			streamingContent = '';
			streaming = false;
			sending = false;
		}
	}

	function undoPatch(msgIdx: number, patchIdx: number) {
		const card = messages[msgIdx]?.patches?.[patchIdx];
		if (!card || card.undone) return;
		card.undo?.();
		ctx.clearSuggested();
		messages = messages.map((m, i) =>
			i === msgIdx && m.patches
				? {
						...m,
						patches: m.patches.map((p, j) => (j === patchIdx ? { ...p, undone: true } : p))
					}
				: m
		);
	}

	function newChat() {
		messages = [];
		sessionId = undefined;
		error = null;
		streamingContent = '';
	}

	let emptyPrompts = $derived([
		'What does this page do?',
		...(ctx.formMeta ? ['Fill this form in for me: '] : [])
	]);
</script>

{#snippet patchCard(card: PatchCardData, msgIdx: number, patchIdx: number)}
	{#if card.stale}
		<div
			class="mt-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200"
		>
			<p class="mb-1 font-medium">Suggested values arrived, but the form is no longer on screen.</p>
			<pre class="text-[11px] break-all whitespace-pre-wrap text-amber-200/80">{JSON.stringify(
					card.patch.fields,
					null,
					2
				)}</pre>
		</div>
	{:else}
		<div
			class="mt-2 rounded-lg border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200"
		>
			<div class="flex items-start justify-between gap-2">
				<p class="font-medium">
					{card.undone
						? 'Suggestions undone.'
						: `Filled ${card.applied.length} field${card.applied.length === 1 ? '' : 's'} in the form — review and save.`}
				</p>
				{#if !card.undone && card.applied.length > 0}
					<button
						type="button"
						onclick={() => undoPatch(msgIdx, patchIdx)}
						class="shrink-0 text-[11px] text-indigo-300 underline hover:text-indigo-100"
					>
						Undo
					</button>
				{/if}
			</div>
			{#if card.applied.length > 0 && !card.undone}
				<p class="mt-1 text-indigo-200/80">{card.applied.join(', ')}</p>
			{/if}
			{#if card.skipped.length > 0}
				<p class="mt-1 text-amber-200/80">
					Skipped (not recognized): {card.skipped.join(', ')}
				</p>
			{/if}
			{#if card.patch.rationale}
				<p class="mt-1 text-indigo-200/60 italic">{card.patch.rationale}</p>
			{/if}
		</div>
	{/if}
{/snippet}

{#if ctx.open}
	<!-- Mobile backdrop — the panel is a right sheet below lg. -->
	<div
		class="fixed top-8 right-0 bottom-0 left-0 z-30 bg-black/50 lg:hidden"
		onclick={() => ctx.setOpen(false)}
		aria-hidden="true"
	></div>
	<aside
		aria-label="Ask OE"
		class="fixed top-8 right-0 bottom-0 z-40 flex w-[min(24rem,100vw)] shrink-0 flex-col border-l border-line bg-surface-elevated lg:static lg:z-auto lg:w-95"
	>
		<div class="flex h-14 shrink-0 items-center justify-between border-b border-line px-4">
			<div class="flex min-w-0 items-center gap-2">
				<Icon name="bolt" size="w-4 h-4" class="shrink-0 text-indigo-300" />
				<span class="truncate text-sm font-semibold text-fg">Ask OE</span>
			</div>
			<div class="flex items-center gap-1">
				<button
					type="button"
					onclick={newChat}
					title="New conversation"
					aria-label="New conversation"
					class="min-h-touch min-w-touch flex items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-overlay hover:text-fg"
				>
					<Icon name="plus" size="w-4 h-4" />
				</button>
				<button
					type="button"
					onclick={() => ctx.setOpen(false)}
					title="Close (Ctrl/Cmd + .)"
					aria-label="Close Ask OE"
					class="min-h-touch min-w-touch flex items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-surface-overlay hover:text-fg"
				>
					<Icon name="close" size="w-4 h-4" />
				</button>
			</div>
		</div>

		<div bind:this={scrollEl} class="flex-1 overflow-y-auto px-4 py-4">
			{#if messages.length === 0 && !streaming}
				<div class="space-y-3 text-sm text-fg-muted">
					<p>
						Ask about this page{ctx.formMeta
							? " — or describe what you want and I'll fill the form for you to review"
							: ''}.
					</p>
					<div class="flex flex-col gap-1.5">
						{#each emptyPrompts as p (p)}
							<button
								type="button"
								onclick={() => {
									input = p;
									inputEl?.focus();
								}}
								class="rounded-lg border border-line px-3 py-2 text-left text-xs text-fg-muted transition-colors hover:bg-surface-overlay hover:text-fg"
							>
								{p.trim()}
							</button>
						{/each}
					</div>
				</div>
			{/if}

			{#each messages as m, i (i)}
				<div>
					<Message role={m.role} content={m.content} actions={m.actions} />
					{#each m.patches ?? [] as card, j (j)}
						{@render patchCard(card, i, j)}
					{/each}
				</div>
			{/each}

			{#if streaming}
				<Message role="assistant" content={streamingContent || '…'} isStreaming />
			{/if}

			{#if error}
				<div
					class="mt-2 rounded-lg border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"
				>
					{error}
				</div>
			{/if}
		</div>

		<div class="shrink-0 border-t border-line p-3">
			<div class="flex items-end gap-2">
				<textarea
					bind:this={inputEl}
					rows={2}
					value={input}
					oninput={(e) => (input = e.currentTarget.value)}
					onkeydown={(e) => {
						if (e.key === 'Enter' && !e.shiftKey) {
							e.preventDefault();
							void send(input);
						}
					}}
					placeholder={ctx.formMeta
						? "Describe what you want — I'll fill the form…"
						: 'Ask about this page…'}
					class="flex-1 resize-none rounded-lg border border-line bg-surface-input px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-indigo-500 focus:outline-none"
				></textarea>
				<button
					type="button"
					disabled={streaming || !input.trim()}
					onclick={() => void send(input)}
					aria-label="Send"
					class="min-h-touch min-w-touch flex items-center justify-center rounded-lg bg-indigo-600 text-white transition-colors hover:bg-indigo-500 disabled:opacity-40"
				>
					<Icon name="arrow-send" size="w-4 h-4" />
				</button>
			</div>
		</div>
	</aside>
{/if}

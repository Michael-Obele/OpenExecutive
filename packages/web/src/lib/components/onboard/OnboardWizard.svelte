<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import { startOnboarding, submitOnboardAnswer, type OnboardStatus } from '$lib/api.js';

	interface Props {
		onComplete: () => void;
	}

	let { onComplete }: Props = $props();

	let status = $state<OnboardStatus | null>(null);
	let answer = $state('');
	let isLoading = $state(false);
	let error = $state<string | null>(null);

	onMount(() => {
		void init();
	});

	async function init() {
		isLoading = true;
		error = null;
		try {
			status = await startOnboarding();
		} catch {
			error = 'Failed to start onboarding. Is the API server running?';
		} finally {
			isLoading = false;
		}
	}

	async function handleSubmit(skip = false) {
		if (!status) return;
		const sessionId = status.session_id;
		isLoading = true;
		error = null;

		try {
			const next = await submitOnboardAnswer(sessionId, skip ? 'skip' : answer);
			status = next;
			answer = '';

			if (next.completed) {
				setTimeout(onComplete, 1500);
			}
		} catch {
			error = 'Failed to submit answer. Please try again.';
		} finally {
			isLoading = false;
		}
	}

	function handleKeyDown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			void handleSubmit();
		}
	}

	const isOptionalStep = $derived((status?.current_step ?? 0) >= 6);
</script>

{#if error && !status}
	<div class="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
		<p class="text-sm text-red-400" role="alert">{error}</p>
		<button
			type="button"
			onclick={() => void init()}
			class="rounded-lg bg-indigo-500 px-4 py-2 text-sm text-white transition-colors hover:bg-indigo-600"
		>
			Retry
		</button>
	</div>
{:else if !status}
	<div class="flex h-full items-center justify-center" role="status" aria-label="Loading setup">
		<div
			class="h-6 w-6 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent"
		></div>
	</div>
{:else if status.completed}
	<div class="flex h-full flex-col items-center justify-center gap-4 p-8 text-center">
		<div
			class="flex h-14 w-14 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10"
		>
			<Icon name="check" size="w-7 h-7" class="text-emerald-400" />
		</div>
		<div>
			<h2 class="text-lg font-semibold text-fg">Profile complete</h2>
			<p class="mt-1 text-sm text-fg-muted">Redirecting you to the Executive...</p>
		</div>
	</div>
{:else}
	<div class="mx-auto flex h-full max-w-2xl flex-col px-6 py-10">
		<!-- Progress -->
		<div class="mb-10">
			<div class="mb-2.5 flex justify-between text-xs font-medium text-fg-muted">
				<span>Setting up your company profile</span>
				<span>{status.progress_percent}% complete</span>
			</div>
			<div class="h-1.5 w-full rounded-full bg-surface-overlay">
				<div
					class="h-1.5 rounded-full bg-indigo-500 transition-all duration-500"
					style={`width: ${status.progress_percent}%`}
				></div>
			</div>
		</div>

		<!-- Question -->
		<div class="flex flex-1 flex-col justify-center gap-8">
			<div class="flex flex-col gap-2">
				<p class="text-xs font-semibold tracking-widest text-indigo-400 uppercase">
					Step {status.current_step + 1} of {status.total_steps}
					{#if isOptionalStep}
						<span class="ml-2 font-normal tracking-normal text-fg-subtle normal-case">optional</span
						>
					{/if}
				</p>
				<h2 class="text-xl leading-snug font-semibold text-fg">{status.current_question}</h2>
			</div>

			{#if error}
				<p
					class="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
					role="alert"
				>
					{error}
				</p>
			{/if}

			<div class="flex flex-col gap-3">
				<!-- svelte-ignore a11y_autofocus -->
				<textarea
					value={answer}
					oninput={(e) => (answer = e.currentTarget.value)}
					onkeydown={handleKeyDown}
					placeholder="Type your answer..."
					aria-label="Type your answer"
					rows={4}
					class="w-full resize-none rounded-xl border border-line-strong bg-surface-elevated px-4 py-3 text-sm text-fg transition-colors placeholder:text-fg-subtle focus:border-indigo-500/50 focus:ring-2 focus:ring-indigo-500/50 focus:outline-none disabled:opacity-50"
					disabled={isLoading}
					autofocus></textarea>

				<div class="flex gap-3">
					<button
						type="button"
						onclick={() => void handleSubmit(false)}
						disabled={!answer.trim() || isLoading}
						class="flex-1 rounded-xl bg-indigo-500 py-2.5 text-sm font-medium text-white transition-colors hover:bg-indigo-600 disabled:cursor-not-allowed disabled:opacity-40"
					>
						{isLoading ? 'Saving...' : 'Continue →'}
					</button>
					{#if isOptionalStep}
						<button
							type="button"
							onclick={() => void handleSubmit(true)}
							disabled={isLoading}
							class="rounded-xl border border-line-strong px-5 py-2.5 text-sm text-fg-muted transition-colors hover:border-line-strong hover:text-fg disabled:opacity-40"
						>
							Skip
						</button>
					{/if}
				</div>
				<p class="text-center text-xs text-fg-muted">
					Enter to continue · Shift+Enter for new line
				</p>
			</div>
		</div>
	</div>
{/if}

<script lang="ts" module>
	// tailwind-merge is not applied by Markdown.svelte, so this is passed through
	// verbatim from the upstream `PROSE_CLASS` constant.
	const PROSE_CLASS =
		'prose prose-invert prose-sm max-w-none prose-p:text-fg prose-headings:text-fg prose-strong:text-fg prose-code:text-indigo-300 prose-code:bg-surface-overlay prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none prose-pre:bg-surface-overlay prose-pre:border prose-pre:border-line-strong prose-blockquote:border-line-strong prose-blockquote:text-fg-muted prose-ul:text-fg prose-ol:text-fg prose-li:marker:text-fg-muted prose-hr:border-line-strong prose-a:text-indigo-400 prose-a:no-underline hover:prose-a:underline prose-table:text-fg prose-th:text-fg prose-th:border-line-strong prose-td:border-line-strong';

	const MODES = ['edit', 'preview'] as const;
</script>

<script lang="ts">
	// Markdown editor for a single built-in playbook / failure file.
	// Ported from `packages/ui/src/components/knowledge/FileEditor.tsx`.
	import type { BuiltinFileContent } from '$lib/api.js';
	import Markdown from '$lib/components/Markdown.svelte';

	interface Props {
		file: BuiltinFileContent;
		content: string;
		isDirty: boolean;
		isSaving: boolean;
		variant: 'playbook' | 'failure';
		onChange: (v: string) => void;
		onSave: () => void;
		onDelete: () => void;
	}

	let { file, content, isDirty, isSaving, variant, onChange, onSave, onDelete }: Props = $props();

	let mode = $state<'edit' | 'preview'>('preview');
	let isFailure = $derived(variant === 'failure');
	let accent = $derived(isFailure ? 'text-rose-400' : 'text-indigo-400');
</script>

<div class="flex h-full flex-col gap-3">
	<div class="flex flex-wrap items-center justify-between gap-3">
		<div>
			<span class={`text-xs font-semibold tracking-widest uppercase ${accent}`}>
				{isFailure ? 'Failure · ' : ''}{file.domain}
			</span>
			<h2 class="mt-0.5 text-base font-semibold text-fg">{file.filename}</h2>
		</div>
		<div class="flex items-center gap-2">
			<div
				class="flex gap-0.5 rounded-lg border border-line-strong/50 bg-surface-overlay p-0.5"
				role="group"
				aria-label="Editor mode"
			>
				{#each MODES as m (m)}
					<button
						type="button"
						onclick={() => (mode = m)}
						aria-pressed={mode === m}
						class={`rounded-md px-3 py-1 text-xs font-medium capitalize transition-colors ${mode === m ? 'bg-surface-input text-fg' : 'text-fg-muted hover:text-fg'}`}
					>
						{m}
					</button>
				{/each}
			</div>
			<button
				type="button"
				onclick={onDelete}
				class="rounded-lg border border-red-500/20 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-500/10"
			>
				Delete
			</button>
			<button
				type="button"
				onclick={onSave}
				disabled={!isDirty || isSaving}
				class="rounded-lg bg-indigo-500 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-indigo-400 disabled:opacity-40"
			>
				{isSaving ? 'Saving…' : isDirty ? 'Save' : 'Saved'}
			</button>
		</div>
	</div>

	{#if mode === 'edit'}
		<textarea
			value={content}
			oninput={(e) => onChange(e.currentTarget.value)}
			aria-label={`Edit ${file.filename}`}
			spellcheck="false"
			class="min-h-[520px] w-full flex-1 resize-none rounded-xl border border-line-strong bg-surface-elevated px-4 py-3 font-mono text-sm leading-relaxed text-fg focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
		></textarea>
	{:else}
		<div
			class={`h-[520px] flex-1 overflow-y-auto rounded-xl border bg-surface-elevated px-6 py-5 ${
				isFailure ? 'border-rose-900/40' : 'border-line-strong'
			}`}
		>
			<Markdown source={content} class={PROSE_CLASS} />
		</div>
	{/if}
</div>

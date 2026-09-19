<script lang="ts">
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import type {
		CreateFixtureResult,
		GeneratedFixtureBundle,
		GenerateFixtureResult
	} from '$lib/api.js';
	import { createFixture, generateFixture } from '$lib/api.js';

	interface Props {
		open: boolean;
		/** Upstream the page owned `handleSaveDraft` (toast, refresh the fixture
		 *  list, optionally load the new fixture). The dialog hands it the result. */
		onSaved: (result: CreateFixtureResult, thenLoad: boolean) => void | Promise<void>;
		onFailed: (message: string) => void;
	}

	let { open = $bindable(false), onSaved, onFailed }: Props = $props();

	let description = $state('');
	let generating = $state(false);
	let draft = $state<GenerateFixtureResult | null>(null);
	let draftName = $state('');
	let saving = $state(false);
	let descriptionInput = $state<HTMLTextAreaElement | undefined>(undefined);

	// Upstream unmounted the modal body on close, which discarded the prompt, the
	// generated draft and the busy flags — reset them explicitly instead.
	function closeCreate() {
		open = false;
		description = '';
		draft = null;
		draftName = '';
		generating = false;
		saving = false;
	}

	async function handleGenerate() {
		if (!description.trim()) return;
		generating = true;
		try {
			const result = await generateFixture(description.trim());
			draft = result;
			draftName = result.bundle.profile.name;
		} catch (e: unknown) {
			onFailed(e instanceof Error ? e.message : 'Generation failed');
		} finally {
			generating = false;
		}
	}

	async function handleSaveDraft(thenLoad: boolean) {
		if (!draft) return;
		saving = true;
		try {
			// Upstream let the reviewer rename the company before saving by editing
			// the draft bundle in place; the same bundle (with the new name) is what
			// gets POSTed, and the backend re-validates it.
			const bundle: GeneratedFixtureBundle = {
				...draft.bundle,
				profile: { ...draft.bundle.profile, name: draftName }
			};
			const result = await createFixture(bundle, description.trim());
			closeCreate();
			void onSaved(result, thenLoad);
		} catch (e: unknown) {
			onFailed(e instanceof Error ? e.message : 'Save failed');
		} finally {
			saving = false;
		}
	}
</script>

<Dialog.Root
	{open}
	onOpenChange={(next) => {
		if (next) open = true;
		else closeCreate();
	}}
>
	<Dialog.Content
		showCloseButton={false}
		aria-describedby={undefined}
		class="max-h-[85vh] w-full max-w-lg gap-0 overflow-y-auto rounded-xl border border-line bg-surface-elevated p-5 shadow-xl sm:max-w-lg"
		onInteractOutside={(e: PointerEvent) => {
			// Upstream had no dismiss-on-outside-click; a stray click must not throw
			// away a prompt that is still generating or saving.
			if (generating || saving) e.preventDefault();
		}}
		onEscapeKeydown={(e: KeyboardEvent) => {
			if (generating || saving) e.preventDefault();
		}}
		onOpenAutoFocus={(e: Event) => {
			e.preventDefault();
			if (!draft) descriptionInput?.focus();
		}}
	>
		{#if !draft}
			<Dialog.Title class="text-sm font-semibold text-fg">Create a company with AI</Dialog.Title>
			<p class="mt-1 text-xs leading-relaxed text-fg-muted">
				Describe a company and scenario. The Executive will generate a full fixture — profile, team,
				departments, history, and docs — for you to review before saving.
			</p>
			<textarea
				aria-label="Describe a company and scenario"
				bind:this={descriptionInput}
				rows={6}
				bind:value={description}
				disabled={generating}
				placeholder="e.g. A Series A vertical-SaaS startup selling scheduling software to independent dental practices, 45 people, burning $600K/month, facing a new well-funded competitor…"
				class="mt-3 w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-xs text-fg placeholder:text-fg-subtle focus:border-indigo-500/50 focus:outline-none disabled:opacity-50"
			></textarea>
			<div class="mt-4 flex items-center justify-end gap-2">
				<button
					type="button"
					onclick={closeCreate}
					disabled={generating}
					class="cursor-pointer rounded-lg border border-line bg-surface-overlay px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
				>
					Cancel
				</button>
				<button
					type="button"
					onclick={() => void handleGenerate()}
					disabled={generating || !description.trim()}
					class="cursor-pointer rounded-lg border border-indigo-500/30 bg-indigo-500/15 px-3 py-1.5 text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-40"
				>
					{#if generating}
						<span class="flex items-center gap-1.5">
							<span
								class="inline-block h-3 w-3 animate-spin rounded-full border border-current border-t-transparent"
							></span>
							Generating…
						</span>
					{:else}
						Generate
					{/if}
				</button>
			</div>
		{:else}
			{@const current = draft}
			<Dialog.Title class="text-sm font-semibold text-fg">Review fixture</Dialog.Title>
			<p class="mt-1 text-xs text-fg-muted">Generated from your scenario. Review, then save.</p>
			<label class="mt-3 mb-1 block text-[11px] text-fg-muted" for="fixture-name">
				Company name
			</label>
			<input
				id="fixture-name"
				type="text"
				bind:value={draftName}
				class="w-full rounded-lg border border-line bg-surface-input px-3 py-2 text-xs text-fg focus:border-indigo-500/50 focus:outline-none"
			/>
			<div class="mt-3 grid grid-cols-2 gap-2 text-xs">
				<div class="rounded-lg border border-line bg-surface-overlay px-3 py-2">
					<span class="text-fg-muted">Industry:</span>
					<span class="text-fg">{current.bundle.profile.industry || '—'}</span>
				</div>
				<div class="rounded-lg border border-line bg-surface-overlay px-3 py-2">
					<span class="text-fg-muted">Stage:</span>
					<span class="text-fg">{current.bundle.profile.stage || '—'}</span>
				</div>
			</div>
			<div class="mt-3 text-xs text-fg-muted">
				<span class="font-medium text-fg">{current.bundle.people.length}</span> people ·
				<span class="font-medium text-fg">{current.bundle.departments.length}</span> departments ·
				<span class="font-medium text-fg">{current.bundle.docs.length}</span> docs
			</div>
			<div class="mt-2 text-xs text-fg-muted">
				<span class="font-medium text-fg">{current.bundle.memory.decisions?.length ?? 0}</span>
				decisions ·
				<span class="font-medium text-fg">{current.bundle.memory.initiatives?.length ?? 0}</span>
				initiatives ·
				<span class="font-medium text-fg">{current.bundle.memory.alerts?.length ?? 0}</span>
				alerts
			</div>
			<div class="mt-3 rounded-lg border border-line bg-surface-overlay px-3 py-2 text-xs">
				<p class="mb-1 text-fg-muted">Team</p>
				<ul class="space-y-0.5">
					{#each current.bundle.people as p, i (i)}
						<li class="truncate text-fg">
							{p.full_name}{#if p.role}<span class="text-fg-muted">{` — ${p.role}`}</span>{/if}
							{#if p.is_principal}<span class="text-indigo-300">(principal)</span>{/if}
						</li>
					{/each}
				</ul>
			</div>
			<div class="mt-4 flex flex-wrap items-center justify-between gap-2">
				<button
					type="button"
					onclick={() => (draft = null)}
					disabled={saving}
					class="cursor-pointer rounded-lg border border-line bg-surface-overlay px-3 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg disabled:opacity-50"
				>
					← Edit prompt
				</button>
				<div class="flex items-center gap-2">
					<button
						type="button"
						onclick={() => void handleSaveDraft(false)}
						disabled={saving || !draftName.trim()}
						class="cursor-pointer rounded-lg border border-line bg-surface-overlay px-3 py-1.5 text-xs font-medium text-fg transition-colors hover:bg-surface-input disabled:cursor-not-allowed disabled:opacity-40"
					>
						{saving ? 'Saving…' : 'Save'}
					</button>
					<button
						type="button"
						onclick={() => void handleSaveDraft(true)}
						disabled={saving || !draftName.trim()}
						class="cursor-pointer rounded-lg border border-indigo-500/30 bg-indigo-500/15 px-3 py-1.5 text-xs font-medium text-indigo-200 transition-colors hover:bg-indigo-500/25 disabled:cursor-not-allowed disabled:opacity-40"
					>
						Save & Load
					</button>
				</div>
			</div>
		{/if}
	</Dialog.Content>
</Dialog.Root>

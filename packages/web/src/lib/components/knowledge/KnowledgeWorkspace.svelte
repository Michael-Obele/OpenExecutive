<script lang="ts" module>
	const DOMAINS = [
		'board',
		'finance',
		'hr',
		'legal',
		'marketing',
		'operations',
		'product',
		'strategy'
	];
</script>

<script lang="ts">
	// Knowledge-base workspace: source tree + one of six detail panels.
	// Ported from `packages/ui/src/components/knowledge/KnowledgeWorkspace.tsx`.
	import { onMount } from 'svelte';
	import {
		createBuiltinFile,
		createFailureFile,
		deleteBuiltinFile,
		deleteFailureFile,
		getBuiltinFile,
		getFailureFile,
		listBuiltinFiles,
		listFailureFiles,
		updateBuiltinFile,
		updateFailureFile,
		type BuiltinFileContent,
		type BuiltinFileMeta
	} from '$lib/api.js';
	import CompanyPanel from './CompanyPanel.svelte';
	import FileEditor from './FileEditor.svelte';
	import NewFileForm from './NewFileForm.svelte';
	import QueryPanel from './QueryPanel.svelte';
	import ReferencePanel from './ReferencePanel.svelte';
	import SourceTree, { type FileKind, type Selection } from './SourceTree.svelte';

	let builtinFiles = $state.raw<BuiltinFileMeta[]>([]);
	let failureFiles = $state.raw<BuiltinFileMeta[]>([]);
	let selection = $state<Selection>(null);
	let selectedContent = $state.raw<BuiltinFileContent | null>(null);
	let editContent = $state('');
	let isDirty = $state(false);
	let isSaving = $state(false);
	let error = $state<string | null>(null);
	let filter = $state('');

	onMount(() => {
		void loadIndex();
	});

	async function loadIndex() {
		try {
			const [b, f] = await Promise.all([listBuiltinFiles(), listFailureFiles()]);
			builtinFiles = b;
			failureFiles = f;
		} catch {
			error = 'Failed to load knowledge index';
		}
	}

	// Monotonic token: the newest selection always wins, so a slow response for a
	// previously-selected file can never overwrite the one now on screen.
	// (Upstream got the same guarantee from an effect cleanup function.)
	let loadToken = 0;

	// Single entry point for changing the selection. Upstream loaded file content
	// from a `useEffect` keyed on `selection`; here the fetch is issued by the
	// event that changes the selection instead, so the component needs no effect
	// to synchronise state.
	function select(sel: Selection) {
		selection = sel;
		void loadSelectedFile();
	}

	async function loadSelectedFile() {
		const sel = selection;
		const token = ++loadToken;

		selectedContent = null;
		editContent = '';
		isDirty = false;

		if (sel?.kind !== 'file') return;

		const fetcher = sel.fileKind === 'builtin' ? getBuiltinFile : getFailureFile;
		try {
			const data = await fetcher(sel.domain, sel.filename);
			if (token !== loadToken) return;
			selectedContent = data;
			editContent = data.content;
		} catch {
			if (token === loadToken) error = 'Failed to load file';
		}
	}

	async function handleSave() {
		if (selection?.kind !== 'file' || !selectedContent) return;
		const updater = selection.fileKind === 'builtin' ? updateBuiltinFile : updateFailureFile;
		isSaving = true;
		error = null;
		try {
			await updater(selection.domain, selection.filename, editContent);
			isDirty = false;
		} catch {
			error = 'Failed to save file';
		} finally {
			isSaving = false;
		}
	}

	async function handleDelete() {
		if (selection?.kind !== 'file' || !selectedContent) return;
		if (!confirm(`Delete "${selectedContent.filename}"? This removes it from the knowledge base.`))
			return;
		const deleter = selection.fileKind === 'builtin' ? deleteBuiltinFile : deleteFailureFile;
		try {
			await deleter(selection.domain, selection.filename);
			select(null);
			await loadIndex();
		} catch {
			error = 'Failed to delete file';
		}
	}

	async function handleCreate(
		fileKind: FileKind,
		domain: string,
		filename: string,
		content: string
	) {
		const creator = fileKind === 'builtin' ? createBuiltinFile : createFailureFile;
		await creator(domain, filename, content);
		await loadIndex();
		select({ kind: 'file', fileKind, domain, filename });
	}

	// Wrapper so `NewFileForm`'s `onSave` does not have to re-narrow `selection`
	// (the union is not narrowed inside a callback).
	async function handleCreateFromForm(domain: string, filename: string, content: string) {
		if (selection?.kind !== 'new') return;
		await handleCreate(selection.fileKind, domain, filename, content);
	}

	function openFile(fileKind: FileKind, domain: string, filename: string) {
		select({ kind: 'file', fileKind, domain, filename });
	}
</script>

{#snippet emptyState()}
	<div class="max-w-xl">
		<h2 class="mb-2 text-lg font-semibold text-fg">Knowledge base</h2>
		<p class="text-sm text-fg-muted">
			Select a file in the tree to view or edit it. The Built-in tree holds the Executive's default
			playbooks (positive guidance) and failure case studies (negative learnings) — both are
			retrieved at chat time.
		</p>
		<ul class="mt-4 list-inside list-disc space-y-1.5 text-sm text-fg-muted">
			<li>
				<span class="text-fg">Playbooks</span> — domain frameworks and how-tos used as positive examples.
			</li>
			<li>
				<span class="text-rose-300">Failures</span> — case studies of what went wrong, surfaced when the
				question matches one strongly.
			</li>
			<li>
				<span class="text-fg">Company</span> — your uploaded documents.
			</li>
			<li>
				<span class="text-fg">Reference Library</span> — open-licensed textbooks and handbooks.
			</li>
			<li>
				<span class="text-indigo-300">Query mode</span> — see exactly what the Executive would retrieve
				for a question.
			</li>
		</ul>
	</div>
{/snippet}

<div class="flex h-full">
	<aside class="w-64 shrink-0 overflow-y-auto border-r border-line bg-surface/40 px-4 py-5">
		<input
			value={filter}
			oninput={(e) => (filter = e.currentTarget.value)}
			placeholder="Filter files…"
			aria-label="Filter files"
			class="mb-4 w-full rounded-lg border border-line bg-surface-elevated px-2.5 py-1.5 text-xs text-fg placeholder:text-fg-subtle focus:ring-2 focus:ring-indigo-500/40 focus:outline-none"
		/>
		<SourceTree
			domains={DOMAINS}
			{builtinFiles}
			{failureFiles}
			{selection}
			{filter}
			onSelect={select}
		/>
	</aside>

	<main class="min-w-0 flex-1 overflow-y-auto px-8 py-6">
		<!-- The visible heading lives in the empty state; this keeps exactly one
		     h1 on the page while a panel is open. -->
		<h1 class="sr-only">Knowledge base</h1>

		{#if error}
			<div
				class="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400"
				role="alert"
			>
				{error}
			</div>
		{/if}

		{#if selection === null}
			{@render emptyState()}
		{/if}

		{#if selection?.kind === 'file' && selectedContent}
			<FileEditor
				file={selectedContent}
				content={editContent}
				{isDirty}
				{isSaving}
				variant={selection.fileKind === 'failures' ? 'failure' : 'playbook'}
				onChange={(v) => {
					editContent = v;
					isDirty = true;
				}}
				onSave={() => void handleSave()}
				onDelete={() => void handleDelete()}
			/>
		{/if}

		{#if selection?.kind === 'file' && !selectedContent && !error}
			<p class="text-sm text-fg-muted" role="status">Loading…</p>
		{/if}

		{#if selection?.kind === 'new'}
			<NewFileForm
				domains={DOMAINS}
				initialDomain={DOMAINS[0]}
				variant={selection.fileKind === 'failures' ? 'failure' : 'playbook'}
				onSave={handleCreateFromForm}
				onCancel={() => select(null)}
			/>
		{/if}

		{#if selection?.kind === 'company'}
			<CompanyPanel domains={DOMAINS} />
		{/if}

		{#if selection?.kind === 'reference'}
			<ReferencePanel />
		{/if}

		{#if selection?.kind === 'query'}
			<QueryPanel domains={DOMAINS} onOpenFile={openFile} />
		{/if}
	</main>
</div>

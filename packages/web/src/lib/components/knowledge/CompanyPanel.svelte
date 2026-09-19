<script lang="ts" module>
	// Passed straight through to Markdown.svelte — upstream `PROSE_CLASS`, verbatim.
	const PROSE_CLASS =
		'prose prose-invert prose-sm max-w-none prose-p:text-fg prose-headings:text-fg prose-strong:text-fg prose-code:text-indigo-300 prose-code:bg-surface-overlay prose-code:px-1.5 prose-code:py-0.5 prose-code:rounded prose-code:text-xs prose-code:before:content-none prose-code:after:content-none prose-pre:bg-surface-overlay prose-pre:border prose-pre:border-line-strong prose-blockquote:border-line-strong prose-blockquote:text-fg-muted prose-ul:text-fg prose-ol:text-fg prose-li:marker:text-fg-muted prose-hr:border-line-strong prose-a:text-indigo-400 prose-a:no-underline hover:prose-a:underline prose-table:text-fg prose-th:text-fg prose-th:border-line-strong prose-td:border-line-strong';
</script>

<script lang="ts">
	// Company-document manager: upload, list, view (modal), delete.
	// Ported from `packages/ui/src/components/knowledge/CompanyPanel.tsx`,
	// except the hand-rolled viewer modal, which now uses the shadcn Dialog
	// primitive so focus trapping / Escape / ARIA come from the library.
	import { onMount } from 'svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import * as Dialog from '$lib/components/ui/dialog/index.js';
	import {
		deleteDocument,
		getDocument,
		listDocuments,
		uploadDocument,
		type CompanyDoc,
		type CompanyDocContent
	} from '$lib/api.js';

	interface Props {
		domains: string[];
	}

	let { domains }: Props = $props();

	let docs = $state.raw<CompanyDoc[]>([]);
	let isUploading = $state(false);
	let dragOver = $state(false);
	let domain = $state('general');
	let error = $state<string | null>(null);
	let viewing = $state.raw<CompanyDocContent | null>(null);
	let viewLoading = $state<string | null>(null);
	let fileInputEl = $state<HTMLInputElement | null>(null);

	onMount(() => {
		listDocuments()
			.then((v) => (docs = v))
			.catch(() => (error = 'Failed to load documents'));
	});

	async function handleFile(file: File) {
		isUploading = true;
		error = null;
		try {
			await uploadDocument(file, domain);
			docs = await listDocuments();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Upload failed';
		} finally {
			isUploading = false;
			if (fileInputEl) fileInputEl.value = '';
		}
	}

	async function handleDelete(filename: string) {
		if (!confirm(`Delete "${filename}"? This removes it from the knowledge base.`)) return;
		error = null;
		try {
			await deleteDocument(filename);
			docs = docs.filter((d) => d.filename !== filename);
		} catch {
			error = 'Failed to delete document';
		}
	}

	async function handleView(filename: string) {
		error = null;
		viewLoading = filename;
		try {
			viewing = await getDocument(filename);
		} catch {
			error = 'Failed to load document';
		} finally {
			viewLoading = null;
		}
	}
</script>

<div class="max-w-2xl space-y-6">
	<div>
		<h2 class="text-base font-semibold text-fg">Company documents</h2>
		<p class="mt-1 text-xs text-fg-muted">
			Uploaded files indexed into the company knowledge collection. The Executive retrieves from
			these alongside the built-in playbooks.
		</p>
	</div>

	{#if error}
		<p
			class="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400"
			role="alert"
		>
			{error}
		</p>
	{/if}

	<div
		role="group"
		aria-label="Upload a document"
		ondragover={(e) => {
			e.preventDefault();
			dragOver = true;
		}}
		ondragleave={() => (dragOver = false)}
		ondrop={(e) => {
			e.preventDefault();
			dragOver = false;
			const f = e.dataTransfer?.files[0];
			if (f) void handleFile(f);
		}}
		class={`rounded-xl border-2 border-dashed p-8 text-center transition-colors ${
			dragOver ? 'border-indigo-500 bg-indigo-500/5' : 'border-line-strong hover:border-line-strong'
		}`}
	>
		<p class="mb-4 text-sm text-fg-muted">Drop a file here, or choose a domain and browse</p>
		<div class="flex flex-wrap items-center justify-center gap-3">
			<select
				bind:value={domain}
				aria-label="Domain"
				class="rounded-lg border border-line-strong bg-surface-elevated px-3 py-1.5 text-sm text-fg focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
			>
				<option value="general">general</option>
				{#each domains as d (d)}
					<option value={d}>{d}</option>
				{/each}
			</select>
			<label
				class="min-h-touch cursor-pointer rounded-lg bg-surface-input px-4 py-1.5 text-sm font-medium text-fg transition-colors hover:bg-surface-input"
			>
				Browse file
				<input
					bind:this={fileInputEl}
					type="file"
					class="hidden"
					accept=".pdf,.docx,.doc,.md,.txt"
					onchange={(e) => {
						const f = e.currentTarget.files?.[0];
						if (f) void handleFile(f);
					}}
				/>
			</label>
		</div>
		<p class="mt-3 text-xs text-fg-subtle">PDF, DOCX, MD, TXT — up to 50 MB</p>
		{#if isUploading}
			<p class="mt-3 animate-pulse text-xs text-indigo-400" role="status">Indexing…</p>
		{/if}
	</div>

	{#if docs.length === 0}
		<p class="py-8 text-center text-sm text-fg-subtle">No documents uploaded yet.</p>
	{:else}
		<div class="space-y-2">
			<p class="mb-3 text-xs font-semibold tracking-widest text-fg-muted uppercase">
				Uploaded documents
			</p>
			{#each docs as doc (doc.filename)}
				<div
					class="flex items-center justify-between rounded-xl border border-line-strong/50 bg-surface-overlay/60 px-4 py-3"
				>
					<div>
						<p class="text-sm font-medium text-fg">{doc.filename}</p>
						<p class="mt-0.5 text-xs text-fg-muted">
							{`${(doc.size_bytes / 1024).toFixed(1)} KB · ${new Date(doc.modified_at * 1000).toLocaleDateString()}`}
						</p>
					</div>
					<div class="flex items-center gap-1">
						<button
							type="button"
							onclick={() => void handleView(doc.filename)}
							disabled={viewLoading === doc.filename}
							class="rounded px-2 py-1 text-xs text-indigo-400 transition-colors hover:text-indigo-300 disabled:opacity-50"
						>
							{viewLoading === doc.filename ? 'Loading…' : 'View'}
						</button>
						<button
							type="button"
							onclick={() => void handleDelete(doc.filename)}
							class="rounded px-2 py-1 text-xs text-red-400 transition-colors hover:text-red-300"
						>
							Delete
						</button>
					</div>
				</div>
			{/each}
		</div>
	{/if}
</div>

<Dialog.Root open={viewing !== null} onOpenChange={(open) => !open && (viewing = null)}>
	<Dialog.Content
		showCloseButton={false}
		aria-describedby={undefined}
		class="flex max-h-[85vh] w-full flex-col gap-0 overflow-hidden rounded-2xl border border-line-strong bg-surface-elevated p-0 shadow-2xl ring-0 sm:max-w-3xl"
	>
		<Dialog.Header
			class="flex flex-row items-center justify-between gap-3 border-b border-line-strong/60 px-6 py-4"
		>
			<div class="min-w-0">
				<p class="text-xs font-semibold tracking-widest text-indigo-400 uppercase">
					Company document
				</p>
				<Dialog.Title class="truncate text-base font-semibold text-fg">
					{viewing?.filename}
				</Dialog.Title>
			</div>
			<Dialog.Close
				class="shrink-0 rounded-lg px-3 py-1.5 text-xs text-fg-muted transition-colors hover:bg-surface-overlay hover:text-fg"
			>
				Close
			</Dialog.Close>
		</Dialog.Header>
		<div class="flex-1 overflow-y-auto px-6 py-5">
			{#if viewing}
				<Markdown source={viewing.content} class={PROSE_CLASS} />
			{/if}
		</div>
	</Dialog.Content>
</Dialog.Root>

<script lang="ts" module>
	// Types are module-scoped so `KnowledgeWorkspace.svelte` can import them,
	// mirroring the `export type` block in the upstream file.
	export type FileKind = 'builtin' | 'failures';

	export type Selection =
		| { kind: 'file'; fileKind: FileKind; domain: string; filename: string }
		| { kind: 'new'; fileKind: FileKind }
		| { kind: 'company' }
		| { kind: 'reference' }
		| { kind: 'query' }
		| null;
</script>

<script lang="ts">
	// Left-hand source tree for the knowledge workspace.
	// Ported from `packages/ui/src/components/knowledge/SourceTree.tsx`.
	//
	// The inline React sub-components (Section / FileGroup / RootButton) become
	// parameterised snippets below — same markup, same props.
	import type { Snippet } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import type { BuiltinFileMeta } from '$lib/api.js';
	import Icon from '$lib/components/Icon.svelte';
	import type { IconName } from '$lib/icons.js';

	interface Props {
		domains: string[];
		builtinFiles: BuiltinFileMeta[];
		failureFiles: BuiltinFileMeta[];
		selection: Selection;
		filter: string;
		onSelect: (sel: Selection) => void;
	}

	let { domains, builtinFiles, failureFiles, selection, filter, onSelect }: Props = $props();

	let collapsedBuiltin = $state(true);
	// SvelteSet rather than `$state(new Set())` — Svelte's reactive Set primitive.
	const collapsedDomains = new SvelteSet<string>();

	let builtinByDomain = $derived(groupByDomain(builtinFiles));
	let failuresByDomain = $derived(groupByDomain(failureFiles));

	let normalizedFilter = $derived(filter.trim().toLowerCase());

	function matches(s: string) {
		return !normalizedFilter || s.toLowerCase().includes(normalizedFilter);
	}

	// Domains with their playbook/failure files pre-filtered, and dropped
	// entirely while a filter is active if neither group has a match (upstream
	// returned null from the map callback for the same effect).
	let visibleDomains = $derived(
		domains
			.map((domain) => ({
				domain,
				playbooks: (builtinByDomain[domain] ?? []).filter((f) => matches(f.filename)),
				failures: (failuresByDomain[domain] ?? []).filter((f) => matches(f.filename))
			}))
			.filter(
				({ playbooks, failures }) =>
					!normalizedFilter || playbooks.length > 0 || failures.length > 0
			)
	);

	function toggleDomain(d: string) {
		if (collapsedDomains.has(d)) collapsedDomains.delete(d);
		else collapsedDomains.add(d);
	}

	// A filter forces every domain open so matches are visible.
	function isDomainCollapsed(domain: string) {
		return collapsedDomains.has(domain) && !normalizedFilter;
	}

	function isActiveFile(fileKind: FileKind, domain: string, filename: string) {
		return (
			selection?.kind === 'file' &&
			selection.fileKind === fileKind &&
			selection.domain === domain &&
			selection.filename === filename
		);
	}

	function groupByDomain(files: BuiltinFileMeta[]): Record<string, BuiltinFileMeta[]> {
		return files.reduce<Record<string, BuiltinFileMeta[]>>((acc, f) => {
			(acc[f.domain] ??= []).push(f);
			return acc;
		}, {});
	}
</script>

{#snippet fileGroup({
	label,
	files,
	accent,
	onClickFile,
	onAdd,
	isActive
}: {
	label: string;
	files: BuiltinFileMeta[];
	accent: 'indigo' | 'rose';
	onClickFile: (f: BuiltinFileMeta) => void;
	onAdd: () => void;
	isActive: (f: BuiltinFileMeta) => boolean;
})}
	<div>
		<div class="flex items-center justify-between px-1">
			<span
				class={`text-[10px] font-semibold tracking-widest uppercase ${accent === 'rose' ? 'text-rose-400/80' : 'text-fg-muted'}`}
			>
				{label}
			</span>
			<button
				type="button"
				onclick={onAdd}
				class="px-1 text-[10px] text-fg-subtle transition-colors hover:text-fg"
				title={`Add ${label.toLowerCase()} file`}
			>
				+
			</button>
		</div>
		{#if files.length === 0}
			<p class="mt-0.5 px-1 text-[11px] text-fg-subtle">none</p>
		{:else}
			<div class="mt-0.5">
				{#each files as f (f.filename)}
					<button
						type="button"
						onclick={() => onClickFile(f)}
						class={`w-full truncate rounded px-2 py-0.5 text-left text-xs transition-colors ${
							isActive(f)
								? accent === 'rose'
									? 'bg-rose-500/15 text-rose-200'
									: 'bg-surface-input text-fg'
								: 'text-fg-muted hover:bg-surface-overlay hover:text-fg'
						}`}
					>
						{f.filename.replace(/\.md$/, '')}
					</button>
				{/each}
			</div>
		{/if}
	</div>
{/snippet}

{#snippet section({
	label,
	icon,
	collapsed,
	onToggle,
	content
}: {
	label: string;
	icon?: IconName;
	collapsed: boolean;
	onToggle: () => void;
	content: Snippet;
})}
	<div>
		<button
			type="button"
			onclick={onToggle}
			class="mb-2 flex items-center gap-1.5 text-xs font-bold tracking-widest text-fg uppercase transition-colors hover:text-white"
		>
			<span class="inline-block w-3 text-fg-muted">{collapsed ? '▸' : '▾'}</span>
			{#if icon}
				<Icon name={icon} size="w-3.5 h-3.5" class="text-fg-muted" />
			{/if}
			{label}
		</button>
		{#if !collapsed}
			<div class="space-y-3">{@render content()}</div>
		{/if}
	</div>
{/snippet}

{#snippet builtinTree()}
	{#each visibleDomains as { domain, playbooks, failures } (domain)}
		<div>
			<button
				type="button"
				onclick={() => toggleDomain(domain)}
				class="flex w-full items-center gap-1.5 px-1 text-[11px] font-semibold tracking-widest text-fg-muted uppercase transition-colors hover:text-fg"
			>
				<span class="inline-block w-3 text-fg-subtle">{isDomainCollapsed(domain) ? '▸' : '▾'}</span>
				{domain}
			</button>
			{#if !isDomainCollapsed(domain)}
				<div class="mt-1 ml-3 space-y-2">
					{@render fileGroup({
						label: 'Playbooks',
						files: playbooks,
						accent: 'indigo',
						onClickFile: (f) =>
							onSelect({
								kind: 'file',
								fileKind: 'builtin',
								domain,
								filename: f.filename
							}),
						onAdd: () => onSelect({ kind: 'new', fileKind: 'builtin' }),
						isActive: (f) => isActiveFile('builtin', domain, f.filename)
					})}
					{@render fileGroup({
						label: 'Failures',
						files: failures,
						accent: 'rose',
						onClickFile: (f) =>
							onSelect({
								kind: 'file',
								fileKind: 'failures',
								domain,
								filename: f.filename
							}),
						onAdd: () => onSelect({ kind: 'new', fileKind: 'failures' }),
						isActive: (f) => isActiveFile('failures', domain, f.filename)
					})}
				</div>
			{/if}
		</div>
	{/each}
{/snippet}

{#snippet rootButton({
	active,
	onClick,
	accent,
	icon,
	label
}: {
	active: boolean;
	onClick: () => void;
	accent?: 'indigo';
	icon?: IconName;
	label: string;
})}
	<button
		type="button"
		onclick={onClick}
		class={`flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs font-bold tracking-widest uppercase transition-colors ${
			active
				? accent === 'indigo'
					? 'bg-indigo-500/15 text-indigo-200'
					: 'bg-surface-input text-fg'
				: 'text-fg hover:bg-surface-overlay hover:text-white'
		}`}
	>
		{#if icon}
			<Icon name={icon} size="w-3.5 h-3.5" />
		{/if}
		{label}
	</button>
{/snippet}

<nav class="space-y-3 text-sm">
	{@render section({
		label: 'Built-in',
		icon: 'grid',
		collapsed: collapsedBuiltin,
		onToggle: () => (collapsedBuiltin = !collapsedBuiltin),
		content: builtinTree
	})}

	{@render rootButton({
		active: selection?.kind === 'company',
		onClick: () => onSelect({ kind: 'company' }),
		icon: 'building',
		label: 'Company'
	})}
	{@render rootButton({
		active: selection?.kind === 'reference',
		onClick: () => onSelect({ kind: 'reference' }),
		icon: 'book',
		label: 'Reference Library'
	})}
	{@render rootButton({
		active: selection?.kind === 'query',
		onClick: () => onSelect({ kind: 'query' }),
		accent: 'indigo',
		icon: 'doc-search',
		label: 'Query mode'
	})}
</nav>

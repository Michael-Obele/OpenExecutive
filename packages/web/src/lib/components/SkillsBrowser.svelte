<script lang="ts">
	import { onMount } from 'svelte';
	import Markdown from '$lib/components/Markdown.svelte';
	import type { SkillDetail, SkillMeta, SkillSearchHit } from '$lib/api.js';
	import { deleteSkill, getSkill, listSkills, searchSkills } from '$lib/api.js';

	let skills = $state.raw<SkillMeta[]>([]);
	let selected = $state<SkillDetail | null>(null);
	let error = $state<string | null>(null);
	let searchQuery = $state('');
	let searchHits = $state.raw<SkillSearchHit[] | null>(null);
	let isSearching = $state(false);

	async function load() {
		try {
			skills = await listSkills();
		} catch {
			error = 'Failed to load skills';
		}
	}

	onMount(() => {
		void load();
	});

	async function handleSelect(name: string) {
		error = null;
		try {
			selected = await getSkill(name);
		} catch {
			error = 'Failed to load skill';
		}
	}

	async function handleDelete() {
		if (!selected) return;
		if (selected.source === 'builtin') return;
		if (!confirm(`Delete skill "${selected.name}"? This cannot be undone.`)) return;
		try {
			await deleteSkill(selected.name);
			selected = null;
			await load();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to delete skill';
		}
	}

	async function handleSearch() {
		if (!searchQuery.trim()) {
			searchHits = null;
			return;
		}
		isSearching = true;
		error = null;
		try {
			searchHits = await searchSkills(searchQuery.trim(), 10);
		} catch {
			error = 'Search failed';
		} finally {
			isSearching = false;
		}
	}

	function clearSearch() {
		searchQuery = '';
		searchHits = null;
	}

	const builtin = $derived(skills.filter((s) => s.source === 'builtin'));
	const userSkills = $derived(skills.filter((s) => s.source === 'company'));

	function groupByCategory(items: SkillMeta[]): Record<string, SkillMeta[]> {
		return items.reduce<Record<string, SkillMeta[]>>((acc, s) => {
			(acc[s.category] ??= []).push(s);
			return acc;
		}, {});
	}

	const builtinGrouped = $derived(groupByCategory(builtin));
	const userGrouped = $derived(groupByCategory(userSkills));
</script>

{#snippet skillSection(
	title: string,
	grouped: Record<string, SkillMeta[]>,
	expectedSource: 'builtin' | 'company',
	selectedName: string | undefined,
	selectedSource: string | undefined,
	emptyMessage: string
)}
	{@const categories = Object.keys(grouped).sort()}
	<div>
		<p class="mb-1.5 px-1 text-xs font-semibold tracking-widest text-fg-muted uppercase">{title}</p>
		{#if categories.length === 0}
			<p class="px-1 text-xs text-fg-subtle">{emptyMessage || 'None'}</p>
		{:else}
			{#each categories as cat (cat)}
				<div class="mb-3">
					<p class="mb-0.5 px-1 text-[11px] font-medium tracking-wider text-fg-subtle uppercase">
						{cat}
					</p>
					{#each grouped[cat] as s (`${s.source}::${s.name}`)}
						<button
							type="button"
							onclick={() => void handleSelect(s.name)}
							class={`w-full rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${selectedName === s.name && selectedSource === expectedSource ? 'bg-surface-input text-fg' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'}`}
						>
							{s.name}
						</button>
					{/each}
				</div>
			{/each}
		{/if}
	</div>
{/snippet}

{#snippet skillView(skill: SkillDetail)}
	<div class="flex h-full flex-col gap-4">
		<div class="flex items-start justify-between gap-4">
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<span class="text-xs font-semibold tracking-widest text-indigo-400 uppercase"
						>{skill.category}</span
					>
					<span
						class="rounded border border-line px-2 py-0.5 text-[10px] tracking-wider text-fg-subtle uppercase"
						>{skill.source}</span
					>
				</div>
				<h2 class="mt-1 text-base font-semibold break-words text-fg">{skill.name}</h2>
				<p class="mt-1 text-sm text-fg-muted">{skill.description}</p>
				<p class="mt-1 text-xs text-fg-muted italic">When to use: {skill.when_to_use}</p>
			</div>
			{#if skill.source === 'company'}
				<button
					type="button"
					onclick={() => void handleDelete()}
					class="shrink-0 rounded-lg border border-red-500/20 px-3 py-1.5 text-xs text-red-400 transition-colors hover:bg-red-500/10"
				>
					Delete
				</button>
			{/if}
		</div>

		<div
			class="h-[520px] flex-1 overflow-y-auto rounded-xl border border-line-strong bg-surface-elevated px-6 py-5"
		>
			<Markdown
				source={skill.body}
				class="prose-sm max-w-none prose-headings:font-semibold prose-headings:text-fg prose-p:leading-relaxed prose-p:text-fg prose-a:text-indigo-400 prose-a:no-underline hover:prose-a:underline prose-blockquote:border-line-strong prose-blockquote:text-fg-muted prose-strong:font-semibold prose-strong:text-fg prose-code:rounded prose-code:bg-surface-overlay prose-code:px-1.5 prose-code:py-0.5 prose-code:text-xs prose-code:text-indigo-300 prose-code:before:content-none prose-code:after:content-none prose-pre:border prose-pre:border-line-strong prose-pre:bg-surface-overlay prose-ol:text-fg prose-ul:text-fg prose-li:marker:text-fg-muted prose-table:text-fg prose-th:border-line-strong prose-th:text-fg prose-td:border-line-strong prose-hr:border-line-strong"
			/>
		</div>
	</div>
{/snippet}

<div class="mx-auto max-w-5xl px-6 py-8">
	<!-- Search bar -->
	<form
		onsubmit={(e) => {
			e.preventDefault();
			void handleSearch();
		}}
		class="mb-6 flex gap-2"
	>
		<input
			value={searchQuery}
			oninput={(e) => (searchQuery = e.currentTarget.value)}
			placeholder="Search skills semantically (e.g. 'cash forecast for next quarter')"
			aria-label="Search skills"
			class="flex-1 rounded-lg border border-line-strong bg-surface-elevated px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
		/>
		<button
			type="submit"
			disabled={isSearching}
			class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-400 disabled:opacity-40"
		>
			{isSearching ? 'Searching…' : 'Search'}
		</button>
		{#if searchHits !== null}
			<button
				type="button"
				onclick={clearSearch}
				class="rounded-lg border border-line-strong px-3 py-2 text-sm text-fg-muted transition-colors hover:text-fg"
			>
				Clear
			</button>
		{/if}
	</form>

	{#if error}
		<p
			role="alert"
			class="mb-4 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs text-red-400"
		>
			{error}
		</p>
	{/if}

	<div class="flex gap-6">
		<!-- Sidebar -->
		<div class="w-60 shrink-0 space-y-5">
			{#if searchHits !== null}
				<div>
					<p class="mb-1.5 px-1 text-xs font-semibold tracking-widest text-fg-muted uppercase">
						Results
					</p>
					{#if searchHits.length === 0}
						<p class="px-1 text-xs text-fg-subtle">No matches</p>
					{:else}
						{#each searchHits as hit (`${hit.source}::${hit.name}`)}
							<button
								type="button"
								onclick={() => void handleSelect(hit.name)}
								class={`w-full rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors ${selected?.name === hit.name ? 'bg-surface-input text-fg' : 'text-fg-muted hover:bg-surface-overlay hover:text-fg'}`}
							>
								<div class="flex items-center justify-between gap-2">
									<span class="truncate">{hit.name}</span>
									<span class="shrink-0 text-[10px] text-fg-subtle">{hit.score.toFixed(2)}</span>
								</div>
							</button>
						{/each}
					{/if}
				</div>
			{:else}
				{@render skillSection(
					'Built-in',
					builtinGrouped,
					'builtin',
					selected?.name,
					selected?.source,
					''
				)}
				{@render skillSection(
					'Yours',
					userGrouped,
					'company',
					selected?.name,
					selected?.source,
					'Skills you save will appear here.'
				)}
			{/if}
		</div>

		<!-- Detail pane -->
		<div class="min-w-0 flex-1">
			{#if selected}
				{@render skillView(selected)}
			{:else}
				<div class="flex h-64 flex-col items-center justify-center gap-2 text-sm text-fg-subtle">
					<p>Select a skill to view its procedure.</p>
					<p class="text-xs text-fg-subtle">
						The Executive will call <code class="text-indigo-400">search_skills</code> when relevant.
					</p>
				</div>
			{/if}
		</div>
	</div>
</div>

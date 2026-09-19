<script lang="ts">
	import { onMount } from 'svelte';
	import ProfileSections from '$lib/components/company-profile/ProfileSections.svelte';
	import OnboardDepartmentsDraft from '$lib/components/onboard/OnboardDepartmentsDraft.svelte';
	import OnboardPeopleDraft from '$lib/components/onboard/OnboardPeopleDraft.svelte';
	import {
		commitOnboardDraft,
		listDepartments,
		type CompanyProfile,
		type OnboardDepartmentDraft,
		type OnboardPersonDraft,
		type OnboardTurn
	} from '$lib/api.js';

	function hasDuplicates(values: string[]): boolean {
		const seen: string[] = [];
		for (const v of values) {
			if (seen.includes(v)) return true;
			seen.push(v);
		}
		return false;
	}

	interface Props {
		turn: OnboardTurn;
		onBackToConversation: () => void;
		onSaved: () => void;
	}

	let { turn, onBackToConversation, onSaved }: Props = $props();

	// The draft is local state until the single commit at the end — every edit
	// below, including the ProfileSections ones, just merges into it.
	// svelte-ignore state_referenced_locally
	let profile = $state<CompanyProfile>(turn.draft!);
	// svelte-ignore state_referenced_locally
	let people = $state<OnboardPersonDraft[]>(turn.draft_people);
	// svelte-ignore state_referenced_locally
	let departments = $state<OnboardDepartmentDraft[]>(turn.draft_departments);
	let existingTitles = $state<string[]>([]);
	let saving = $state(false);
	let error = $state<string | null>(null);

	onMount(() => {
		listDepartments()
			.then((ds) => (existingTitles = ds.map((d) => d.config.title)))
			.catch(() => (existingTitles = []));
	});

	// The seam that lets the /company-profile section editors work here: they
	// call onSave with a patch, and we merge it locally instead of PATCHing.
	async function mergeIntoDraft(patch: Partial<CompanyProfile>) {
		profile = { ...profile, ...patch };
	}

	// Check the principal over the people we actually SEND, not over all rows —
	// a blank row flagged "this is me" is filtered out server-side, which would
	// otherwise save a company with no principal at all.
	const namedPeople = $derived(people.filter((p) => p.full_name.trim()));
	const principals = $derived(namedPeople.filter((p) => p.is_principal).length);
	const namedDepartments = $derived(departments.filter((d) => d.title.trim()));
	const duplicateNames = $derived(
		hasDuplicates(namedPeople.map((p) => p.full_name.trim().toLowerCase()))
	);
	const duplicateDepartments = $derived(
		hasDuplicates(namedDepartments.map((d) => d.title.trim().toLowerCase()))
	);

	const blocker = $derived(
		!profile.name.trim()
			? 'Your company needs a name.'
			: namedPeople.length === 0
				? 'Add at least one person, and mark which one is you.'
				: principals !== 1
					? 'Mark exactly one person as you.'
					: duplicateNames
						? 'Two people have the same name — give them distinct names.'
						: duplicateDepartments
							? 'Two departments have the same name.'
							: null
	);

	function handlePeopleChange(next: OnboardPersonDraft[]) {
		// Keep department heads in sync. A renamed person would otherwise leave a
		// head_person_name matching nobody, which the server drops silently — the
		// head would just vanish on save.
		const valid: string[] = [];
		for (const p of next) {
			const n = p.full_name.trim();
			if (n) valid.push(n);
		}
		const renamed: [string, string][] = [];
		next.forEach((p, i) => {
			const before = people[i]?.full_name.trim();
			const after = p.full_name.trim();
			if (before && after && before !== after) renamed.push([before, after]);
		});
		departments = departments.map((d) => {
			const head = d.head_person_name.trim();
			if (!head) return d;
			const moved = renamed.find(([from]) => from === head)?.[1];
			if (moved) return { ...d, head_person_name: moved };
			return valid.includes(head) ? d : { ...d, head_person_name: '' };
		});
		people = next;
	}

	async function save() {
		if (blocker || saving) return;
		saving = true;
		error = null;
		try {
			await commitOnboardDraft(turn.session_id, profile, namedPeople, namedDepartments);
			onSaved();
		} catch (err) {
			error = (err as Error).message;
			saving = false;
		}
	}
</script>

<div class="flex flex-col gap-4">
	<div>
		<h1 class="text-lg font-semibold text-fg">Here&rsquo;s what I understood</h1>
		<p class="mt-0.5 text-sm text-fg-muted">
			Nothing is saved yet. Edit anything that&rsquo;s off, then save.
		</p>
	</div>

	{#if turn.summary}
		<div class="rounded-xl border border-line bg-surface-elevated px-5 py-4">
			<p class="text-sm whitespace-pre-wrap text-fg">{turn.summary}</p>
		</div>
	{/if}

	{#if turn.confidence_notes.length > 0}
		<div class="rounded-xl border border-amber-500/20 bg-amber-500/10 px-5 py-4">
			<p class="mb-2 text-xs font-medium tracking-wide text-amber-400 uppercase">
				I couldn&rsquo;t determine these
			</p>
			<ul class="flex flex-col gap-1">
				{#each turn.confidence_notes as note, i (i)}
					<li class="text-sm text-fg">{note}</li>
				{/each}
			</ul>
		</div>
	{/if}

	<!-- "org" is omitted: org_structure is derived from the two tables below when
	     you save, so editing it here would be a second source of truth. -->
	<ProfileSections {profile} saving={false} onSave={mergeIntoDraft} omit={['org']} />

	<OnboardPeopleDraft {people} onChange={handlePeopleChange} />
	<OnboardDepartmentsDraft
		{departments}
		{people}
		{existingTitles}
		onChange={(next) => (departments = next)}
	/>

	{#if error}
		<p class="text-sm text-red-400" role="alert">{error}</p>
	{/if}
	{#if blocker}
		<p class="text-xs text-fg-muted">{blocker}</p>
	{/if}

	<div class="flex items-center gap-3 pb-10">
		<button
			type="button"
			onclick={() => void save()}
			disabled={saving || blocker !== null}
			class="rounded-lg bg-indigo-500 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-indigo-600 disabled:opacity-40"
		>
			{saving ? 'Saving…' : 'Save & finish setup'}
		</button>
		<button
			type="button"
			onclick={onBackToConversation}
			disabled={saving}
			class="text-xs text-fg-muted transition-colors hover:text-fg disabled:opacity-40"
		>
			Not quite — ask me more questions
		</button>
	</div>
</div>

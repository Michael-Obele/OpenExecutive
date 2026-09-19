<script lang="ts">
	import { onMount } from 'svelte';
	import ProfileSections, {
		LIST_FIELDS,
		NUM_FIELDS,
		TEXT_FIELDS,
		coerceList,
		snapshotProfile
	} from '$lib/components/company-profile/ProfileSections.svelte';
	import { useAskOEForm, type RegisteredForm } from '$lib/components/askoe/askoe.svelte.js';
	import {
		getCompanyProfile,
		updateCompanyProfile,
		type CompanyProfile,
		type PageFormField
	} from '$lib/api.js';

	let profile = $state<CompanyProfile | null>(null);
	let loading = $state(true);
	let notFound = $state(false);
	let saving = $state(false);

	// Handle on the section editors: Ask OE patches have to land in their draft
	// state, so the page reaches them through the component export.
	let sections = $state<ProfileSections | undefined>(undefined);

	onMount(() => {
		getCompanyProfile()
			.then((p) => (profile = p))
			.catch((err: Error) => {
				if (err.message === '404') notFound = true;
			})
			.finally(() => (loading = false));
	});

	async function save(patch: Partial<CompanyProfile>) {
		saving = true;
		try {
			profile = await updateCompanyProfile(patch);
		} finally {
			saving = false;
		}
	}

	// Register with Ask OE once the profile is loaded. Field values are the
	// SAVED profile values — unsaved per-section drafts stay local to each
	// section until the user hits Save.
	const form: RegisteredForm = {
		formId: 'company_profile',
		title: 'Company profile',
		description:
			'The structured company profile the Executive grounds every answer in. ' +
			'Applied values open the matching section in edit mode; the user saves per section.',
		getFields: (): PageFormField[] => {
			const current = profile;
			if (!current) return [];
			const flat = snapshotProfile(current);
			const label = (k: string) => k.replaceAll('_', ' ');
			return Object.entries(flat).map(([name, value]) => ({
				name,
				label: label(name),
				type: NUM_FIELDS.has(name)
					? ('number' as const)
					: LIST_FIELDS.has(name)
						? ('json' as const)
						: ('text' as const),
				value,
				description: LIST_FIELDS.has(name) ? 'JSON array of strings.' : ''
			}));
		},
		applyPatch: (values) => {
			const current = profile;
			if (!current) {
				return { applied: [], skipped: Object.keys(values), undo: () => {} };
			}
			const applied: string[] = [];
			const skipped: string[] = [];
			const picked: Record<string, unknown> = {};
			for (const [key, raw] of Object.entries(values)) {
				if (TEXT_FIELDS.has(key) && typeof raw === 'string') {
					picked[key] = raw;
					applied.push(key);
				} else if (NUM_FIELDS.has(key) && Number.isFinite(Number(raw))) {
					picked[key] = Number(raw);
					applied.push(key);
				} else if (LIST_FIELDS.has(key)) {
					const list = coerceList(raw);
					if (list !== null) {
						picked[key] = list;
						applied.push(key);
					} else skipped.push(key);
				} else skipped.push(key);
			}
			if (applied.length > 0) sections?.applyValues(picked);
			const savedSnapshot = snapshotProfile(current);
			return {
				applied,
				skipped,
				undo: () => {
					// Restore the SAVED values for the touched fields; sections
					// stay in edit mode so the user sees what was restored.
					const restore: Record<string, unknown> = {};
					for (const k of applied) restore[k] = savedSnapshot[k];
					sections?.applyValues(restore);
				}
			};
		}
	};

	useAskOEForm(() => (profile ? form : null));
</script>

<div class="flex h-full flex-col bg-surface">
	<main class="flex-1 overflow-y-auto">
		<div class="mx-auto max-w-3xl px-6 py-10">
			{#if loading}
				<div
					class="flex h-40 items-center justify-center"
					role="status"
					aria-label="Loading company profile"
				>
					<div
						class="h-5 w-5 animate-spin rounded-full border-2 border-indigo-500 border-t-transparent"
					></div>
				</div>
			{/if}

			{#if notFound}
				<div
					class="flex items-center justify-between rounded-xl border border-indigo-500/20 bg-indigo-500/10 px-5 py-4"
				>
					<p class="text-sm text-fg">No company profile set up yet.</p>
					<a
						href="/onboard"
						class="text-xs font-medium text-indigo-400 transition-colors hover:text-indigo-300"
					>
						Complete setup →
					</a>
				</div>
			{/if}

			{#if profile}
				{@const current = profile}
				<div class="mb-8 flex items-center justify-between">
					<div>
						<h1 class="text-lg font-semibold text-fg">{current.name}</h1>
						<p class="mt-0.5 text-sm text-fg-muted">
							{[current.industry, current.stage].filter(Boolean).join(' · ')}
						</p>
					</div>
					<a href="/onboard" class="text-xs text-fg-muted transition-colors hover:text-fg-muted">
						Re-run setup →
					</a>
				</div>

				<ProfileSections bind:this={sections} profile={current} {saving} onSave={save} />
			{/if}
		</div>
	</main>
</div>

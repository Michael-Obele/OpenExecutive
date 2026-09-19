<script lang="ts">
	import type { OnboardDepartmentDraft, OnboardPersonDraft } from '$lib/api.js';

	const AUTHORITY_LEVELS = [
		{ value: 'propose_only', label: 'Proposes, you approve' },
		{ value: 'escalate', label: 'Escalates to you' },
		{ value: 'auto_execute', label: 'Acts on its own' }
	];

	interface Props {
		departments: OnboardDepartmentDraft[];
		people: OnboardPersonDraft[];
		/** Titles of departments that already exist, so each row can say whether it
		 * updates one or creates a new one. Nothing is ever deleted. */
		existingTitles: string[];
		onChange: (departments: OnboardDepartmentDraft[]) => void;
	}

	let { departments, people, existingTitles, onChange }: Props = $props();

	// Lower-cased copy of the existing titles — a plain array keeps the lookup
	// derived (the parent fills it in asynchronously) without a reactive Set.
	let existing = $derived(existingTitles.map((t) => t.trim().toLowerCase()));

	function update(i: number, patch: Partial<OnboardDepartmentDraft>) {
		onChange(departments.map((d, j) => (j === i ? { ...d, ...patch } : d)));
	}
</script>

<div class="rounded-xl border border-line bg-surface-elevated p-5">
	<div class="mb-1 flex items-baseline justify-between">
		<h2 class="text-sm font-semibold text-fg">Departments</h2>
		<button
			type="button"
			onclick={() =>
				onChange([
					...departments,
					{
						title: '',
						mission: '',
						head_person_name: '',
						authority_level: 'propose_only'
					}
				])}
			class="text-xs text-indigo-400 transition-colors hover:text-indigo-300"
		>
			Add department
		</button>
	</div>
	<p class="mb-4 text-xs text-fg-muted">
		Saving updates the departments listed here and adds any that are new. Departments you
		don&rsquo;t list are left exactly as they are.
	</p>

	{#if departments.length === 0}
		<p class="text-sm text-fg-subtle italic">No departments drafted.</p>
	{/if}

	<div class="flex flex-col gap-3">
		{#each departments as d, i (i)}
			{@const isExisting = existing.includes(d.title.trim().toLowerCase())}
			<div class="flex flex-col gap-2 border-b border-line pb-3 last:border-0 last:pb-0">
				<div class="flex items-center gap-2">
					<input
						value={d.title}
						oninput={(e) => update(i, { title: e.currentTarget.value })}
						placeholder="Department"
						aria-label="Department"
						class="flex-1 rounded-lg border border-line-strong bg-surface-overlay px-3 py-2 text-sm text-fg transition-colors placeholder:text-fg-subtle focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
					/>
					<span
						class={`rounded-md px-2 py-1 text-[10px] tracking-wide whitespace-nowrap uppercase ${
							isExisting ? 'bg-surface-overlay text-fg-muted' : 'bg-indigo-500/10 text-indigo-400'
						}`}
					>
						{d.title.trim() ? (isExisting ? 'Updates existing' : 'New') : '—'}
					</span>
					<button
						type="button"
						onclick={() => onChange(departments.filter((_, j) => j !== i))}
						aria-label={`Remove ${d.title || 'department'}`}
						class="px-1 text-xs text-fg-subtle transition-colors hover:text-red-400"
					>
						✕
					</button>
				</div>
				<input
					value={d.mission}
					oninput={(e) => update(i, { mission: e.currentTarget.value })}
					placeholder="What this function owns"
					aria-label="What this function owns"
					class="w-full rounded-lg border border-line-strong bg-surface-overlay px-3 py-2 text-sm text-fg transition-colors placeholder:text-fg-subtle focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
				/>
				<div class="flex items-center gap-2">
					<select
						value={d.head_person_name}
						onchange={(e) => update(i, { head_person_name: e.currentTarget.value })}
						aria-label="Department head"
						class="flex-1 rounded-lg border border-line-strong bg-surface-overlay px-3 py-2 text-sm text-fg transition-colors focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
					>
						<option value="">No head assigned</option>
						{#each people.filter((p) => p.full_name.trim()) as p (p.full_name)}
							<option value={p.full_name}>{p.full_name}</option>
						{/each}
					</select>
					<select
						value={d.authority_level}
						onchange={(e) => update(i, { authority_level: e.currentTarget.value })}
						aria-label="Authority level"
						class="flex-1 rounded-lg border border-line-strong bg-surface-overlay px-3 py-2 text-sm text-fg transition-colors focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
					>
						{#each AUTHORITY_LEVELS as a (a.value)}
							<option value={a.value}>{a.label}</option>
						{/each}
					</select>
				</div>
			</div>
		{/each}
	</div>
</div>

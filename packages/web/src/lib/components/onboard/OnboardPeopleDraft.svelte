<script lang="ts">
	import type { OnboardPersonDraft } from '$lib/api.js';

	interface Props {
		people: OnboardPersonDraft[];
		onChange: (people: OnboardPersonDraft[]) => void;
	}

	let { people, onChange }: Props = $props();

	function update(i: number, patch: Partial<OnboardPersonDraft>) {
		onChange(people.map((p, j) => (j === i ? { ...p, ...patch } : p)));
	}

	function setPrincipal(i: number) {
		onChange(people.map((p, j) => ({ ...p, is_principal: j === i })));
	}
</script>

<!-- The leadership roster. Deliberately has no contact columns: OE never
     auto-imports emails or chat handles — those are added on the People page. -->
<div class="rounded-xl border border-line bg-surface-elevated p-5">
	<div class="mb-1 flex items-baseline justify-between">
		<h2 class="text-sm font-semibold text-fg">Your team</h2>
		<button
			type="button"
			onclick={() => onChange([...people, { full_name: '', role: '', is_principal: false }])}
			class="text-xs text-indigo-400 transition-colors hover:text-indigo-300"
		>
			Add person
		</button>
	</div>
	<p class="mb-4 text-xs text-fg-muted">
		Mark yourself with &ldquo;This is me&rdquo; — that&rsquo;s who the Executive reports to and
		escalates to. Contact details are added later on the People page.
	</p>

	{#if people.length === 0}
		<p class="text-sm text-fg-subtle italic">No one added yet.</p>
	{/if}

	<div class="flex flex-col gap-2">
		{#each people as p, i (i)}
			<div class="flex items-center gap-2">
				<input
					value={p.full_name}
					oninput={(e) => update(i, { full_name: e.currentTarget.value })}
					placeholder="Full name"
					aria-label="Full name"
					class="flex-1 rounded-lg border border-line-strong bg-surface-overlay px-3 py-2 text-sm text-fg transition-colors placeholder:text-fg-subtle focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
				/>
				<input
					value={p.role}
					oninput={(e) => update(i, { role: e.currentTarget.value })}
					placeholder="Role"
					aria-label="Role"
					class="flex-1 rounded-lg border border-line-strong bg-surface-overlay px-3 py-2 text-sm text-fg transition-colors placeholder:text-fg-subtle focus:ring-2 focus:ring-indigo-500/50 focus:outline-none"
				/>
				<label
					class="flex cursor-pointer items-center gap-1.5 text-xs whitespace-nowrap text-fg-muted"
				>
					<input
						type="radio"
						name="principal"
						checked={p.is_principal}
						onchange={() => setPrincipal(i)}
						class="accent-indigo-500"
					/>
					This is me
				</label>
				<button
					type="button"
					onclick={() => onChange(people.filter((_, j) => j !== i))}
					aria-label={`Remove ${p.full_name || 'person'}`}
					class="px-1 text-xs text-fg-subtle transition-colors hover:text-red-400"
				>
					✕
				</button>
			</div>
		{/each}
	</div>
</div>

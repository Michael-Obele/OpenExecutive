<script lang="ts">
	import { onMount } from 'svelte';
	import { goto } from '$app/navigation';
	import { page } from '$app/state';
	import { useAskOEForm, type RegisteredForm } from '$lib/components/askoe/askoe.svelte.js';
	import {
		DYNAMIC_SPECIALISTS,
		createCustomWorkflow,
		getCustomWorkflow,
		listPeople,
		updateCustomWorkflow,
		type DynamicInputField,
		type DynamicStep,
		type DynamicWorkflowDef,
		type PageFormField,
		type Person,
		type WorkflowSection
	} from '$lib/api.js';

	const SECTIONS: WorkflowSection[] = [
		'Board',
		'Capital & Investors',
		'Growth & GTM',
		'Product',
		'People',
		'Risk, Legal & Crisis',
		'Operating Cadence'
	];

	type StepKind = DynamicStep['kind'];

	function newStep(kind: StepKind, idx: number): DynamicStep {
		const id = `step_${idx + 1}`;
		if (kind === 'specialist')
			return { kind, id, title: '', specialist: 'cso', goal: '', rag_query: '' };
		if (kind === 'approval_gate')
			return {
				kind,
				id,
				title: '',
				person_id: 0,
				question: '',
				timeout_hours: 48,
				on_timeout: 'escalate'
			};
		return { kind, id, title: 'Assemble', instructions: '', specialist: 'cso' };
	}

	const inputCls =
		'w-full px-3 py-1.5 text-sm rounded-md bg-surface/60 border border-line text-fg placeholder:text-fg-subtle focus:outline-none focus:ring-1 focus:ring-indigo-500/40';
	const labelCls = 'block text-xs font-medium text-fg-muted mb-1';

	// ---- Ask OE form descriptor helpers ---------------------------------------

	const INPUT_FIELDS_SCHEMA =
		'JSON array of input-field objects: {"name": snake_case string, "label": string, ' +
		'"description"?: string, "required": boolean, "multiline": boolean}. ' +
		'Reference fields in step goals with {field_name} placeholders.';

	function stepsSchema(people: Person[]): string {
		const roster = people.map((p) => `${p.id} = ${p.full_name} (${p.role})`).join('; ');
		return (
			'JSON array of step objects, run in order. Three kinds: ' +
			'{"kind": "specialist", "id": string, "title": string, "specialist": one of [' +
			DYNAMIC_SPECIALISTS.join(', ') +
			'], "goal": string (may use {field} placeholders), "rag_query"?: string} | ' +
			'{"kind": "approval_gate", "id": string, "title": string, "person_id": number, ' +
			'"question": string, "timeout_hours"?: number, "on_timeout"?: "escalate" | "auto_proceed" | "fail"} | ' +
			'{"kind": "synthesis", "id": string, "title": string, "specialist"?: string, "instructions"?: string}. ' +
			'The LAST step must be a synthesis step. ' +
			(roster ? `person_id must be one of: ${roster}.` : 'No people on the roster yet.')
		);
	}

	/** Parse a json-typed proposal value (the model may send a JSON string). */
	function asJsonValue(raw: unknown): unknown {
		if (typeof raw !== 'string') return raw;
		try {
			return JSON.parse(raw);
		} catch {
			return raw;
		}
	}

	function coerceInputFields(raw: unknown): DynamicInputField[] | null {
		const v = asJsonValue(raw);
		if (!Array.isArray(v)) return null;
		const out: DynamicInputField[] = [];
		for (const f of v) {
			if (typeof f !== 'object' || f === null) continue;
			const rec = f as Record<string, unknown>;
			if (typeof rec.name !== 'string' || typeof rec.label !== 'string') continue;
			out.push({
				name: rec.name,
				label: rec.label,
				description: typeof rec.description === 'string' ? rec.description : '',
				required: rec.required !== false,
				multiline: rec.multiline === true
			});
		}
		return out;
	}

	const STEP_KINDS: ReadonlySet<string> = new Set(['specialist', 'approval_gate', 'synthesis']);

	function coerceSteps(raw: unknown): DynamicStep[] | null {
		const v = asJsonValue(raw);
		if (!Array.isArray(v)) return null;
		const out: DynamicStep[] = [];
		v.forEach((s, i) => {
			if (typeof s !== 'object' || s === null) return;
			const rec = s as Record<string, unknown>;
			const kind = rec.kind;
			if (typeof kind !== 'string' || !STEP_KINDS.has(kind)) return;
			// Start from the kind's defaults so missing optional keys stay valid,
			// then overlay whatever the proposal supplied.
			const base = newStep(kind as StepKind, i) as unknown as Record<string, unknown>;
			const merged = { ...base, ...rec, kind } as unknown as DynamicStep;
			if (typeof merged.id !== 'string' || !merged.id) merged.id = `step_${i + 1}`;
			out.push(merged);
		});
		return out.length > 0 ? out : null;
	}

	/** `?edit=<name>` puts the builder in edit mode for an existing workflow. */
	const editName = page.url.searchParams.get('edit');

	let people = $state<Person[]>([]);
	let name = $state('');
	let title = $state('');
	let description = $state('');
	let section = $state<WorkflowSection>('Operating Cadence');
	let estimatedMinutes = $state(4);
	let fields = $state<DynamicInputField[]>([]);
	let steps = $state<DynamicStep[]>([newStep('specialist', 0), newStep('synthesis', 1)]);
	let cadenceEnabled = $state(false);
	let cadence = $state('weekly@mon@09:00');
	let cadencePersonId = $state<number>(0);

	let saving = $state(false);
	let error = $state<string | null>(null);
	let loading = $state(!!editName);

	// ---- Ask OE registration ---------------------------------------------------
	// One descriptor object whose closures read current state, so the panel always
	// snapshots live values and `applyPatch` writes straight into the form.
	const form: RegisteredForm = {
		formId: 'workflow_builder',
		title: editName ? 'Edit workflow' : 'New workflow',
		description:
			'Builds a reusable executive job from specialist steps, optional approval gates, and a final synthesis step.',
		getFields: (): PageFormField[] => [
			{
				name: 'name',
				label: 'Name (snake_case, unique)',
				type: 'text',
				value: name,
				required: true,
				description: editName
					? 'Immutable — this workflow already exists.'
					: 'snake_case unique identifier, e.g. weekly_competitor_watch.'
			},
			{ name: 'title', label: 'Title', type: 'text', value: title, required: true },
			{ name: 'description', label: 'Description', type: 'text', value: description },
			{
				name: 'section',
				label: 'Section',
				type: 'select',
				options: [...SECTIONS],
				value: section
			},
			{
				name: 'estimated_minutes',
				label: 'Estimated minutes',
				type: 'number',
				value: estimatedMinutes,
				description: '1-120.'
			},
			{
				name: 'input_fields',
				label: 'Input fields',
				type: 'json',
				value: fields,
				description: INPUT_FIELDS_SCHEMA
			},
			{
				name: 'steps',
				label: 'Steps',
				type: 'json',
				value: steps,
				required: true,
				description: stepsSchema(people)
			},
			{
				name: 'cadence_enabled',
				label: 'Run on a schedule',
				type: 'boolean',
				value: cadenceEnabled
			},
			{
				name: 'cadence',
				label: 'Cadence',
				type: 'text',
				value: cadence,
				description: 'daily@HH:MM / weekly@DOW@HH:MM / quarterly@DD-HH:MM, UTC.'
			},
			{
				name: 'cadence_person_id',
				label: 'Deliver artifact to (person id)',
				type: 'number',
				value: cadencePersonId,
				description: people.map((p) => `${p.id} = ${p.full_name}`).join('; ') || 'No people yet.'
			}
		],
		applyPatch: (values) => {
			const prior = {
				name,
				title,
				description,
				section,
				estimatedMinutes,
				fields,
				steps,
				cadenceEnabled,
				cadence,
				cadencePersonId
			};
			const applied: string[] = [];
			const skipped: string[] = [];
			for (const [key, raw] of Object.entries(values)) {
				switch (key) {
					case 'name':
						if (editName || typeof raw !== 'string') skipped.push(key);
						else {
							name = raw;
							applied.push(key);
						}
						break;
					case 'title':
						if (typeof raw !== 'string') skipped.push(key);
						else {
							title = raw;
							applied.push(key);
						}
						break;
					case 'description':
						if (typeof raw !== 'string') skipped.push(key);
						else {
							description = raw;
							applied.push(key);
						}
						break;
					case 'section':
						if (typeof raw === 'string' && (SECTIONS as string[]).includes(raw)) {
							section = raw as WorkflowSection;
							applied.push(key);
						} else skipped.push(key);
						break;
					case 'estimated_minutes': {
						const n = Number(raw);
						if (Number.isFinite(n) && n >= 1 && n <= 120) {
							estimatedMinutes = Math.round(n);
							applied.push(key);
						} else skipped.push(key);
						break;
					}
					case 'input_fields': {
						const parsed = coerceInputFields(raw);
						if (parsed !== null) {
							fields = parsed;
							applied.push(key);
						} else skipped.push(key);
						break;
					}
					case 'steps': {
						const parsed = coerceSteps(raw);
						if (parsed !== null) {
							steps = parsed;
							applied.push(key);
						} else skipped.push(key);
						break;
					}
					case 'cadence_enabled':
						if (typeof raw === 'boolean') {
							cadenceEnabled = raw;
							applied.push(key);
						} else skipped.push(key);
						break;
					case 'cadence':
						if (typeof raw !== 'string') skipped.push(key);
						else {
							cadence = raw;
							cadenceEnabled = true;
							applied.push(key);
						}
						break;
					case 'cadence_person_id': {
						const n = Number(raw);
						if (Number.isFinite(n) && people.some((p) => p.id === n)) {
							cadencePersonId = n;
							applied.push(key);
						} else skipped.push(key);
						break;
					}
					default:
						skipped.push(key);
				}
			}
			return {
				applied,
				skipped,
				undo: () => {
					name = prior.name;
					title = prior.title;
					description = prior.description;
					section = prior.section;
					estimatedMinutes = prior.estimatedMinutes;
					fields = prior.fields;
					steps = prior.steps;
					cadenceEnabled = prior.cadenceEnabled;
					cadence = prior.cadence;
					cadencePersonId = prior.cadencePersonId;
				}
			};
		}
	};

	const { suggestedCls, clearSuggested } = useAskOEForm(() => form);

	function addField() {
		fields = [
			...fields,
			{ name: '', label: '', description: '', required: true, multiline: false }
		];
	}

	function removeField(i: number) {
		fields = fields.filter((_, idx) => idx !== i);
	}

	function updateField(i: number, patch: Partial<DynamicInputField>) {
		fields = fields.map((f, idx) => (idx === i ? { ...f, ...patch } : f));
	}

	function updateStep(i: number, patch: Partial<DynamicStep>) {
		steps = steps.map((s, idx) => (idx === i ? ({ ...s, ...patch } as DynamicStep) : s));
	}

	function moveStep(i: number, dir: -1 | 1) {
		const j = i + dir;
		if (j < 0 || j >= steps.length) return;
		const next = [...steps];
		[next[i], next[j]] = [next[j], next[i]];
		steps = next;
	}

	function addStep(kind: StepKind) {
		steps = [...steps, newStep(kind, steps.length)];
	}

	function removeStep(i: number) {
		steps = steps.filter((_, idx) => idx !== i);
	}

	onMount(() => {
		// The roster is resolved before an existing workflow is loaded, so the
		// person `<select>`s already hold their options when the stored
		// `person_id`s are applied — a `<select value=…>` whose matching option
		// arrives later silently falls back to the placeholder. Best-effort
		// either way: a failed roster fetch leaves the person fields empty.
		void (async () => {
			const roster = await listPeople().catch((): Person[] => []);
			people = roster.filter((x) => !x.archived);

			const editTarget = editName;
			if (!editTarget) return;
			try {
				const d = await getCustomWorkflow(editTarget);
				name = d.name;
				title = d.title;
				description = d.description ?? '';
				section = d.section;
				estimatedMinutes = d.estimated_minutes;
				fields = d.input_fields;
				steps = d.steps;
				if (d.cadence) {
					cadenceEnabled = true;
					cadence = d.cadence;
					cadencePersonId = d.cadence_person_id ?? 0;
				}
			} catch (e) {
				error = e instanceof Error ? e.message : String(e);
			} finally {
				loading = false;
			}
		})();
	});

	async function handleSave() {
		error = null;
		saving = true;
		const def: DynamicWorkflowDef = {
			name: name.trim(),
			title: title.trim(),
			description: description.trim(),
			section,
			estimated_minutes: estimatedMinutes,
			input_fields: fields,
			steps,
			cadence: cadenceEnabled ? cadence.trim() : null,
			cadence_person_id: cadenceEnabled ? cadencePersonId : null
		};
		try {
			if (editName) await updateCustomWorkflow(editName, def);
			else await createCustomWorkflow(def);
			void goto(`/jobs/${encodeURIComponent(def.name)}`);
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
			saving = false;
		}
	}
</script>

{#snippet stepEditor(step: DynamicStep, index: number, total: number)}
	<div class="space-y-3 rounded-md border border-line bg-surface/30 p-4">
		<div class="flex items-center justify-between">
			<span class="text-xs font-semibold tracking-wide text-fg-muted uppercase">
				{index + 1}. {step.kind.replace('_', ' ')}
			</span>
			<div class="flex items-center gap-2 text-xs text-fg-muted">
				<button
					type="button"
					aria-label="Move step up"
					onclick={() => moveStep(index, -1)}
					disabled={index === 0}
					class="disabled:opacity-40"
				>
					↑
				</button>
				<button
					type="button"
					aria-label="Move step down"
					onclick={() => moveStep(index, 1)}
					disabled={index === total - 1}
					class="disabled:opacity-40"
				>
					↓
				</button>
				<button type="button" class="hover:text-red-400" onclick={() => removeStep(index)}>
					Remove
				</button>
			</div>
		</div>

		<div class="grid gap-3 sm:grid-cols-2">
			<div>
				<label for={`step-${index}-id`} class={labelCls}>Step id</label>
				<input
					id={`step-${index}-id`}
					class={inputCls}
					value={step.id}
					oninput={(e) => updateStep(index, { id: e.currentTarget.value })}
				/>
			</div>
			<div>
				<label for={`step-${index}-title`} class={labelCls}>Title</label>
				<input
					id={`step-${index}-title`}
					class={inputCls}
					value={step.title}
					oninput={(e) => updateStep(index, { title: e.currentTarget.value })}
				/>
			</div>
		</div>

		{#if step.kind === 'specialist'}
			<div>
				<label for={`step-${index}-specialist`} class={labelCls}>Specialist</label>
				<select
					id={`step-${index}-specialist`}
					class={inputCls}
					value={step.specialist}
					onchange={(e) => updateStep(index, { specialist: e.currentTarget.value })}
				>
					{#each DYNAMIC_SPECIALISTS as s (s)}
						<option value={s}>{s}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for={`step-${index}-goal`} class={labelCls}>
					Goal (use &#123;field&#125; placeholders)
				</label>
				<textarea
					id={`step-${index}-goal`}
					class={`${inputCls} min-h-20`}
					value={step.goal}
					oninput={(e) => updateStep(index, { goal: e.currentTarget.value })}></textarea>
			</div>
			<div>
				<label for={`step-${index}-rag`} class={labelCls}>Knowledge base query (optional)</label>
				<input
					id={`step-${index}-rag`}
					class={inputCls}
					value={step.rag_query ?? ''}
					oninput={(e) => updateStep(index, { rag_query: e.currentTarget.value })}
				/>
			</div>
		{/if}

		{#if step.kind === 'approval_gate'}
			<div>
				<label for={`step-${index}-person`} class={labelCls}>Ask which person</label>
				<select
					id={`step-${index}-person`}
					class={inputCls}
					value={step.person_id}
					onchange={(e) => updateStep(index, { person_id: Number(e.currentTarget.value) })}
				>
					<option value={0}>Select a person…</option>
					{#each people as p (p.id)}
						<option value={p.id}>{p.full_name} — {p.role}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for={`step-${index}-question`} class={labelCls}>Question</label>
				<textarea
					id={`step-${index}-question`}
					class={`${inputCls} min-h-15`}
					value={step.question}
					oninput={(e) => updateStep(index, { question: e.currentTarget.value })}></textarea>
			</div>
			<div class="grid gap-3 sm:grid-cols-2">
				<div>
					<label for={`step-${index}-timeout`} class={labelCls}>Timeout (hours)</label>
					<input
						id={`step-${index}-timeout`}
						type="number"
						min={1}
						max={720}
						class={inputCls}
						value={step.timeout_hours ?? 48}
						oninput={(e) => updateStep(index, { timeout_hours: Number(e.currentTarget.value) })}
					/>
				</div>
				<div>
					<label for={`step-${index}-on-timeout`} class={labelCls}>On timeout</label>
					<select
						id={`step-${index}-on-timeout`}
						class={inputCls}
						value={step.on_timeout ?? 'escalate'}
						onchange={(e) =>
							updateStep(index, {
								on_timeout: e.currentTarget.value as 'escalate' | 'auto_proceed' | 'fail'
							})}
					>
						<option value="escalate">escalate</option>
						<option value="auto_proceed">auto_proceed</option>
						<option value="fail">fail</option>
					</select>
				</div>
			</div>
		{/if}

		{#if step.kind === 'synthesis'}
			<div>
				<label for={`step-${index}-synth-specialist`} class={labelCls}>Synthesis specialist</label>
				<select
					id={`step-${index}-synth-specialist`}
					class={inputCls}
					value={step.specialist ?? 'cso'}
					onchange={(e) => updateStep(index, { specialist: e.currentTarget.value })}
				>
					{#each DYNAMIC_SPECIALISTS as s (s)}
						<option value={s}>{s}</option>
					{/each}
				</select>
			</div>
			<div>
				<label for={`step-${index}-instructions`} class={labelCls}>
					Instructions (optional — leave blank to just concatenate sections)
				</label>
				<textarea
					id={`step-${index}-instructions`}
					class={`${inputCls} min-h-15`}
					value={step.instructions ?? ''}
					oninput={(e) => updateStep(index, { instructions: e.currentTarget.value })}></textarea>
			</div>
		{/if}
	</div>
{/snippet}

<main class="flex min-h-0 flex-1 flex-col text-fg">
	<div class="mx-auto w-full max-w-3xl px-4 py-8 sm:px-6">
		<div class="mb-6">
			<a href="/jobs" class="text-xs text-fg-muted hover:text-fg">← Back to jobs</a>
			<h1 class="mt-2 mb-1 text-2xl font-semibold text-fg">New workflow</h1>
			<p class="text-sm text-fg-muted">
				Build a reusable executive job from specialist steps, optional approval gates, and a final
				synthesis step. You can also ask the Executive in chat to create one for you.
			</p>
		</div>

		{#if loading}
			<div class="text-sm text-fg-muted" role="status">Loading…</div>
		{:else}
			<div class="space-y-8">
				<!-- Metadata -->
				<section class="space-y-4">
					<h2 class="text-base font-semibold text-fg">Details</h2>
					<div class="grid gap-4 sm:grid-cols-2">
						<div>
							<label for="wf-name" class={labelCls}>Name (snake_case, unique)</label>
							<input
								id="wf-name"
								class={`${inputCls} ${suggestedCls('name')}`}
								value={name}
								disabled={!!editName}
								oninput={(e) => {
									name = e.currentTarget.value;
									clearSuggested('name');
								}}
								placeholder="weekly_competitor_watch"
							/>
						</div>
						<div>
							<label for="wf-title" class={labelCls}>Title</label>
							<input
								id="wf-title"
								class={`${inputCls} ${suggestedCls('title')}`}
								value={title}
								oninput={(e) => {
									title = e.currentTarget.value;
									clearSuggested('title');
								}}
								placeholder="Weekly Competitor Watch"
							/>
						</div>
					</div>
					<div>
						<label for="wf-description" class={labelCls}>Description</label>
						<input
							id="wf-description"
							class={`${inputCls} ${suggestedCls('description')}`}
							value={description}
							oninput={(e) => {
								description = e.currentTarget.value;
								clearSuggested('description');
							}}
							placeholder="What this workflow produces"
						/>
					</div>
					<div class="grid gap-4 sm:grid-cols-2">
						<div>
							<label for="wf-section" class={labelCls}>Section</label>
							<select
								id="wf-section"
								class={`${inputCls} ${suggestedCls('section')}`}
								value={section}
								onchange={(e) => {
									section = e.currentTarget.value as WorkflowSection;
									clearSuggested('section');
								}}
							>
								{#each SECTIONS as s (s)}
									<option value={s}>{s}</option>
								{/each}
							</select>
						</div>
						<div>
							<label for="wf-estimated-minutes" class={labelCls}>Estimated minutes</label>
							<input
								id="wf-estimated-minutes"
								type="number"
								min={1}
								max={120}
								class={`${inputCls} ${suggestedCls('estimated_minutes')}`}
								value={estimatedMinutes}
								oninput={(e) => {
									estimatedMinutes = Number(e.currentTarget.value);
									clearSuggested('estimated_minutes');
								}}
							/>
						</div>
					</div>
				</section>

				<!-- Input fields -->
				<section
					class={`space-y-3 rounded-md ${suggestedCls('input_fields')}`}
					oninput={() => clearSuggested('input_fields')}
				>
					<div class="flex items-center justify-between">
						<h2 class="text-base font-semibold text-fg">Input fields</h2>
						<button
							type="button"
							class="text-xs text-indigo-400 hover:text-indigo-300"
							onclick={addField}
						>
							+ Add field
						</button>
					</div>
					<p class="text-xs text-fg-muted">
						Free-text fields the user fills when running. Reference them in step goals with
						<code>&#123;field_name&#125;</code>.
					</p>
					{#if fields.length === 0}
						<p class="text-xs text-fg-subtle">No input fields.</p>
					{/if}
					{#each fields as f, i (i)}
						<div
							class="grid items-end gap-3 rounded-md border border-line bg-surface/30 p-3 sm:grid-cols-[1fr_1fr_auto]"
						>
							<div>
								<label for={`field-name-${i}`} class={labelCls}>Field name</label>
								<input
									id={`field-name-${i}`}
									class={inputCls}
									value={f.name}
									oninput={(e) => updateField(i, { name: e.currentTarget.value })}
									placeholder="topic"
								/>
							</div>
							<div>
								<label for={`field-label-${i}`} class={labelCls}>Label</label>
								<input
									id={`field-label-${i}`}
									class={inputCls}
									value={f.label}
									oninput={(e) => updateField(i, { label: e.currentTarget.value })}
									placeholder="Topic"
								/>
							</div>
							<div class="flex items-center gap-3 pb-1.5">
								<label class="flex items-center gap-1 text-xs text-fg-muted">
									<input
										type="checkbox"
										checked={f.required}
										onchange={(e) => updateField(i, { required: e.currentTarget.checked })}
									/>
									Required
								</label>
								<button
									type="button"
									class="text-xs text-fg-muted hover:text-red-400"
									onclick={() => removeField(i)}
								>
									Remove
								</button>
							</div>
						</div>
					{/each}
				</section>

				<!-- Steps -->
				<section
					class={`space-y-3 rounded-md ${suggestedCls('steps')}`}
					oninput={() => clearSuggested('steps')}
				>
					<div class="flex items-center justify-between">
						<h2 class="text-base font-semibold text-fg">Steps</h2>
						<div class="flex gap-2">
							<button
								type="button"
								class="text-xs text-indigo-400 hover:text-indigo-300"
								onclick={() => addStep('specialist')}
							>
								+ Specialist
							</button>
							<button
								type="button"
								class="text-xs text-indigo-400 hover:text-indigo-300"
								onclick={() => addStep('approval_gate')}
							>
								+ Approval gate
							</button>
						</div>
					</div>
					<p class="text-xs text-fg-muted">
						Steps run in order. The last step must be a <b>synthesis</b> step that assembles the artifact.
						Place any approval gate just before it.
					</p>
					{#each steps as s, i (i)}
						{@render stepEditor(s, i, steps.length)}
					{/each}
				</section>

				<!-- Cadence -->
				<section class="space-y-3">
					<label class="flex items-center gap-2 text-base font-semibold text-fg">
						<input
							type="checkbox"
							checked={cadenceEnabled}
							onchange={(e) => (cadenceEnabled = e.currentTarget.checked)}
						/>
						Run on a schedule
					</label>
					{#if cadenceEnabled}
						<div class="grid gap-4 sm:grid-cols-2">
							<div>
								<label for="wf-cadence" class={labelCls}>
									Cadence (daily@HH:MM / weekly@DOW@HH:MM / quarterly@DD-HH:MM, UTC)
								</label>
								<input
									id="wf-cadence"
									class={`${inputCls} ${suggestedCls('cadence')}`}
									value={cadence}
									oninput={(e) => {
										cadence = e.currentTarget.value;
										clearSuggested('cadence');
									}}
									placeholder="weekly@mon@09:00"
								/>
							</div>
							<div>
								<label for="wf-cadence-person" class={labelCls}>Deliver artifact to</label>
								<select
									id="wf-cadence-person"
									class={`${inputCls} ${suggestedCls('cadence_person_id')}`}
									value={cadencePersonId}
									onchange={(e) => {
										cadencePersonId = Number(e.currentTarget.value);
										clearSuggested('cadence_person_id');
									}}
								>
									<option value={0}>Select a person…</option>
									{#each people as p (p.id)}
										<option value={p.id}>{p.full_name} — {p.role}</option>
									{/each}
								</select>
							</div>
							<p class="text-xs text-fg-subtle sm:col-span-2">
								Scheduled runs supply no inputs, so a scheduled workflow must have no <b>required</b
								> input fields.
							</p>
						</div>
					{/if}
				</section>

				{#if error}
					<div
						class="rounded-md border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-300"
						role="alert"
					>
						{error}
					</div>
				{/if}

				<div class="flex items-center gap-3 border-t border-line pt-4">
					<button
						type="button"
						disabled={saving}
						onclick={() => void handleSave()}
						class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:opacity-50"
					>
						{saving ? 'Saving…' : editName ? 'Save changes' : 'Create workflow'}
					</button>
					<a href="/jobs" class="text-sm text-fg-muted hover:text-fg">Cancel</a>
				</div>
			</div>
		{/if}
	</div>
</main>

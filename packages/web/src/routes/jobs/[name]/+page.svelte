<script lang="ts">
	import { onMount } from 'svelte';
	import { page } from '$app/state';
	import WorkflowRunner from '$lib/components/WorkflowRunner.svelte';
	import {
		getWorkflow,
		getWorkflowSample,
		listCandidates,
		listEngagements,
		type Candidate,
		type Engagement,
		type WorkflowInputFieldSchema,
		type WorkflowMeta
	} from '$lib/api.js';

	type FormState = Record<string, string>;

	// Decode the `?prefill=` query param (base64url-encoded UTF-8 JSON).
	// Returns an empty object on any decode error — a malformed link must
	// not crash the page. Uses TextDecoder so multi-byte UTF-8 chars (em
	// dashes, smart quotes, non-ASCII names) round-trip cleanly. Never
	// forward decoded values into `href`, `src`, or `innerHTML` without
	// sanitizing — only safe placement is the escaped form value props.
	function decodePrefill(raw: string | null): Record<string, unknown> {
		if (!raw) return {};
		try {
			const pad = '='.repeat((4 - (raw.length % 4)) % 4);
			const b64 = raw.replace(/-/g, '+').replace(/_/g, '/') + pad;
			const binary = atob(b64);
			const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
			const json = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
			const parsed = JSON.parse(json);
			return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
				? (parsed as Record<string, unknown>)
				: {};
		} catch {
			return {};
		}
	}

	function fieldLabel(name: string, schema: WorkflowInputFieldSchema): string {
		if (schema.title) return schema.title;
		return name
			.split('_')
			.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
			.join(' ');
	}

	function isMultiline(name: string, schema: WorkflowInputFieldSchema): boolean {
		// Heuristic: any "string" field with min length >= 10 OR a known multi-line
		// semantic name gets a textarea. Single-line strings stay as <input>.
		const multilineNames = new Set([
			'headline_metrics',
			'wins',
			'challenges',
			'deep_dive_topic_1',
			'deep_dive_topic_2',
			'decisions_needed',
			'description',
			'context',
			'notes',
			'summary'
		]);
		if (multilineNames.has(name)) return true;
		return typeof schema.minLength === 'number' && schema.minLength >= 50;
	}

	/** First string entry of `schema.examples`, or null when there is none. */
	function firstExample(schema: WorkflowInputFieldSchema): string | null {
		const examples = schema.examples;
		if (!Array.isArray(examples) || examples.length === 0) return null;
		const first = examples[0];
		return typeof first === 'string' ? first : null;
	}

	function placeholderFor(schema: WorkflowInputFieldSchema): string {
		const examples = schema.examples;
		if (!Array.isArray(examples) || examples.length === 0) return '';
		return String(examples[0]);
	}

	let name = $derived(page.params.name);
	const prefillRaw = page.url.searchParams.get('prefill');

	let workflow = $state<WorkflowMeta | null>(null);
	let loadError = $state<string | null>(null);
	let form = $state<FormState>({});
	let running = $state(false);
	let prefillBanner = $state<'suggestion' | 'sample' | null>(null);
	// Talent pickers: when a workflow exposes a `candidate_id` / `engagement_id`
	// field, fetch the roster so the user picks from a dropdown instead of typing
	// a raw id. Best-effort — on failure the field falls back to a text input.
	let candidates = $state<Candidate[]>([]);
	let engagements = $state<Engagement[]>([]);

	onMount(() => {
		let cancelled = false;

		void (async () => {
			const workflowName = name;
			if (!workflowName) return;
			try {
				const wf = await getWorkflow(workflowName);
				if (cancelled) return;
				const inputProps = wf.input_schema.properties ?? {};

				// Resolve any talent roster *before* the form values land, so the
				// picker `<select>`s already hold their options when the stored ids
				// are applied — a `<select value=…>` whose matching option arrives
				// later silently falls back to the placeholder.
				if ('candidate_id' in inputProps) {
					const roster = await listCandidates().catch((): Candidate[] => []);
					if (cancelled) return;
					candidates = roster;
				}
				if ('engagement_id' in inputProps) {
					const roster = await listEngagements().catch((): Engagement[] => []);
					if (cancelled) return;
					engagements = roster;
				}

				workflow = wf;

				// The form is initialised once, when the workflow arrives, and the
				// `?prefill=` param is consumed at that moment only — re-applying it
				// afterwards would clobber the user's in-progress edits. (The upstream
				// React version needed a ref guard for this; `onMount` runs once.)
				const initial: FormState = {};
				for (const key of Object.keys(inputProps)) {
					if (!Object.prototype.hasOwnProperty.call(inputProps, key)) continue;
					const schema = inputProps[key];
					initial[key] = typeof schema.default === 'string' ? schema.default : '';
				}
				const prefill = decodePrefill(prefillRaw);
				let appliedAny = false;
				for (const [key, value] of Object.entries(prefill)) {
					if (Object.prototype.hasOwnProperty.call(initial, key) && typeof value === 'string') {
						initial[key] = value;
						appliedAny = true;
					}
				}
				if (appliedAny) prefillBanner = 'suggestion';
				form = initial;
			} catch (e) {
				if (!cancelled) loadError = e instanceof Error ? e.message : String(e);
			}
		})();

		return () => {
			cancelled = true;
		};
	});

	const props = $derived<Record<string, WorkflowInputFieldSchema>>(
		workflow?.input_schema.properties ?? {}
	);

	const required = $derived(new Set(workflow?.input_schema.required ?? []));

	const allRequiredFilled = $derived.by(() => {
		if (!workflow) return false;
		for (const field of required) {
			if (!form[field] || !form[field].trim()) return false;
		}
		return true;
	});

	async function handleLoadSample() {
		const workflowName = name;
		if (!workflowName) return;
		try {
			const sample = await getWorkflowSample(workflowName);
			const next: FormState = { ...form };
			for (const [key, value] of Object.entries(sample.inputs)) {
				if (typeof value === 'string') next[key] = value;
			}
			form = next;
			prefillBanner = 'sample';
		} catch {
			// Non-fatal — leave the form as-is.
		}
	}

	function insertExample(field: string, schema: WorkflowInputFieldSchema) {
		const example = firstExample(schema);
		if (example !== null) form = { ...form, [field]: example };
	}

	function handleChange(field: string, value: string) {
		form = { ...form, [field]: value };
		// Once the user edits anything, drop the "pre-filled" banner — its
		// message no longer accurately describes what's in the form.
		prefillBanner = null;
	}

	function handleSubmit(e: SubmitEvent) {
		e.preventDefault();
		running = true;
	}

	function handleCancel() {
		running = false;
	}

	/** Talent picker options, when the workflow asks for a raw roster id. */
	function pickerItems(fieldName: string): { value: string; label: string }[] | null {
		if (fieldName === 'candidate_id' && candidates.length)
			return candidates.map((c) => ({
				value: String(c.id),
				label: `${c.full_name}${c.current_title ? ` — ${c.current_title}` : ''} (#${c.id})`
			}));
		if (fieldName === 'engagement_id' && engagements.length)
			return engagements.map((e) => ({ value: String(e.id), label: `${e.role_title} (#${e.id})` }));
		return null;
	}
</script>

{#if loadError}
	<main class="flex flex-1 flex-col items-center justify-center text-fg">
		<div class="mb-4 text-sm text-red-400" role="alert">Error: {loadError}</div>
		<a href="/jobs" class="text-sm text-fg-muted hover:text-fg">← Back to jobs</a>
	</main>
{:else if !workflow}
	<main class="flex flex-1 flex-col items-center justify-center text-sm text-fg-muted">
		<span role="status">Loading…</span>
	</main>
{:else}
	<main class="flex min-h-0 flex-1 flex-col text-fg">
		<div class="mx-auto w-full max-w-3xl space-y-8 px-4 py-8 sm:px-6">
			<div>
				<h1 class="mb-1 text-2xl font-semibold text-fg">{workflow.title}</h1>
				<p class="text-sm leading-relaxed text-fg-muted">{workflow.description}</p>
			</div>

			{#if !running}
				<form onsubmit={handleSubmit} class="space-y-5">
					<div
						class="flex items-center justify-between rounded-md border border-line bg-surface/40 px-3 py-2"
					>
						<div class="text-xs leading-relaxed text-fg-muted">
							Stuck on how to fill this out? Load a realistic sample to see what good inputs look
							like. You can edit anything before running.
						</div>
						<button
							type="button"
							onclick={() => void handleLoadSample()}
							class="ml-3 shrink-0 text-xs text-indigo-300 underline underline-offset-2 hover:text-indigo-200"
						>
							Load sample run
						</button>
					</div>

					{#if prefillBanner}
						<div
							role="status"
							aria-live="polite"
							class="flex items-start justify-between gap-3 rounded-md border border-indigo-500/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200"
						>
							<span>
								{prefillBanner === 'suggestion'
									? 'Inputs pre-filled from a suggestion. Review and edit before running.'
									: 'Sample inputs loaded. Edit anything before running.'}
							</span>
							<button
								type="button"
								onclick={() => (prefillBanner = null)}
								aria-label="Dismiss notice"
								class="shrink-0 rounded px-1 text-indigo-300 hover:text-indigo-100 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-300"
							>
								×
							</button>
						</div>
					{/if}

					{#each Object.entries(props) as [fieldName, schema] (fieldName)}
						{@const isRequired = required.has(fieldName)}
						{@const multiline = isMultiline(fieldName, schema)}
						{@const inputId = `field-${fieldName}`}
						{@const items = pickerItems(fieldName)}
						{@const example = firstExample(schema)}
						<div>
							<div class="mb-1 flex items-baseline justify-between">
								<label for={inputId} class="block text-sm font-medium text-fg">
									{fieldLabel(fieldName, schema)}
									{#if isRequired}<span class="ml-0.5 text-red-400">*</span>{/if}
								</label>
								{#if example !== null}
									<button
										type="button"
										onclick={() => insertExample(fieldName, schema)}
										aria-label={`Insert example value for ${fieldLabel(fieldName, schema)}`}
										class="rounded px-1 text-[11px] text-fg-muted transition hover:text-indigo-300 focus:outline-none focus-visible:ring-1 focus-visible:ring-indigo-400"
									>
										Insert example
									</button>
								{/if}
							</div>
							{#if schema.description}
								<p class="mb-2 text-xs leading-relaxed text-fg-muted">{schema.description}</p>
							{/if}
							{#if items}
								<select
									id={inputId}
									value={form[fieldName] ?? ''}
									onchange={(e) => handleChange(fieldName, e.currentTarget.value)}
									required={isRequired}
									class="w-full rounded-md border border-line bg-surface/60 px-3 py-2 text-sm text-fg focus:border-indigo-500 focus:outline-none"
								>
									<option value="">Select…</option>
									{#each items as opt (opt.value)}
										<option value={opt.value}>{opt.label}</option>
									{/each}
								</select>
							{:else if multiline}
								<textarea
									id={inputId}
									value={form[fieldName] ?? ''}
									oninput={(e) => handleChange(fieldName, e.currentTarget.value)}
									rows={4}
									required={isRequired}
									placeholder={placeholderFor(schema)}
									class="w-full rounded-md border border-line bg-surface/60 px-3 py-2 font-mono text-sm leading-relaxed text-fg placeholder:text-fg-subtle focus:border-indigo-500 focus:outline-none"
								></textarea>
							{:else}
								<input
									id={inputId}
									type="text"
									value={form[fieldName] ?? ''}
									oninput={(e) => handleChange(fieldName, e.currentTarget.value)}
									required={isRequired}
									placeholder={placeholderFor(schema)}
									class="w-full rounded-md border border-line bg-surface/60 px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-indigo-500 focus:outline-none"
								/>
							{/if}
						</div>
					{/each}

					<div class="flex items-center gap-3 pt-2">
						<button
							type="submit"
							disabled={!allRequiredFilled}
							class="rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:bg-surface-overlay disabled:text-fg-muted"
						>
							Continue
						</button>
						<span class="text-xs text-fg-muted">All fields with * are required.</span>
					</div>
				</form>
			{/if}

			{#if running}
				<WorkflowRunner {workflow} inputs={form} onCancel={handleCancel} />
			{/if}
		</div>
	</main>
{/if}

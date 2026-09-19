<script lang="ts">
	import { onMount, tick } from 'svelte';
	import {
		createPersona,
		deletePersona,
		getAgentDetail,
		getPersona,
		listAgentHistory,
		listAgentModels,
		listAgents,
		listPersonas,
		patchAgent,
		resetAgent,
		resetPersona,
		rollbackAgent,
		savePersona,
		testAgent,
		type AgentDetail,
		type AgentHistoryEntry,
		type AgentMeta,
		type AgentPatch,
		type Persona,
		type PersonaMeta
	} from '$lib/api.js';

	interface DraftState {
		role: string;
		model: string;
		deep_reasoning: boolean;
		prompt: string;
		voice_persona_slug: string | null;
		research_focus: string | null;
	}

	// Haiku is the one Claude family that rejects adaptive thinking (HTTP 400),
	// so the deep-reasoning toggle is disabled for it whether the slug is the
	// Anthropic id (claude-haiku-4-5) or the OpenRouter form
	// (anthropic/claude-haiku-4.5). Mirrors the backend guard in
	// providers.registry.model_supports_deep_reasoning.
	// Scoped to Claude names (current or legacy ordering), case-insensitive —
	// matches providers.registry.model_supports_deep_reasoning exactly.
	const HAIKU_MODEL_RE = /^(anthropic\/)?claude-.*haiku/i;

	function modelSupportsDeepReasoning(model: string): boolean {
		return !HAIKU_MODEL_RE.test(model);
	}

	function detailToDraft(d: AgentDetail): DraftState {
		return {
			role: d.role,
			model: d.model,
			// A stored override can pair deep_reasoning=true with a Haiku model
			// (older UI, direct API call). Mask it on load so the checkbox, the
			// dirty check and the Save patch all agree — saving then corrects the
			// persisted row instead of leaving it permanently out of sync.
			deep_reasoning: d.deep_reasoning && modelSupportsDeepReasoning(d.model),
			prompt: d.prompt,
			voice_persona_slug: d.voice_persona_slug ?? null,
			research_focus: d.research_focus ?? null
		};
	}

	function draftIsDirty(d: AgentDetail | null, draft: DraftState | null): boolean {
		if (!d || !draft) return false;
		return (
			d.role !== draft.role ||
			d.model !== draft.model ||
			d.deep_reasoning !== draft.deep_reasoning ||
			d.prompt !== draft.prompt ||
			(d.voice_persona_slug ?? null) !== draft.voice_persona_slug ||
			(d.research_focus ?? null) !== draft.research_focus
		);
	}

	let agents = $state.raw<AgentMeta[]>([]);
	let selected = $state<string | null>(null);
	let detail = $state.raw<AgentDetail | null>(null);
	let draft = $state<DraftState | null>(null);
	let models = $state.raw<string[]>([]);
	let history = $state.raw<AgentHistoryEntry[]>([]);
	let historyOpen = $state(false);

	let saving = $state(false);
	let resetting = $state(false);
	let error = $state<string | null>(null);

	let testQuery = $state('');
	let testResult = $state<string | null>(null);
	let testing = $state(false);
	let testError = $state<string | null>(null);

	// Voice persona state
	let personas = $state.raw<PersonaMeta[]>([]);
	let activePersonaDetail = $state.raw<Persona | null>(null);
	let personaBodyDraft = $state('');
	let personaDisplayNameDraft = $state('');
	let savingPersona = $state(false);
	let personaError = $state<string | null>(null);
	let newPersonaMode = $state(false);
	let newPersonaName = $state('');
	let newPersonaBody = $state('');

	// Slug whose Persona detail is currently loaded, so switching agents back and
	// forth does not refetch (upstream keyed its effect on `draft.voice_persona_slug`).
	let personaLoadedSlug: string | null = null;

	const dirty = $derived(draftIsDirty(detail, draft));

	// Model allowlist for the select: the current + default model always stay in
	// the list so the option exists before `listAgentModels` resolves.
	const modelOptions = $derived.by(() => {
		if (!detail || !draft) return [] as string[];
		const list: string[] = [];
		for (const m of [detail.model_default, draft.model, ...models]) {
			if (!list.includes(m)) list.push(m);
		}
		return list;
	});

	onMount(() => {
		void bootstrap();
	});

	async function bootstrap() {
		// Resolve the persona roster before the agent detail renders: its <select>
		// only ever lists personas, so an option arriving late would leave the
		// control showing the wrong selection.
		const personasPromise = listPersonas().catch(() => [] as PersonaMeta[]);
		await refreshAgents();
		personas = await personasPromise;
		const name = selected;
		if (name) {
			await loadDetail(name);
			void loadModels(name);
			void syncPersonaDetail();
		}
	}

	async function refreshAgents() {
		try {
			const list = await listAgents();
			agents = list;
			if (selected === null && list.length > 0) selected = list[0].name;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load agents';
		}
	}

	async function loadDetail(name: string) {
		error = null;
		try {
			const d = await getAgentDetail(name);
			detail = d;
			draft = detailToDraft(d);
			historyOpen = false;
			testResult = null;
			testError = null;
			// Switching away and back re-runs the upstream effect for the slug.
			if (name !== 'executive') personaLoadedSlug = null;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Failed to load agent';
		}
	}

	async function loadModels(name: string | null) {
		try {
			models = await listAgentModels(name ?? undefined);
		} catch {
			/* ignore */
		}
	}

	async function selectAgent(name: string) {
		selected = name;
		await loadDetail(name);
		void loadModels(name);
		void syncPersonaDetail();
	}

	async function syncPersonaDetail() {
		if (selected !== 'executive' || !draft) return;
		const slug = draft.voice_persona_slug ?? 'default';
		if (slug === personaLoadedSlug) return;
		personaLoadedSlug = slug;
		try {
			const p = await getPersona(slug);
			activePersonaDetail = p;
			personaBodyDraft = p.body;
			personaDisplayNameDraft = p.display_name;
			personaError = null;
		} catch {
			personaError = 'Failed to load persona';
		}
	}

	function patchDraft(patch: Partial<DraftState>) {
		if (draft) draft = { ...draft, ...patch };
	}

	function setPersonaSlug(slug: string | null) {
		patchDraft({ voice_persona_slug: slug });
	}

	function handleModelChange(model: string) {
		patchDraft({
			model,
			deep_reasoning: modelSupportsDeepReasoning(model) ? (draft?.deep_reasoning ?? false) : false
		});
	}

	function restoreDefaultPrompt() {
		const d = detail;
		if (d) patchDraft({ prompt: d.prompt_default });
	}

	function restoreDefaultResearchFocus() {
		const d = detail;
		if (d) patchDraft({ research_focus: d.research_focus_default });
	}

	async function handleSave() {
		const d = detail;
		const dr = draft;
		if (!d || !dr || !selected) return;
		saving = true;
		error = null;
		try {
			// Send only the fields that differ from the defaults OR differ from
			// the current effective value, so we don't write redundant overrides.
			const patch: AgentPatch = {};
			if (dr.role !== d.role) {
				patch.role = dr.role === d.role_default ? null : dr.role;
			}
			if (dr.model !== d.model) {
				patch.model = dr.model === d.model_default ? null : dr.model;
			}
			if (dr.deep_reasoning !== d.deep_reasoning) {
				patch.use_deep_reasoning =
					dr.deep_reasoning === d.deep_reasoning_default ? null : dr.deep_reasoning;
			}
			if (dr.prompt !== d.prompt) {
				patch.prompt = dr.prompt === d.prompt_default ? null : dr.prompt;
			}
			if ((dr.voice_persona_slug ?? null) !== (d.voice_persona_slug ?? null)) {
				patch.voice_persona_slug = dr.voice_persona_slug;
			}
			if ((dr.research_focus ?? null) !== (d.research_focus ?? null)) {
				// Sending the code default as null clears the override (back to default).
				patch.research_focus =
					dr.research_focus === (d.research_focus_default ?? null) ? null : dr.research_focus;
			}
			const updated = await patchAgent(selected, patch);
			detail = updated;
			draft = detailToDraft(updated);
			void refreshAgents();
			void syncPersonaDetail();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Save failed';
		} finally {
			saving = false;
		}
	}

	async function handleReset() {
		if (!selected) return;
		if (!window.confirm('Reset this agent to defaults? Current override will move to history.'))
			return;
		resetting = true;
		error = null;
		try {
			await resetAgent(selected);
			await loadDetail(selected);
			void refreshAgents();
			void syncPersonaDetail();
		} catch (err) {
			error = err instanceof Error ? err.message : 'Reset failed';
		} finally {
			resetting = false;
		}
	}

	async function handleRollback(historyId: number) {
		if (!selected) return;
		if (!window.confirm('Restore this earlier version?')) return;
		try {
			const updated = await rollbackAgent(selected, historyId);
			detail = updated;
			draft = detailToDraft(updated);
			void refreshAgents();
			void syncPersonaDetail();
			const fresh = await listAgentHistory(selected);
			history = fresh;
		} catch (err) {
			error = err instanceof Error ? err.message : 'Rollback failed';
		}
	}

	async function toggleHistory() {
		const next = !historyOpen;
		historyOpen = next;
		if (next && selected) {
			try {
				history = await listAgentHistory(selected);
			} catch {
				history = [];
			}
		}
	}

	async function handleTest() {
		const dr = draft;
		if (!selected || !dr || !testQuery.trim()) return;
		testing = true;
		testError = null;
		testResult = null;
		try {
			const result = await testAgent(selected, {
				query: testQuery,
				prompt: dr.prompt,
				model: dr.model,
				use_deep_reasoning: dr.deep_reasoning && modelSupportsDeepReasoning(dr.model)
			});
			testResult = result.response;
		} catch (err) {
			testError = err instanceof Error ? err.message : 'Test failed';
		} finally {
			testing = false;
		}
	}

	// ── Voice persona actions ─────────────────────────────────────────────────

	async function handleSavePersona() {
		const current = activePersonaDetail;
		if (!current) return;
		savingPersona = true;
		personaError = null;
		try {
			const updated = await savePersona(current.slug, personaDisplayNameDraft, personaBodyDraft);
			activePersonaDetail = updated;
			personas = await listPersonas();
		} catch (e) {
			personaError = e instanceof Error ? e.message : 'Save failed';
		} finally {
			savingPersona = false;
		}
	}

	async function handleResetPersona() {
		const current = activePersonaDetail;
		if (!current) return;
		try {
			const restored = await resetPersona(current.slug);
			activePersonaDetail = restored;
			personaBodyDraft = restored.body;
			personaDisplayNameDraft = restored.display_name;
			personas = await listPersonas();
		} catch (e) {
			personaError = e instanceof Error ? e.message : 'Reset failed';
		}
	}

	async function handleDuplicatePersona() {
		const current = activePersonaDetail;
		if (!current) return;
		try {
			const duped = await savePersona(
				current.slug + '-copy',
				current.display_name + ' (copy)',
				personaBodyDraft
			);
			personas = await listPersonas();
			// Let the new <option> land before re-pointing the select at it.
			await tick();
			setPersonaSlug(duped.slug);
			void syncPersonaDetail();
		} catch (e) {
			personaError = e instanceof Error ? e.message : 'Duplicate failed';
		}
	}

	async function handleDeletePersona() {
		const current = activePersonaDetail;
		if (!current) return;
		if (!window.confirm(`Delete persona "${current.display_name}"?`)) return;
		try {
			await deletePersona(current.slug);
			personas = await listPersonas();
			await tick();
			setPersonaSlug(null);
			void syncPersonaDetail();
		} catch (e) {
			personaError = e instanceof Error ? e.message : 'Delete failed';
		}
	}

	async function handleCreatePersona() {
		if (!newPersonaName.trim() || !newPersonaBody.trim()) return;
		try {
			const created = await createPersona(newPersonaName, newPersonaBody);
			personas = await listPersonas();
			await tick();
			setPersonaSlug(created.slug);
			void syncPersonaDetail();
			newPersonaMode = false;
		} catch (e) {
			personaError = e instanceof Error ? e.message : 'Create failed';
		}
	}
</script>

<div class="flex min-h-0 flex-1 overflow-hidden bg-surface text-fg">
	<aside class="flex w-64 shrink-0 flex-col border-r border-line bg-surface-elevated">
		<div class="overflow-y-auto px-3 py-4">
			<p class="mb-2 px-2 text-[10px] font-semibold tracking-widest text-fg-subtle uppercase">
				Agent Council
			</p>
			<nav class="space-y-0.5">
				{#each agents as a (a.name)}
					<button
						type="button"
						onclick={() => void selectAgent(a.name)}
						class={`flex w-full items-start gap-2 rounded-lg px-2 py-1.5 text-left text-xs transition-colors ${
							selected === a.name
								? 'bg-indigo-500/10 text-indigo-300'
								: 'text-fg-muted hover:bg-surface-overlay/60 hover:text-fg'
						}`}
					>
						<span
							class={`mt-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full ${
								a.has_override ? 'bg-amber-400' : 'bg-surface-input'
							}`}
							title={a.has_override ? 'Has override' : 'Default config'}
							aria-hidden="true"
						></span>
						<span class="min-w-0 flex-1">
							<span class="block text-[10px] font-medium tracking-wide text-fg uppercase"
								>{a.name}</span
							>
							<span class="block truncate text-fg-muted">{a.role}</span>
						</span>
					</button>
				{/each}
			</nav>
		</div>
	</aside>

	<main class="flex-1 overflow-y-auto">
		<div class="mx-auto max-w-4xl space-y-6 px-8 py-10">
			<div>
				<h1 class="text-2xl font-bold text-fg">Agent Council</h1>
				<p class="mt-2 text-sm text-fg-muted">
					Edit each specialist&apos;s prompt, model, and behavior. Changes apply on the next
					specialist call — no restart needed. Resetting restores the built-in defaults.
				</p>
			</div>

			{#if error}
				<div
					class="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300"
					role="alert"
				>
					{error}
				</div>
			{/if}

			{#if detail && draft}
				{@const agent = detail}
				<div class="space-y-6">
					<div class="space-y-4 rounded-xl border border-line bg-surface px-6 py-5">
						<div class="flex items-center justify-between">
							<div>
								<h2 class="text-lg font-semibold text-fg">{agent.role}</h2>
								<p class="mt-0.5 font-mono text-xs text-fg-muted">
									{agent.name}{agent.name === 'executive'
										? ' · orchestrator'
										: agent.name === 'utility_fast'
											? ' · utility model knob'
											: agent.name === 'research'
												? ' · research model knob'
												: ` · domains: ${agent.domains.join(', ') || '—'}`}
								</p>
							</div>
							<div class="flex items-center gap-2">
								{#if agent.has_override}
									<span
										class="rounded border border-amber-500/20 bg-amber-500/10 px-2 py-1 text-[10px] tracking-widest text-amber-400 uppercase"
									>
										Customized
									</span>
								{/if}
								<button
									type="button"
									onclick={() => void handleReset()}
									disabled={resetting || !agent.has_override}
									class="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-red-500/40 hover:text-red-400 disabled:cursor-not-allowed disabled:opacity-40"
								>
									Reset to default
								</button>
								<button
									type="button"
									onclick={() => void handleSave()}
									disabled={saving || !dirty}
									class="rounded-lg border border-indigo-500/30 bg-indigo-500/20 px-3 py-1.5 text-xs text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-40"
								>
									{saving ? 'Saving…' : 'Save'}
								</button>
							</div>
						</div>

						<div class="grid grid-cols-1 gap-4 md:grid-cols-2">
							<label class="block text-xs">
								<span class="text-[10px] font-semibold tracking-widest text-fg-muted uppercase">
									Role
								</span>
								<input
									type="text"
									value={draft.role}
									oninput={(e) => patchDraft({ role: e.currentTarget.value })}
									class="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus:border-indigo-500/40 focus:outline-none"
								/>
								{#if agent.role_default !== draft.role}
									<span class="mt-1 block text-[10px] text-fg-subtle">
										Default: {agent.role_default}
									</span>
								{/if}
							</label>

							<label class="block text-xs">
								<span class="text-[10px] font-semibold tracking-widest text-fg-muted uppercase">
									Model
								</span>
								<select
									value={draft.model}
									onchange={(e) => handleModelChange(e.currentTarget.value)}
									class="mt-1 w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus:border-indigo-500/40 focus:outline-none"
								>
									{#each modelOptions as m (m)}
										<option value={m}>
											{m}{m === agent.model_default ? ' (default)' : ''}
										</option>
									{/each}
								</select>
							</label>
						</div>

						{#if agent.name !== 'utility_fast'}
							<label
								class={`flex items-center gap-2 text-xs text-fg-muted ${
									modelSupportsDeepReasoning(draft.model) ? '' : 'opacity-60'
								}`}
								title={modelSupportsDeepReasoning(draft.model)
									? "Adaptive thinking on Claude Opus/Sonnet, and on any OpenRouter model whose catalog entry supports reasoning. Ignored by models that can't reason."
									: "Haiku doesn't support adaptive thinking — pick another model to enable deep reasoning."}
							>
								<input
									type="checkbox"
									checked={draft.deep_reasoning && modelSupportsDeepReasoning(draft.model)}
									disabled={!modelSupportsDeepReasoning(draft.model)}
									onchange={(e) => patchDraft({ deep_reasoning: e.currentTarget.checked })}
									class="rounded border-line-strong bg-surface disabled:cursor-not-allowed"
								/>
								Deep reasoning (adaptive thinking — Claude Opus/Sonnet and reasoning-capable OpenRouter
								models; not available on Haiku)
								<span class="text-[10px] text-fg-subtle">
									default: {agent.deep_reasoning_default ? 'on' : 'off'}
								</span>
							</label>
						{/if}

						{#if agent.name === 'utility_fast'}
							<p class="text-xs leading-relaxed text-fg-muted">
								This model is used for fast, non-specialist calls: the Discord response gate,
								Discord thread title generation, parsing human approval replies (Slack/email), and
								disambiguating inbound messages when multiple awaiting_human runs exist. Changing it
								has no effect on specialist answers — just on these lightweight classification
								tasks.
							</p>
						{:else if agent.name === 'research'}
							<p class="text-xs leading-relaxed text-fg-muted">
								This model + deep-reasoning setting drives the executive_research specialist fan-out
								(the periodic research scan and the manual “what should we look into?” run). It
								applies to all specialists&rsquo; research turns at once and is independent of their
								chat models — lowering it cuts research cost without touching chat quality.
								Per-domain research focus is edited under each specialist below.
							</p>
						{:else}
							<div>
								<div class="mb-1 flex items-center justify-between">
									<span class="text-[10px] font-semibold tracking-widest text-fg-muted uppercase">
										System prompt
									</span>
									<span class="text-[10px] text-fg-subtle">
										{draft.prompt.length} chars
									</span>
								</div>
								<textarea
									value={draft.prompt}
									oninput={(e) => patchDraft({ prompt: e.currentTarget.value })}
									rows={20}
									aria-label="System prompt"
									class="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-fg focus:border-indigo-500/40 focus:outline-none"
								></textarea>
								{#if draft.prompt !== agent.prompt_default}
									<button
										type="button"
										onclick={restoreDefaultPrompt}
										class="mt-2 text-[10px] text-fg-muted underline hover:text-fg"
									>
										Restore default prompt in editor
									</button>
								{/if}
							</div>
						{/if}

						<!-- Research focus — specialists only (those with a default scope) -->
						{#if agent.research_focus_default !== null}
							<div>
								<div class="mb-1 flex items-center justify-between">
									<span class="text-[10px] font-semibold tracking-widest text-fg-muted uppercase">
										Research focus
									</span>
									<span class="text-[10px] text-fg-subtle">
										{(draft.research_focus ?? '').length} chars
									</span>
								</div>
								<p class="mb-1 text-[10px] leading-relaxed text-fg-subtle">
									The domain-scope block appended to this specialist&apos;s research turn — what
									external signals it watches. The shared research contract (output format, recency
									/ grounding / actionability bars) is fixed and not editable here.
								</p>
								<textarea
									value={draft.research_focus ?? ''}
									oninput={(e) => patchDraft({ research_focus: e.currentTarget.value })}
									rows={10}
									aria-label="Research focus"
									class="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-fg focus:border-indigo-500/40 focus:outline-none"
								></textarea>
								{#if draft.research_focus !== agent.research_focus_default}
									<button
										type="button"
										onclick={restoreDefaultResearchFocus}
										class="mt-2 text-[10px] text-fg-muted underline hover:text-fg"
									>
										Restore default research focus in editor
									</button>
								{/if}
							</div>
						{/if}
					</div>

					<!-- Voice Persona card — Executive only -->
					{#if agent.name === 'executive'}
						<div class="space-y-4 rounded-xl border border-line bg-surface px-6 py-5">
							<div class="flex items-center justify-between">
								<div>
									<h3 class="text-sm font-semibold text-fg">Voice Persona</h3>
									<p class="mt-0.5 text-xs text-fg-muted">
										Sets the Executive&apos;s tone and communication style. The structural prompt
										stays intact.
									</p>
								</div>
								<button
									type="button"
									onclick={() => {
										newPersonaMode = true;
										newPersonaName = '';
										newPersonaBody = '';
									}}
									class="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-indigo-500/40 hover:text-indigo-300"
								>
									+ New
								</button>
							</div>

							{#if personaError}
								<p class="text-xs text-red-400" role="alert">{personaError}</p>
							{/if}

							<!-- Persona selector -->
							<div>
								<label
									class="mb-1 block text-[10px] font-semibold tracking-widest text-fg-muted uppercase"
									for="persona-select"
								>
									Active persona
								</label>
								<select
									id="persona-select"
									value={draft.voice_persona_slug ?? 'default'}
									onchange={(e) => {
										const value = e.currentTarget.value;
										setPersonaSlug(value === 'default' ? null : value);
										void syncPersonaDetail();
									}}
									class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus:border-indigo-500/40 focus:outline-none"
								>
									{#each personas as p (p.slug)}
										<option value={p.slug}>
											{p.display_name}{p.is_builtin && !p.is_customized
												? ' · built-in'
												: ''}{p.is_customized ? ' · customized' : ''}{!p.is_builtin
												? ' · custom'
												: ''}
										</option>
									{/each}
								</select>
								<p class="mt-1 text-[10px] text-fg-subtle">
									Selection saves with the main Save button above.
								</p>
							</div>

							<!-- Persona body editor -->
							{#if activePersonaDetail}
								{@const persona = activePersonaDetail}
								<div class="space-y-2">
									<div class="flex items-center justify-between">
										<span class="text-[10px] font-semibold tracking-widest text-fg-muted uppercase">
											Persona body
										</span>
										<div class="flex items-center gap-2">
											{#if persona.source_notes}
												<span
													class="max-w-48 truncate text-[10px] text-fg-subtle italic"
													title={persona.source_notes}
												>
													{persona.source_notes}
												</span>
											{/if}
										</div>
									</div>
									<input
										type="text"
										value={personaDisplayNameDraft}
										oninput={(e) => (personaDisplayNameDraft = e.currentTarget.value)}
										placeholder="Display name"
										aria-label="Display name"
										class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus:border-indigo-500/40 focus:outline-none"
									/>
									<textarea
										value={personaBodyDraft}
										oninput={(e) => (personaBodyDraft = e.currentTarget.value)}
										rows={12}
										aria-label="Persona body"
										class="w-full resize-y rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-fg focus:border-indigo-500/40 focus:outline-none"
									></textarea>
									<div class="flex flex-wrap items-center gap-2">
										<button
											type="button"
											onclick={() => void handleSavePersona()}
											disabled={savingPersona || !personaBodyDraft.trim()}
											class="rounded-lg border border-indigo-500/30 bg-indigo-500/20 px-3 py-1.5 text-xs text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-40"
										>
											{savingPersona ? 'Saving…' : 'Save persona'}
										</button>
										{#if persona.is_builtin && persona.is_customized}
											<button
												type="button"
												onclick={() => void handleResetPersona()}
												class="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-amber-500/40 hover:text-amber-400"
											>
												Reset to built-in
											</button>
										{/if}
										<button
											type="button"
											onclick={() => void handleDuplicatePersona()}
											class="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-fg-muted transition-colors hover:border-fg-muted hover:text-fg"
										>
											Duplicate
										</button>
										{#if !persona.is_builtin}
											<button
												type="button"
												onclick={() => void handleDeletePersona()}
												class="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-red-400 transition-colors hover:border-red-500/40 hover:bg-red-500/10"
											>
												Delete
											</button>
										{/if}
									</div>
								</div>
							{/if}

							<!-- New persona inline form -->
							{#if newPersonaMode}
								<div class="mt-2 space-y-3 rounded-lg border border-line-strong bg-surface p-4">
									<p class="text-xs font-semibold text-fg">New persona</p>
									<input
										type="text"
										value={newPersonaName}
										oninput={(e) => (newPersonaName = e.currentTarget.value)}
										placeholder="Display name (e.g. Elon Musk)"
										aria-label="New persona display name"
										class="w-full rounded-lg border border-line-strong bg-surface-elevated px-3 py-2 text-sm text-fg focus:border-indigo-500/40 focus:outline-none"
									/>
									<textarea
										value={newPersonaBody}
										oninput={(e) => (newPersonaBody = e.currentTarget.value)}
										rows={6}
										placeholder="Voice and style bullets — e.g. '- Direct and engineering-first...'"
										aria-label="New persona body"
										class="w-full resize-y rounded-lg border border-line-strong bg-surface-elevated px-3 py-2 font-mono text-xs text-fg focus:border-indigo-500/40 focus:outline-none"
									></textarea>
									<div class="flex gap-2">
										<button
											type="button"
											onclick={() => void handleCreatePersona()}
											disabled={!newPersonaName.trim() || !newPersonaBody.trim()}
											class="rounded-lg border border-indigo-500/30 bg-indigo-500/20 px-3 py-1.5 text-xs text-indigo-300 transition-colors hover:bg-indigo-500/30 disabled:cursor-not-allowed disabled:opacity-40"
										>
											Create
										</button>
										<button
											type="button"
											onclick={() => (newPersonaMode = false)}
											class="rounded-lg border border-line-strong px-3 py-1.5 text-xs text-fg-muted transition-colors hover:text-fg"
										>
											Cancel
										</button>
									</div>
								</div>
							{/if}
						</div>
					{/if}

					{#if agent.name !== 'utility_fast'}
						<div class="space-y-3 rounded-xl border border-line bg-surface px-6 py-5">
							<div>
								<h3 class="text-sm font-semibold text-fg">Test this draft</h3>
								<p class="mt-0.5 text-xs text-fg-muted">
									Run a one-off query with the unsaved settings above. Nothing is persisted.
								</p>
							</div>
							<textarea
								value={testQuery}
								oninput={(e) => (testQuery = e.currentTarget.value)}
								rows={3}
								placeholder="Ask the specialist something…"
								aria-label="Test query"
								class="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-fg focus:border-indigo-500/40 focus:outline-none"
							></textarea>
							<div class="flex items-center gap-2">
								<button
									type="button"
									onclick={() => void handleTest()}
									disabled={testing || !testQuery.trim()}
									class="rounded-lg border border-violet-500/30 bg-violet-500/20 px-3 py-1.5 text-xs text-violet-300 transition-colors hover:bg-violet-500/30 disabled:cursor-not-allowed disabled:opacity-40"
								>
									{testing ? 'Running…' : 'Run test'}
								</button>
								{#if testError}
									<span class="text-xs text-red-400" role="alert">{testError}</span>
								{/if}
							</div>
							{#if testResult !== null}
								<div
									class="rounded-lg border border-line bg-surface px-4 py-3 text-sm whitespace-pre-wrap text-fg"
								>
									{testResult}
								</div>
							{/if}
						</div>
					{/if}

					<div class="rounded-xl border border-line bg-surface px-6 py-5">
						<button
							type="button"
							onclick={() => void toggleHistory()}
							class="flex w-full items-center justify-between text-sm font-semibold text-fg"
						>
							<span>Version history</span>
							<span class="text-xs text-fg-muted">{historyOpen ? 'Hide' : 'Show'}</span>
						</button>
						{#if historyOpen}
							<div class="mt-3 max-h-80 space-y-2 overflow-y-auto">
								{#if history.length === 0}
									<p class="text-xs text-fg-subtle">No prior versions for this agent.</p>
								{/if}
								{#each history as h (h.id)}
									<div
										class="flex items-center justify-between rounded-lg border border-line px-3 py-2 text-xs text-fg-muted"
									>
										<div class="min-w-0">
											<p class="font-mono text-[10px] text-fg-subtle">#{h.id} · {h.created_at}</p>
											<p class="mt-0.5 truncate text-fg-muted">
												{[
													h.model && `model=${h.model}`,
													h.use_deep_reasoning !== null &&
														`deep=${h.use_deep_reasoning ? 'on' : 'off'}`,
													h.role && `role=${h.role}`,
													h.prompt && `prompt=${h.prompt.slice(0, 60)}…`
												]
													.filter(Boolean)
													.join(' · ') || '(empty override)'}
											</p>
										</div>
										<button
											type="button"
											onclick={() => void handleRollback(h.id)}
											class="shrink-0 rounded border border-line-strong px-2 py-1 text-[10px] text-fg hover:bg-surface-overlay hover:text-fg"
										>
											Restore
										</button>
									</div>
								{/each}
							</div>
						{/if}
					</div>
				</div>
			{:else}
				<p class="text-sm text-fg-muted">Select an agent to edit.</p>
			{/if}
		</div>
	</main>
</div>

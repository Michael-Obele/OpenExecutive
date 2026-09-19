<script lang="ts">
	// Ported from the `ProposalCard` sub-component in
	// `packages/ui/src/components/Briefing.tsx`. It lives in its own file rather
	// than as a `{#snippet}` inside `Briefing.svelte` because it owns local state
	// (the edit-mode draft and the long-body expander) and a snippet body cannot
	// declare `$state`.
	import Markdown from '$lib/components/Markdown.svelte';
	import type { PersonBriefItem, ProposalItem } from '$lib/api.js';
	import {
		DOT_SEP,
		LONG_BODY_CHARS,
		ageLabel,
		buildMonitoringSeed,
		daysUntil
	} from './briefing.js';

	interface Props {
		proposal: ProposalItem;
		people: PersonBriefItem[];
		onContinue?: (prompt: string) => void;
		onApprove?: (proposal: ProposalItem) => void;
		onDismiss?: (proposal: ProposalItem) => void;
		onApproveWithEdits?: (proposal: ProposalItem, editedBody: string) => void;
		busy?: boolean;
		// Start the long-body expander open (no clamp) — used by the elevated
		// "Start here" card so its body shows in full without a click.
		defaultBodyExpanded?: boolean;
		// Adds a left indigo accent to the flattened row — used for the
		// "Start here" proposal so the single sharpest item stands out without
		// breaking the divider-row rhythm.
		emphasized?: boolean;
	}

	let {
		proposal,
		people,
		onContinue,
		onApprove,
		onDismiss,
		onApproveWithEdits,
		busy = false,
		defaultBodyExpanded = false,
		emphasized = false
	}: Props = $props();

	// Local edit-mode state. Entering edit mode replaces the body display
	// with a textarea pre-filled with the proposal body; the action row
	// simplifies to Cancel / Send approval. Exiting (Cancel) restores the
	// normal layout without acking anything. Send approval pipes the
	// edited text up through onApproveWithEdits so Briefing can ack the
	// alert + seed the chat with a verbatim-send instruction.
	let editing = $state(false);
	let editedBody = $state('');
	// Body expand/collapse for long action bodies (see isLongBody below). The
	// elevated "Start here" card opts out of clamping via defaultBodyExpanded.
	// svelte-ignore state_referenced_locally
	let bodyOpen = $state(defaultBodyExpanded);

	function startEditing() {
		editedBody = proposal.body || proposal.headline;
		editing = true;
	}
	function cancelEditing() {
		editing = false;
		editedBody = '';
	}
	function submitEdit() {
		if (!onApproveWithEdits) return;
		const text = editedBody.trim();
		if (!text) return;
		onApproveWithEdits(proposal, text);
	}

	const assignee = $derived(
		proposal.routed_to_person_id != null
			? (people.find((p) => p.id === proposal.routed_to_person_id) ?? null)
			: null
	);
	// Research artifacts (the Executive's `draft_artifact` tool) are full
	// authored documents, not terse proposals. The `artifact` topic tag is
	// the discriminator (mirrors the `external:*` tag convention). They get
	// a document layout: title heading + Markdown body + a "why this is
	// worth your time" block, and a review-not-approve action set.
	const isArtifact = $derived(proposal.topic_tags?.includes('artifact') ?? false);
	// Show the full body whenever the backend supplies it; fall back to
	// headline for older payloads that didn't carry body. Visible card
	// text wraps naturally and we no longer truncate mid-word.
	const displayText = $derived(proposal.body || proposal.headline);
	// Monitoring items are passive external/watchlist signals — there's nothing
	// to approve, so the card reframes the body as a "why it's on your radar"
	// rationale and drops the suggested-action ("If you approve:") block.
	const isMonitoring = $derived(proposal.category === 'monitoring');
	// Decision-backed proposals (gated calendar bookings) execute server-side via
	// the /decisions endpoints — Approve books the meeting, Dismiss rejects it.
	// The verbatim-DM "Edit & approve" flow doesn't map to a calendar booking, so
	// it's hidden for these cards.
	const isDecision = $derived(proposal.decision_instance_id != null);
	// Long free-text action bodies are the briefing's other "wall of text".
	// Clamp them to a few lines at rest, with a Show more/less toggle, so the
	// "Needs you" queue stays scannable. Monitoring (bounded rationale) and
	// artifacts (their own scroll region) keep their existing treatment.
	const isLongBody = $derived(!isMonitoring && !isArtifact && displayText.length > LONG_BODY_CHARS);

	// Chat handoff prompt — seed the Executive with the FULL body PLUS
	// the suggested_action so it has the entire card's worth of context
	// (the "Reply to X: confirm Y..." instructions live in suggested_action
	// and previously got dropped on Discuss → the model would have to ask
	// the user to re-supply them).
	//
	// We also include a Discuss-mode primer telling the exec: stay
	// conversational until the user explicitly approves, then execute +
	// call ack_alert with the alert_id below. alert_id is needed so the
	// exec can clear the card from the briefing once approval lands.
	const handoffPrompt = $derived.by(() => {
		if (isArtifact) {
			// Artifacts aren't approved/executed — they're read. Seed the chat
			// with the full document + rationale so the Executive can discuss
			// it, and let it clear the card via ack_alert when the user is done.
			const rationale = proposal.suggested_action
				? `\n\nWhy you flagged it: ${proposal.suggested_action}`
				: '';
			return (
				`Let's discuss this artifact you flagged for my review:\n\n` +
				`# ${proposal.headline}\n\n${proposal.body || ''}${rationale}\n\n` +
				`[Discuss mode — alert_id=${proposal.alert_id}] This is a document ` +
				`for review, not an action to approve. Answer my questions about it ` +
				`conversationally. When I say I'm done ("got it", "reviewed", "thanks"), ` +
				`call ack_alert(alert_id=${proposal.alert_id}, status="ack") to clear ` +
				`it from my queue. Take no other action.`
			);
		}
		if (isMonitoring) {
			// Monitoring signals are passive — there's nothing to approve, so the
			// Discuss handoff asks the Executive to interpret the signal rather than
			// framing it as an approvable proposal. Dismiss is still available via
			// the card button (which acks "dismissed").
			return buildMonitoringSeed(proposal);
		}
		if (isDecision) {
			// Gated calendar booking. Approval/rejection happens via the card's
			// Approve/Dismiss buttons (which call the /decisions endpoints and book
			// or cancel the event server-side) — NOT via chat. So the Discuss
			// handoff is read-only: help the user decide, but take no action and do
			// not ack/approve from chat.
			const body = proposal.body || proposal.headline;
			return (
				`Let's talk through this meeting I've proposed:\n\n${body}\n\n` +
				`[Discuss mode] This booking is awaiting your approval on the ` +
				`briefing. Help me decide whether the time, attendees, and purpose ` +
				`make sense. Do NOT book, cancel, or ack anything from chat — I'll ` +
				`approve or dismiss it from the card itself.`
			);
		}
		const text = proposal.body || proposal.headline;
		const suggested = proposal.suggested_action
			? `\n\nIf I approve, you will:\n${proposal.suggested_action}`
			: '';
		const primer =
			`\n\n[Discuss mode — alert_id=${proposal.alert_id}] ` +
			`This proposal is NOT YET approved. Answer my questions conversationally. ` +
			`When I explicitly approve ("ok", "approve", "go ahead", "do it"), switch to ` +
			`execute mode: actually attempt the work (use web_search and your other tools — ` +
			`don't just promise), reply inline with the deliverable, schedule a fresh ` +
			`follow-up via schedule_followup if it's time-bound, and call ` +
			`ack_alert(alert_id=${proposal.alert_id}, status="ack"). ` +
			`If I dismiss it ("never mind", "drop it"), call ` +
			`ack_alert(alert_id=${proposal.alert_id}, status="dismissed") and stop. ` +
			`Until explicit approval/dismissal, take no action and do not ack.`;
		return `Tell me about this proposal:\n\n${text}${suggested}${primer}`;
	});

	// Suggested-action block: visually promoted so the user reads it as a
	// commitment ("if I approve, the exec will do THIS") rather than a
	// footnote. Renders only when suggested_action is non-empty — and never
	// for monitoring items, where there's nothing to approve (the body is
	// reframed as a rationale in the content area instead).
	const showSuggestedAction = $derived(!isMonitoring && Boolean(proposal.suggested_action));

	// The `artifact` tag is an internal UI discriminator (it drives the
	// document layout + amber badge), not a user-meaningful topic — hide it
	// from the tag pills so it doesn't double up with the "Artifact" badge.
	const visibleTags = $derived(proposal.topic_tags.filter((t) => t !== 'artifact'));

	// Lifecycle signals from the Executive's review (alerts/review.py) and the
	// coalescing pipeline: the one-line "what changed since you last looked",
	// then chips — age, seen ×N, why-now / deadline, likely-stale, folded-in,
	// updated — and a muted "Reviewed <ago>" footer.
	const verdict = $derived(proposal.review_verdict ?? '');
	const isLikelyStale = $derived((proposal.review_verdict ?? '') === 'likely_stale');
	const lifecycleChips = $derived.by(() => {
		const chips: { label: string; cls: string; title?: string | undefined }[] = [];
		const age = ageLabel(proposal.created_at);
		const dueIn = daysUntil(proposal.due_at);
		if (age)
			chips.push({
				label: age,
				cls: 'text-fg-subtle border-line',
				title: `Raised ${new Date(proposal.created_at).toLocaleString()}`
			});
		if ((proposal.occurrence_count ?? 1) > 1)
			chips.push({
				label: `seen ×${proposal.occurrence_count}`,
				cls: 'text-fg-muted border-line',
				title: proposal.last_seen_at
					? `Last seen ${ageLabel(proposal.last_seen_at)} ago`
					: undefined
			});
		if (proposal.why_now || dueIn != null) {
			const due =
				dueIn == null ? '' : dueIn < 0 ? 'overdue' : dueIn === 0 ? 'due today' : `due in ${dueIn}d`;
			chips.push({
				label: [proposal.why_now, due].filter(Boolean).join(DOT_SEP),
				cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30'
			});
		}
		if (isLikelyStale && !proposal.review_note)
			chips.push({
				label: 'Likely stale',
				cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30'
			});
		if ((proposal.superseded_count ?? 0) > 0)
			chips.push({
				label: `${proposal.superseded_count} folded in`,
				cls: 'text-fg-muted border-line'
			});
		if (verdict === 'changed' && !proposal.review_note)
			chips.push({ label: 'Updated by the Executive', cls: 'text-sky-300 border-sky-500/30' });
		if (verdict === 'drafted')
			chips.push({
				label: 'Draft ready in your queue',
				cls: 'bg-amber-500/15 text-amber-300 border-amber-500/30'
			});
		return chips;
	});
	const reviewedLabel = $derived(
		proposal.last_reviewed_at
			? `Reviewed ${ageLabel(proposal.last_reviewed_at)} ago${
					verdict && verdict !== 'likely_stale' ? `${DOT_SEP}${verdict}` : ''
				}`
			: ''
	);

	// The single recommended move, as the primary control on the card. Route /
	// escalate / draft already happened server-side (the card shows their
	// trace); nudge and a suggested workflow are the two the user completes.
	const move = $derived(proposal.recommended_move ?? '');
	const showActions = $derived(Boolean(onApprove || onDismiss || onApproveWithEdits));
	// Left indigo accent for the "Start here" row (replaces the old ring on the
	// wrapper); applied to the flat row container in every render variant.
	const rowAccent = $derived(emphasized ? ' border-l-2 border-indigo-500 pl-3' : '');

	// Upstream spread the `prose` typography classes onto this bounded scroll
	// region; `Markdown.svelte` supplies `prose max-w-none` itself, so only the
	// modifiers are passed through.
	const ARTIFACT_BODY_CLASS =
		'mt-2 max-h-72 overflow-y-auto rounded-lg border border-line bg-surface/40 px-3 py-2 ' +
		'prose-invert prose-sm text-xs text-fg-muted leading-relaxed [&_*]:break-words';
</script>

{#snippet suggestedActionBlock()}
	{#if showSuggestedAction}
		<div class="mb-2 rounded-lg border border-indigo-500/30 bg-indigo-500/5 px-3 py-2">
			<div class="mb-1 text-[10px] tracking-wide text-indigo-300 uppercase">
				{isArtifact ? 'Why this is worth your time:' : 'If you approve:'}
			</div>
			<p class="text-xs leading-snug break-words whitespace-pre-wrap text-fg">
				{proposal.suggested_action}
			</p>
		</div>
	{/if}
{/snippet}

{#snippet assigneeBadge()}
	{#if assignee}
		{@const person = assignee}
		{#if onContinue}
			<span class="shrink-0 text-xs text-indigo-300">{`→ ${person.full_name}`}</span>
		{:else}
			<a
				href={`/people/${person.id}`}
				class="shrink-0 text-xs text-indigo-300 hover:underline"
				onclick={(e) => e.stopPropagation()}
			>
				{`→ ${person.full_name}`}
			</a>
		{/if}
	{/if}
{/snippet}

{#snippet cardMeta()}
	{#if proposal.review_note}
		<p class={`mb-1.5 text-xs leading-snug ${isLikelyStale ? 'text-amber-300' : 'text-fg-muted'}`}>
			<span class="mr-1 text-[10px] tracking-wide uppercase">
				{isLikelyStale
					? 'Likely stale'
					: verdict === 'changed'
						? 'Updated'
						: 'Since you last looked'}
			</span>
			{proposal.review_note}
		</p>
	{/if}
	{#if lifecycleChips.length > 0}
		<div class="mb-1.5 flex flex-wrap gap-1">
			{#each lifecycleChips as chip (chip.label)}
				<span
					title={chip.title}
					class={`inline-block rounded border px-1.5 py-0.5 text-[10px] ${chip.cls}`}
				>
					{chip.label}
				</span>
			{/each}
		</div>
	{/if}
	{@render suggestedActionBlock()}
	{#if proposal.surfaced_reason}
		<p class="text-[10px] leading-snug text-fg-muted">{proposal.surfaced_reason}</p>
	{/if}
	{#if visibleTags.length > 0}
		<div class="flex flex-wrap gap-1">
			{#each visibleTags as tag (tag)}
				{@const isExternal = tag.startsWith('external:')}
				<span
					class={isExternal
						? 'inline-block rounded border border-sky-500/30 bg-sky-500/20 px-1.5 py-0.5 text-[10px] font-medium text-sky-300'
						: 'inline-block rounded border border-line px-1.5 py-0.5 text-[10px] text-fg-muted'}
				>
					{tag}
				</span>
			{/each}
		</div>
	{/if}
	{#if reviewedLabel}
		<p class="mt-1 text-[10px] text-fg-subtle">{reviewedLabel}</p>
	{/if}
{/snippet}

{#snippet cardContent()}
	{#if isArtifact}
		<div class="mb-1 flex items-start justify-between gap-2">
			<div class="flex min-w-0 items-center gap-2">
				<span
					class="shrink-0 rounded border border-amber-500/30 bg-amber-500/15 px-1.5 py-0.5 text-[10px] tracking-wide text-amber-300 uppercase"
				>
					Artifact
				</span>
				<div class="text-sm font-medium break-words text-fg">{proposal.headline}</div>
			</div>
			{@render assigneeBadge()}
		</div>
		{@render cardMeta()}
		<!-- Full authored document, rendered as Markdown in a bounded,
		     scrollable region so a long brief can't blow out the card. -->
		<Markdown source={displayText} class={ARTIFACT_BODY_CLASS} />
	{:else}
		<div class="mb-2 flex items-start justify-between gap-2">
			<div class="min-w-0">
				{#if isMonitoring}
					<!-- Terse description first (headline), then the rationale the
					     triage body carries — only when it adds something beyond the
					     headline, so we don't render the same text twice. -->
					<div class="text-sm font-medium break-words whitespace-pre-wrap text-fg">
						{proposal.headline}
					</div>
					{#if proposal.body && proposal.body !== proposal.headline}
						<div class="mt-2 mb-1 text-[10px] tracking-wide text-sky-300 uppercase">
							Why this is on your radar
						</div>
						<div class="text-xs break-words whitespace-pre-wrap text-fg-muted">
							{proposal.body}
						</div>
					{/if}
				{:else}
					<div
						class={`text-sm font-medium break-words whitespace-pre-wrap text-fg${isLongBody && !bodyOpen ? ' line-clamp-3' : ''}`}
						title={isLongBody && !bodyOpen ? displayText : undefined}
					>
						{displayText}
					</div>
				{/if}
			</div>
			{@render assigneeBadge()}
		</div>
		{@render cardMeta()}
	{/if}
{/snippet}

{#if editing}
	<div class={`group py-3 transition-colors hover:bg-surface-overlay/30${rowAccent}`}>
		<div class="mb-2 flex items-start justify-between gap-2">
			<span class="text-[10px] tracking-wide text-fg-subtle uppercase">
				Editing proposal — send verbatim
			</span>
			{#if assignee}
				<span class="shrink-0 text-xs text-indigo-300">{`→ ${assignee.full_name}`}</span>
			{/if}
		</div>
		<!-- Show what the exec will do on approval so the user sees what
		     they're authorizing while editing the message body. -->
		{@render suggestedActionBlock()}
		<!-- svelte-ignore a11y_autofocus -->
		<textarea
			autofocus
			value={editedBody}
			oninput={(e) => (editedBody = e.currentTarget.value)}
			rows={6}
			disabled={busy}
			class="w-full rounded-lg border border-line bg-surface p-3 text-sm leading-snug font-normal whitespace-pre-wrap text-fg focus:ring-1 focus:ring-indigo-500/40 focus:outline-none disabled:opacity-50"
		></textarea>
		<div class="mt-2 flex justify-end gap-2">
			<button
				type="button"
				onclick={cancelEditing}
				disabled={busy}
				class="cursor-pointer rounded px-2 py-1 text-xs text-fg-muted transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-50"
			>
				Cancel
			</button>
			<button
				type="button"
				onclick={submitEdit}
				disabled={busy || !editedBody.trim()}
				class="cursor-pointer rounded px-2 py-1 text-xs font-medium text-emerald-300 transition-colors hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
			>
				✓ Send approval
			</button>
		</div>
	</div>
{:else}
	<!-- Card splits into a content area and an action row living as siblings
	     inside a wrapper div so the explicit buttons don't nest inside the
	     outer click target (HTML disallows interactive-inside-interactive). -->
	<div
		id={`alert-${proposal.alert_id}`}
		class={`group py-3 transition-colors hover:bg-surface-overlay/30${rowAccent}`}
	>
		{#if onContinue}
			<button
				type="button"
				onclick={() => onContinue?.(handoffPrompt)}
				class="block w-full cursor-pointer text-left transition-colors"
			>
				{@render cardContent()}
			</button>
		{:else}
			<div>{@render cardContent()}</div>
		{/if}
		<!-- Body expander — a sibling of the content area (never nested inside the
		     Discuss click target, which HTML disallows) so a clamped long body can
		     still be read in full without leaving the briefing. -->
		{#if isLongBody}
			<button
				type="button"
				onclick={() => (bodyOpen = !bodyOpen)}
				aria-expanded={bodyOpen}
				class="-mt-1 cursor-pointer rounded pb-2 text-[11px] text-fg-muted transition-colors hover:text-fg focus:ring-1 focus:ring-indigo-500/40 focus:outline-none"
			>
				{bodyOpen ? 'Show less' : 'Show more'}
			</button>
		{/if}
		{#if showActions}
			<div class="mt-2 flex items-center justify-between gap-2">
				<!-- Discuss on the left — same handoff the body tap fires, but
				     explicit so the affordance is discoverable. Hidden on the
				     standalone /today route (no onContinue). -->
				<div class="flex items-center gap-2">
					{#if move === 'nudge' && onContinue}
						<button
							type="button"
							onclick={() =>
								onContinue?.(
									`Nudge ${assignee?.full_name ?? 'the owner'} about this item — it has gone quiet: ${proposal.headline}\n\n` +
										`Send a short, friendly check-in via message_person and tell me what you sent.`
								)}
							disabled={busy}
							class="cursor-pointer rounded border border-indigo-500/30 px-2 py-1 text-xs font-medium text-indigo-300 transition-colors hover:text-indigo-200 disabled:opacity-50"
						>
							{`↪ Nudge ${assignee?.full_name?.split(' ')[0] ?? 'owner'}`}
						</button>
					{:else if move === 'suggest_workflow' && proposal.suggested_workflow}
						<a
							href={`/jobs/${proposal.suggested_workflow}`}
							onclick={(e) => e.stopPropagation()}
							class="cursor-pointer rounded border border-indigo-500/30 px-2 py-1 text-xs font-medium text-indigo-300 transition-colors hover:text-indigo-200"
						>
							{`▶ Run ${proposal.suggested_workflow.replace(/_/g, ' ')}`}
						</a>
					{/if}
					{#if onContinue}
						<button
							type="button"
							onclick={() => onContinue?.(handoffPrompt)}
							disabled={busy}
							class="cursor-pointer rounded px-2 py-1 text-xs text-fg-muted transition-colors hover:text-indigo-300 disabled:cursor-not-allowed disabled:opacity-50"
						>
							💬 Discuss
						</button>
					{/if}
				</div>
				<!-- Right-side actions. Artifacts are documents you review, not
				     proposals you approve/execute — so they get a single
				     "Mark reviewed" control (clears the card, no follow-on work)
				     instead of the Dismiss / Edit / Approve trio. -->
				<div class="flex items-center gap-2">
					{#if isArtifact}
						{#if onDismiss}
							<button
								type="button"
								onclick={() => onDismiss?.(proposal)}
								disabled={busy}
								class="cursor-pointer rounded px-2 py-1 text-xs font-medium text-emerald-300 transition-colors hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
							>
								✓ Mark reviewed
							</button>
						{/if}
					{:else}
						{#if onDismiss}
							<button
								type="button"
								onclick={() => onDismiss?.(proposal)}
								disabled={busy}
								class={`cursor-pointer rounded px-2 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
									isLikelyStale
										? 'border border-amber-500/30 font-medium text-amber-300 hover:text-amber-200'
										: 'text-fg-muted hover:text-rose-300'
								}`}
							>
								✕ Dismiss
							</button>
						{/if}
						<!-- Monitoring items are passive signals with no proposed
						     action to execute — only Discuss + Dismiss apply, so the
						     approve controls are hidden for them. -->
						{#if !isMonitoring && !isDecision && onApproveWithEdits}
							<button
								type="button"
								onclick={startEditing}
								disabled={busy}
								class="cursor-pointer rounded px-2 py-1 text-xs text-fg-muted transition-colors hover:text-emerald-300 disabled:cursor-not-allowed disabled:opacity-50"
							>
								✎ Edit &amp; approve
							</button>
						{/if}
						{#if !isMonitoring && onApprove}
							<button
								type="button"
								onclick={() => onApprove?.(proposal)}
								disabled={busy}
								class="cursor-pointer rounded px-2 py-1 text-xs font-medium text-emerald-300 transition-colors hover:text-emerald-200 disabled:cursor-not-allowed disabled:opacity-50"
							>
								✓ Approve
							</button>
						{/if}
					{/if}
				</div>
			</div>
		{/if}
	</div>
{/if}

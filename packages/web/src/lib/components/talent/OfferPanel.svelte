<script lang="ts">
	import { onMount } from 'svelte';
	import type { Candidate, Offer } from '$lib/api.js';
	import { OPEN_OFFER_STATUSES, extendOffer, listOffers, recordOfferDecision } from '$lib/api.js';
	import { OFFER_STATUS_META } from './stages.js';
	import { workflowLink } from './workflowLink.js';

	/** Days-until-expiry copy for an extended offer; null when not applicable. */
	function expiryCountdown(offer: Offer): { text: string; urgent: boolean } | null {
		if (offer.status !== 'extended' || !offer.expires_at) return null;
		const ms = new Date(offer.expires_at).getTime() - Date.now();
		if (Number.isNaN(ms)) return null;
		const days = ms / 86_400_000;
		if (days < 0) return { text: 'expired — record a decision', urgent: true };
		if (days < 1) return { text: 'expires today', urgent: true };
		const whole = Math.floor(days);
		return { text: `expires in ${whole} day${whole === 1 ? '' : 's'}`, urgent: days <= 3 };
	}

	interface Props {
		candidate: Candidate;
		/** Called after a lifecycle action so the parent can reload the candidate
		 *  (accepting an offer moves them to `placed` server-side). */
		onChanged?: () => void;
	}

	let { candidate, onChanged }: Props = $props();

	let offers = $state.raw<Offer[]>([]);
	let error = $state<string | null>(null);
	let notice = $state<string | null>(null);
	let busy = $state(false);
	let showPackage = $state(false);
	let expiresInDays = $state('7');

	async function load() {
		try {
			offers = await listOffers({ candidateId: candidate.id });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Failed to load offers';
		}
	}

	onMount(() => {
		void load();
	});

	// With no open offer, show the latest decided one as history.
	let open = $derived(offers.find((o) => OPEN_OFFER_STATUSES.includes(o.status)));
	let offer = $derived(open ?? offers[offers.length - 1]);
	let countdown = $derived(offer ? expiryCountdown(offer) : null);
	let hireReady = $derived(
		candidate.stage === 'placed' || offers.some((o) => o.status === 'accepted')
	);
	let meta = $derived(offer ? OFFER_STATUS_META[offer.status] : null);

	async function act(fn: () => Promise<{ warnings?: string[]; side_effects?: string[] }>) {
		busy = true;
		error = null;
		notice = null;
		try {
			const result = await fn();
			const messages = [...(result.warnings ?? []), ...(result.side_effects ?? [])];
			if (messages.length) notice = messages.join(' · ');
			void load();
			onChanged?.();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Offer action failed';
		} finally {
			busy = false;
		}
	}
</script>

<!-- Offer lifecycle panel on the candidate detail page.
     Shows the candidate's current (or most recent) offer: status, terms, the
     persisted package from the offer_approval workflow, and the lifecycle
     actions — draft (workflow), mark extended, record the decision, start
     onboarding. OE never sends the offer to the candidate; the actions here
     record what the principal did. -->
<div class="mb-6">
	<div class="mb-2 text-xs font-semibold tracking-wide text-fg-muted uppercase">Offer</div>
	<div class="space-y-3 rounded-xl border border-line bg-surface-elevated p-4">
		{#if error}
			<div
				class="rounded-lg border border-rose-500/30 bg-rose-500/10 p-2 text-xs text-rose-300"
				role="alert"
			>
				{error}
			</div>
		{/if}
		{#if notice}
			<div
				class="rounded-lg border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-amber-300"
				role="status"
			>
				{notice}
			</div>
		{/if}

		{#if !offer}
			<div class="flex items-center justify-between gap-3">
				<p class="text-sm text-fg-subtle">
					No offer yet. The workflow drafts terms against the comp band and requests hiring
					sign-off.
				</p>
				<a
					href={workflowLink('offer_approval', { candidate_id: String(candidate.id) })}
					class="shrink-0 rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
				>
					Draft offer
				</a>
			</div>
		{:else}
			<!-- A `const` copy so the closures below keep the non-null type. -->
			{@const current = offer}

			<div class="flex flex-wrap items-center gap-2">
				{#if meta}
					<span
						class={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${meta.pill}`}
					>
						{meta.label}
					</span>
				{/if}
				{#if countdown}
					<span class={`text-xs ${countdown.urgent ? 'text-rose-300' : 'text-fg-muted'}`}>
						{countdown.text}
					</span>
				{/if}
				{#if current.note}
					<span class="truncate text-xs text-fg-subtle">{current.note}</span>
				{/if}
			</div>

			{#if current.comp_summary}
				<p class="text-sm whitespace-pre-wrap text-fg-muted">{current.comp_summary}</p>
			{/if}

			{#if current.package_md}
				<div>
					<button
						type="button"
						onclick={() => (showPackage = !showPackage)}
						class="text-xs text-indigo-300 hover:text-indigo-200"
					>
						{showPackage ? 'Hide offer package' : 'Show offer package'}
					</button>
					{#if showPackage}
						<pre
							class="mt-2 overflow-x-auto rounded-lg border border-line bg-surface-input p-3 text-xs whitespace-pre-wrap text-fg-muted">{current.package_md}</pre>
					{/if}
				</div>
			{/if}

			<div class="flex flex-wrap items-center gap-2">
				{#if current.status === 'draft' || current.status === 'pending_approval'}
					<label class="flex items-center gap-1 text-xs text-fg-muted">
						Expires in
						<input
							bind:value={expiresInDays}
							class="w-12 rounded-lg border border-line bg-surface-input px-2 py-1 text-xs text-fg focus:border-indigo-500 focus:outline-none"
						/>
						days
					</label>
					<button
						type="button"
						disabled={busy}
						onclick={() =>
							act(() =>
								extendOffer(current.id, {
									expires_in_days: Math.max(1, Math.min(60, Number(expiresInDays) || 7))
								})
							)}
						class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
						title="You sent the offer yourself — this records it and schedules expiry reminders."
					>
						Mark extended
					</button>
				{/if}
				{#if current.status === 'extended'}
					<button
						type="button"
						disabled={busy}
						onclick={() => act(() => recordOfferDecision(current.id, 'accepted'))}
						class="rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
					>
						Accepted
					</button>
					<button
						type="button"
						disabled={busy}
						onclick={() => act(() => recordOfferDecision(current.id, 'declined'))}
						class="rounded-lg border border-rose-500/40 px-3 py-1.5 text-xs font-medium text-rose-300 hover:bg-rose-500/10 disabled:opacity-50"
					>
						Declined
					</button>
					<button
						type="button"
						disabled={busy}
						onclick={() => act(() => recordOfferDecision(current.id, 'expired'))}
						class="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-surface-overlay disabled:opacity-50"
					>
						Expired
					</button>
				{/if}
				{#if OPEN_OFFER_STATUSES.includes(current.status)}
					<button
						type="button"
						disabled={busy}
						onclick={() => act(() => recordOfferDecision(current.id, 'rescinded'))}
						class="rounded-lg border border-line px-3 py-1.5 text-xs font-medium text-fg-muted hover:bg-surface-overlay disabled:opacity-50"
					>
						Rescind
					</button>
				{/if}
				{#if !open && !hireReady}
					<a
						href={workflowLink('offer_approval', { candidate_id: String(candidate.id) })}
						class="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500"
					>
						Draft new offer
					</a>
				{/if}
			</div>
		{/if}

		{#if hireReady}
			<div class="flex items-center justify-between gap-3 border-t border-line pt-2">
				<p class="text-xs text-fg-muted">
					Hired — add them to the roster and schedule 30/60/90 check-ins.
				</p>
				<a
					href={workflowLink('new_hire_onboarding', { candidate_id: String(candidate.id) })}
					class="shrink-0 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-emerald-500"
				>
					Start onboarding
				</a>
			</div>
		{/if}
	</div>
</div>

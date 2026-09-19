// Ask OE — page-aware assistant panel context.
// Ported from `packages/ui/src/components/askoe/AskOEContext.tsx`.
//
// React used a provider component + context. Svelte 5 uses a reactive class
// instance handed down via `setContext`/`getContext`, so `ctx.open` and
// `ctx.suggested` stay reactive inside any descendant template.
import { getContext, setContext } from 'svelte';
import { page } from '$app/state';
import type { PageContext, PageFormField } from '$lib/api.js';

// ---------------------------------------------------------------------------
// Form registration contract
// ---------------------------------------------------------------------------

/** Result of applying a form_patch into the registered form's state. */
export interface AppliedPatch {
	/** Field names that were applied (highlighted as suggestions). */
	applied: string[];
	/** Field names the form rejected (unknown name, bad shape). */
	skipped: string[];
	/** Restores the values captured just before this patch was applied. */
	undo: () => void;
}

/**
 * What a page registers so Ask OE can describe and fill its form.
 * `getFields` is called at send time (values snapshot); `applyPatch`
 * writes proposed values into the form's state and returns what stuck
 * plus an undo closure.
 */
export interface RegisteredForm {
	formId: string;
	title: string;
	description?: string;
	getFields: () => PageFormField[];
	applyPatch: (values: Record<string, unknown>) => AppliedPatch;
}

// ---------------------------------------------------------------------------
// Route → guide section + page title
// ---------------------------------------------------------------------------

// Maps a route prefix to the /guide section that documents it (ids from
// packages/core/openexecutive/guide/sections.py). Longest-prefix entries
// first where routes nest (/audit/usage before /audit). Unmapped routes
// still get explain-tier help from route + title alone.
const ROUTE_GUIDE_MAP: Array<{ prefix: string; guideId: string; title: string }> = [
	{ prefix: '/audit/usage', guideId: 'token_usage', title: 'Token usage' },
	{ prefix: '/audit', guideId: 'audit', title: 'Audit log' },
	{ prefix: '/today', guideId: 'today', title: 'Today' },
	{ prefix: '/memories', guideId: 'pulse', title: 'Pulse' },
	{ prefix: '/review', guideId: 'review', title: 'Review queue' },
	{ prefix: '/jobs', guideId: 'jobs', title: 'Jobs' },
	{ prefix: '/artifacts', guideId: 'artifacts', title: 'Artifacts' },
	{ prefix: '/watchlist', guideId: 'watchlist', title: 'Watch list' },
	{ prefix: '/departments', guideId: 'departments', title: 'Departments' },
	{ prefix: '/people', guideId: 'people', title: 'People' },
	{ prefix: '/company-profile', guideId: 'company_profile', title: 'Company profile' },
	{ prefix: '/knowledge', guideId: 'knowledge', title: 'Knowledge base' },
	{ prefix: '/skills', guideId: 'skills', title: 'Skills' },
	{ prefix: '/council', guideId: 'council', title: 'Agent Council' },
	{ prefix: '/demo', guideId: 'simulator', title: 'Company Simulator' },
	{ prefix: '/settings', guideId: 'settings', title: 'Settings' }
];

// Routes with no guide section yet — still want a readable page title.
const EXTRA_TITLES: Array<{ prefix: string; title: string }> = [
	{ prefix: '/talent', title: 'Talent' },
	{ prefix: '/staff-onboarding', title: 'Staff onboarding' },
	{ prefix: '/clients', title: 'Client Companies' },
	{ prefix: '/architecture', title: 'Architecture' },
	{ prefix: '/guide', title: 'User Guide' }
];

export function resolveRouteMeta(pathname: string): { guideId: string | null; title: string } {
	for (const entry of ROUTE_GUIDE_MAP) {
		if (pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`)) {
			return { guideId: entry.guideId, title: entry.title };
		}
	}
	for (const entry of EXTRA_TITLES) {
		if (pathname === entry.prefix || pathname.startsWith(`${entry.prefix}/`)) {
			return { guideId: null, title: entry.title };
		}
	}
	const first = pathname.split('/').filter(Boolean)[0] ?? '';
	return { guideId: null, title: first || 'Open Executive' };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const ASKOE_KEY = Symbol('askoe');

export class AskOEState {
	open = $state(false);
	/** Identity of the currently registered form, for panel UI. */
	formMeta = $state<{ formId: string; title: string } | null>(null);
	suggested = $state<Set<string>>(new Set());
	/** Latest registered form (fresh closures) — used by the panel. */
	#form: RegisteredForm | null = null;

	setOpen(v: boolean) {
		this.open = v;
	}

	toggle() {
		this.open = !this.open;
	}

	registerForm(form: RegisteredForm): () => void {
		this.#form = form;
		this.formMeta = { formId: form.formId, title: form.title };
		return () => {
			// Only clear if a different form hasn't registered in the meantime
			// (e.g. navigating from one form page straight to another).
			if (this.#form?.formId === form.formId) {
				this.#form = null;
				this.formMeta = null;
				this.suggested = new Set();
			}
		};
	}

	/** Keep the registered form's closures fresh across re-renders. */
	refreshForm(form: RegisteredForm) {
		if (this.#form?.formId === form.formId) {
			this.#form = form;
		}
	}

	getForm(): RegisteredForm | null {
		return this.#form;
	}

	markSuggested(names: string[]) {
		if (names.length === 0) return;
		const next = new Set(this.suggested);
		for (const n of names) next.add(n);
		this.suggested = next;
	}

	clearSuggested(name?: string) {
		if (name === undefined) {
			this.suggested = new Set();
			return;
		}
		if (!this.suggested.has(name)) return;
		const next = new Set(this.suggested);
		next.delete(name);
		this.suggested = next;
	}

	buildPageContext(): PageContext {
		const pathname = page.url.pathname || '/';
		const meta = resolveRouteMeta(pathname);
		const form = this.#form;
		return {
			route: pathname,
			title: meta.title,
			guide_section_id: meta.guideId,
			form: form
				? {
						form_id: form.formId,
						title: form.title,
						description: form.description,
						fields: form.getFields()
					}
				: null
		};
	}
}

/** Create + provide the Ask OE state. Call during a component's init. */
export function setAskOEState(): AskOEState {
	const state = new AskOEState();
	setContext(ASKOE_KEY, state);
	return state;
}

export function getAskOE(): AskOEState {
	const ctx = getContext<AskOEState>(ASKOE_KEY);
	if (!ctx) throw new Error('getAskOE must be used inside <AskOEProvider>');
	return ctx;
}

/** Tailwind classes marking an input as an OE suggestion (cleared on edit). */
export const SUGGESTED_CLS = 'ring-1 ring-indigo-400/70 bg-indigo-500/10';

/**
 * Register a form with the Ask OE panel for the lifetime of the calling
 * component's effect scope. Pass a getter returning `null` to skip
 * registration (e.g. modal closed).
 *
 * Returns helpers for the suggested-value highlight: append
 * `suggestedCls(name)` to an input's class list and call
 * `clearSuggested(name)` in its oninput so the highlight clears the
 * moment the user edits the field.
 */
export function useAskOEForm(form: () => RegisteredForm | null): {
	suggestedCls: (name: string) => string;
	clearSuggested: (name: string) => void;
} {
	const ctx = getAskOE();

	// Register once per formId; the cleanup unregisters on unmount/close.
	$effect(() => {
		const f = form();
		if (!f) return;
		return ctx.registerForm(f);
	});

	// Keep closures (getFields/applyPatch) fresh so the panel always
	// snapshots current values without re-registering.
	$effect(() => {
		const f = form();
		if (f) ctx.refreshForm(f);
	});

	return {
		suggestedCls: (name: string) => (ctx.suggested.has(name) ? SUGGESTED_CLS : ''),
		clearSuggested: (name: string) => ctx.clearSuggested(name)
	};
}

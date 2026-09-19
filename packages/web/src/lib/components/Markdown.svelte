<script lang="ts">
	// Shared markdown renderer — the Svelte stand-in for `react-markdown` +
	// `remark-gfm`, which nine upstream components use.
	//
	// `marked` handles GFM (tables, strikethrough, task lists); DOMPurify
	// sanitises the output so model- or user-authored markdown can never inject
	// script. Sanitising needs a DOM, so parsing only runs in the browser —
	// callers fetch their content on mount anyway (matching the upstream
	// `"use client"` components), so this costs nothing in practice.
	//
	// Why `$effect` and not `$derived`: both `marked` and DOMPurify require a
	// DOM, so this pipeline can only run in the browser. `$derived` is evaluated
	// during SSR as well, which would either throw under Node or emit markup the
	// server never rendered (a hydration mismatch). `$effect` runs only in the
	// browser and only after the initial render, so the server and first client
	// render agree (both empty) and the effect then fills in. The effect writes
	// `html` but never reads it, so it cannot cause an update cycle.
	//
	// `{@html}` below is safe by construction: the string is DOMPurify output,
	// never raw input.
	import { browser } from '$app/environment';
	import { marked } from 'marked';
	import DOMPurify from 'dompurify';

	interface Props {
		/** Markdown source. */
		source?: string | null;
		/** Extra classes for the prose wrapper. */
		class?: string;
		/**
		 * Wrapper element. Use `span` when the rendered markdown sits inside a
		 * phrasing context — notably a `<button>` — where a `<div>` would be
		 * invalid HTML.
		 */
		as?: 'div' | 'span';
	}

	let { source = '', class: className = '', as = 'div' }: Props = $props();

	let html = $state('');

	// Add rel="noopener noreferrer" to any external link DOMPurify lets through.
	// Registered once per module load; DOMPurify is a singleton.
	if (browser) {
		DOMPurify.addHook('afterSanitizeAttributes', (node) => {
			if (node instanceof Element && node.tagName === 'A' && node.getAttribute('target')) {
				node.setAttribute('rel', 'noopener noreferrer');
			}
		});
	}

	$effect(() => {
		const src = source ?? '';
		if (!browser || !src) {
			html = '';
			return;
		}
		const raw = marked.parse(src, { async: false, gfm: true, breaks: false }) as string;
		html = DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
	});
</script>

{#if html}
	{#if as === 'span'}
		<span class={`prose max-w-none ${className}`}>{@html html}</span>
	{:else}
		<div class={`prose max-w-none ${className}`}>{@html html}</div>
	{/if}
{/if}

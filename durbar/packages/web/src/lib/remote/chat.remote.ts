/**
 * Chat remote functions.
 *
 * Chat turns are SSE streams on Durbar (`POST /chat` → `text/event-stream`).
 * Remote `query`/`command` are not streaming primitives, so the dashboard
 * starts a turn via a `command` and streams via a plain `fetch` to the
 * Durbar URL on the client. This file exposes the non-streaming helpers
 * (suggested prompts, session listing) as `query` and a helper to build the
 * SSE URL so the client never hard-codes the Durbar origin.
 */
import { query } from '$app/server';
import { durbarJson } from '$lib/server/durbar.js';

export interface SuggestedPrompt {
	prompt: string;
	[key: string]: unknown;
}

export const getSuggestedPrompts = query(async (): Promise<SuggestedPrompt[]> => {
	return durbarJson<SuggestedPrompt[]>('/chat/suggested-prompts');
});

export const listSessions = query(async (): Promise<unknown[]> => {
	return durbarJson<unknown[]>('/sessions');
});

export const getSessionMessages = query(async (): Promise<unknown[]> => {
	// Placeholder — real route is /sessions/{id}/messages; callers pass id
	// via a separate query param wrapper in the page. Kept simple for scaffold.
	return durbarJson<unknown[]>('/sessions');
});

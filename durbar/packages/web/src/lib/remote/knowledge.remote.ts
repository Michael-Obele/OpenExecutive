/**
 * Knowledge remote functions.
 *
 * Search is POST /knowledge/search (partitioned hits), builtin listing is
 * GET /knowledge/builtin, failures are GET /knowledge/failures.
 */
import * as v from 'valibot';
import { query } from '$app/server';
import { durbarJson, durbarFetch } from '$lib/server/durbar.js';

export interface KnowledgeHit {
	filename: string;
	domain: string;
	source: string;
	distance: number;
	text: string;
}

export interface KnowledgeSearchResult {
	query: string;
	effective_domains: readonly string[] | null;
	specialists_that_would_see_this: string[];
	builtin: KnowledgeHit[];
	company: KnowledgeHit[];
	failures: KnowledgeHit[];
	external: KnowledgeHit[];
}

export interface BuiltinFile {
	domain: string;
	filename: string;
	size_bytes: number;
}

export const listBuiltinFiles = query(async (): Promise<BuiltinFile[]> => {
	const data = await durbarJson<{ files: BuiltinFile[] }>('/knowledge/builtin');
	return data.files;
});

export const getBuiltinFile = query(v.string(), async (path): Promise<{ content: string }> => {
	// path is "domain/filename"
	const [domain, filename] = path.split('/');
	if (!domain || !filename) throw new Error('Invalid builtin path');
	return durbarJson<{ content: string }>(
		`/knowledge/builtin/${encodeURIComponent(domain)}/${encodeURIComponent(filename)}`
	);
});

export const searchKnowledge = query(
	v.object({
		query: v.pipe(v.string(), v.minLength(1, 'Query is required')),
		domain_filter: v.optional(v.array(v.string())),
		specialist: v.optional(v.string()),
		n_builtin: v.optional(v.number()),
		n_company: v.optional(v.number()),
		n_failures: v.optional(v.number())
	}),
	async (args): Promise<KnowledgeSearchResult> => {
		const res = await durbarFetch('/knowledge/search', {
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify({
				query: args.query,
				...(args.domain_filter ? { domain_filter: args.domain_filter } : {}),
				...(args.specialist ? { specialist: args.specialist } : {}),
				...(args.n_builtin !== undefined ? { n_builtin: args.n_builtin } : {}),
				...(args.n_company !== undefined ? { n_company: args.n_company } : {}),
				...(args.n_failures !== undefined ? { n_failures: args.n_failures } : {})
			})
		});
		if (!res.ok) {
			const detail = await res.text();
			throw new Error(`Search failed: ${detail || res.statusText}`);
		}
		return (await res.json()) as KnowledgeSearchResult;
	}
);

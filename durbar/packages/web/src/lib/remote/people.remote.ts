/**
 * People remote functions.
 *
 * `query` for reads, `command` for mutations. People are scoped to
 * departments and have authority levels that gate what runs unattended.
 */
import * as v from 'valibot';
import { command, query } from '$app/server';
import { durbarFetch, durbarJson } from '$lib/server/durbar.js';

export interface Person {
	id: number;
	full_name: string;
	role?: string;
	is_principal?: boolean;
	[key: string]: unknown;
}

export const listPeople = query(async (): Promise<Person[]> => {
	return durbarJson<Person[]>('/people');
});

export const getPerson = query(v.string(), async (id): Promise<Person> => {
	return durbarJson<Person>(`/people/${encodeURIComponent(id)}`);
});

export const createPerson = command(
	v.object({
		full_name: v.pipe(v.string(), v.minLength(1, 'Name is required')),
		role: v.optional(v.string()),
		is_principal: v.optional(v.boolean())
	}),
	async (data) => {
		const res = await durbarFetch('/people', {
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify(data)
		});
		if (!res.ok) {
			const detail = await res.text();
			throw new Error(`Create failed: ${detail || res.statusText}`);
		}
		const created = (await res.json()) as Person;
		await listPeople().refresh();
		return created;
	}
);

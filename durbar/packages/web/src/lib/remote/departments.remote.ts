/**
 * Departments remote functions.
 *
 * Demonstrates `query` for reads and `command` for button-triggered mutations.
 * `command` is the right flavor for non-form actions (create/delete) that are
 * triggered by a button rather than a native HTML form.
 */
import * as v from 'valibot';
import { command, query } from '$app/server';
import { durbarFetch, durbarJson } from '$lib/server/durbar.js';

export interface Department {
	slug: string;
	title: string;
	mission?: string;
	authority_level?: string;
	[key: string]: unknown;
}

export const listDepartments = query(async (): Promise<Department[]> => {
	return durbarJson<Department[]>('/departments');
});

export const getDepartment = query(v.string(), async (slug): Promise<Department> => {
	return durbarJson<Department>(`/departments/${encodeURIComponent(slug)}`);
});

export const createDepartment = command(
	v.object({
		title: v.pipe(v.string(), v.minLength(1, 'Title is required')),
		mission: v.optional(v.string())
	}),
	async (data) => {
		const res = await durbarFetch('/departments', {
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify(data)
		});
		if (!res.ok) {
			const detail = await res.text();
			throw new Error(`Create failed: ${detail || res.statusText}`);
		}
		const created = (await res.json()) as Department;
		await listDepartments().refresh();
		return created;
	}
);

export const deleteDepartment = command(v.string(), async (slug) => {
	const res = await durbarFetch(`/departments/${encodeURIComponent(slug)}`, {
		method: 'DELETE'
	});
	if (!res.ok) {
		const detail = await res.text();
		throw new Error(`Delete failed: ${detail || res.statusText}`);
	}
	await listDepartments().refresh();
});

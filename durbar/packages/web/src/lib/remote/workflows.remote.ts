/**
 * Workflows remote functions.
 *
 * `query` for listing/reading, `command` for starting runs. Workflow runs
 * are SSE streams on the Durbar side — the dashboard starts a run via POST
 * and then streams events via GET /workflows/{name}/runs/{id} or via the
 * chat SSE endpoint. This file covers the non-streaming CRUD.
 */
import * as v from 'valibot';
import { command, query } from '$app/server';
import { durbarFetch, durbarJson } from '$lib/server/durbar.js';

export interface WorkflowDef {
	name: string;
	title?: string;
	description?: string;
	[key: string]: unknown;
}

export interface WorkflowRun {
	id: string;
	workflow_name: string;
	status: string;
	created_at: string;
	[key: string]: unknown;
}

export const listWorkflows = query(async (): Promise<WorkflowDef[]> => {
	return durbarJson<WorkflowDef[]>('/workflows');
});

export const getWorkflow = query(v.string(), async (name): Promise<WorkflowDef> => {
	return durbarJson<WorkflowDef>(`/workflows/${encodeURIComponent(name)}`);
});

export const listWorkflowRuns = query(async (): Promise<WorkflowRun[]> => {
	return durbarJson<WorkflowRun[]>('/workflows/runs');
});

export const getWorkflowRun = query(v.string(), async (runId): Promise<WorkflowRun> => {
	return durbarJson<WorkflowRun>(`/workflows/runs/${encodeURIComponent(runId)}`);
});

export const startWorkflowRun = command(
	v.object({
		workflowName: v.pipe(v.string(), v.minLength(1)),
		inputs: v.optional(v.record(v.string(), v.unknown()), {})
	}),
	async ({ workflowName, inputs }) => {
		const res = await durbarFetch(`/workflows/${encodeURIComponent(workflowName)}/runs`, {
			method: 'POST',
			contentType: 'application/json',
			body: JSON.stringify(inputs ?? {})
		});
		if (!res.ok) {
			const detail = await res.text();
			throw new Error(`Start failed: ${detail || res.statusText}`);
		}
		const run = (await res.json()) as WorkflowRun;
		await listWorkflowRuns().refresh();
		return run;
	}
);

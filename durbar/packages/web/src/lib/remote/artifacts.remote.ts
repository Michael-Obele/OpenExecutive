/**
 * Artifacts remote functions.
 *
 * Unified view over alert-backed and run-backed artifacts. Addressed by
 * composite id "alert:{id}" / "run:{hex}".
 */
import * as v from "valibot";
import { command, query } from "$app/server";
import { durbarFetch, durbarJson } from "$lib/server/durbar.js";

export interface ArtifactSummary {
  id: string;
  kind: "draft" | "workflow";
  title: string;
  source_label: string;
  created_at: string;
  preview: string | null;
  status: string;
  severity: string | null;
  archived_at: string | null;
}

export interface ArtifactDetail extends ArtifactSummary {
  body: string;
  rationale: string | null;
}

export const listArtifacts = query(async (): Promise<ArtifactSummary[]> => {
  const data = await durbarJson<{ artifacts: ArtifactSummary[] }>("/artifacts");
  return data.artifacts;
});

export const listArchivedArtifacts = query(
  async (): Promise<ArtifactSummary[]> => {
    const data = await durbarJson<{ artifacts: ArtifactSummary[] }>(
      "/artifacts",
      {
        query: { archived: "true" },
      },
    );
    return data.artifacts;
  },
);

export const getArtifact = query(
  v.string(),
  async (id): Promise<ArtifactDetail> => {
    return durbarJson<ArtifactDetail>(`/artifacts/${encodeURIComponent(id)}`);
  },
);

export const archiveArtifact = command(v.string(), async (id) => {
  const res = await durbarFetch(
    `/artifacts/${encodeURIComponent(id)}/archive`,
    {
      method: "POST",
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Archive failed: ${detail || res.statusText}`);
  }
  await listArtifacts().refresh();
  return (await res.json()) as { status: string; id: string };
});

export const restoreArtifact = command(v.string(), async (id) => {
  const res = await durbarFetch(
    `/artifacts/${encodeURIComponent(id)}/restore`,
    {
      method: "POST",
    },
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`Restore failed: ${detail || res.statusText}`);
  }
  await listArtifacts().refresh();
  return (await res.json()) as { status: string; id: string };
});

/**
 * Company profile remote functions.
 *
 * `query` for reads, `form` for mutations via native HTML `<form>` + Valibot.
 * Demonstrates the `form` flavor — the dashboard's preferred mutation path per
 * AGENTS.md (no hand-rolled handleSubmit).
 */
import * as v from "valibot";
import { form, query } from "$app/server";
import { durbarJson, durbarFetch } from "$lib/server/durbar.js";

export interface CompanyProfile {
  name?: string;
  mission?: string;
  vision?: string;
  values?: string[];
  industry?: string;
  size?: string;
  [key: string]: unknown;
}

export const getCompanyProfile = query(async (): Promise<CompanyProfile> => {
  return durbarJson<CompanyProfile>("/company-profile");
});

// PATCH /company-profile with partial fields — Valibot validates on both
// client (preflight) and server before the Durbar call.
export const updateCompanyProfile = form(
  v.object({
    name: v.optional(v.string()),
    mission: v.optional(v.string()),
    vision: v.optional(v.string()),
    industry: v.optional(v.string()),
    size: v.optional(v.string()),
  }),
  async (data) => {
    const res = await durbarFetch("/company-profile", {
      method: "PATCH",
      contentType: "application/json",
      body: JSON.stringify(data),
    });
    if (!res.ok) {
      const detail = await res.text();
      throw new Error(`Update failed: ${detail || res.statusText}`);
    }
    const updated = (await res.json()) as CompanyProfile;
    await getCompanyProfile().refresh();
    return updated;
  },
);

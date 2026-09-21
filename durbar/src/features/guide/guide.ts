/**
 * Guide — static user-guide sections.
 *
 * Port of `guide/prebuilt.py` + `guide/sections.py` + `api/routes/guide.py`.
 * Mirrors architecture: pre-authored JSON under `guide/prebuilt/*.json`.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface GuideSectionSpec {
  id: string;
  title: string;
  sub: string;
}

export const GUIDE_SECTIONS: GuideSectionSpec[] = [
  { id: "artifacts", title: "Artifacts", sub: "Workflow outputs." },
  { id: "ask_oe", title: "Ask OE", sub: "Chat with the Executive." },
  { id: "audit", title: "Audit", sub: "Audit log." },
  { id: "chat", title: "Chat", sub: "Chat surface." },
  { id: "clients", title: "Clients", sub: "Multi-client mode." },
  { id: "company_profile", title: "Company Profile", sub: "Company setup." },
  { id: "council", title: "Council", sub: "Specialist council." },
  { id: "departments", title: "Departments", sub: "Departments." },
  { id: "integrations", title: "Integrations", sub: "External integrations." },
  { id: "jobs", title: "Jobs", sub: "Scheduled jobs." },
  { id: "knowledge", title: "Knowledge", sub: "Knowledge base." },
  { id: "people", title: "People", sub: "Roster." },
  { id: "pulse", title: "Pulse", sub: "Daily pulse." },
  { id: "review", title: "Review", sub: "Review queue." },
  { id: "settings", title: "Settings", sub: "Settings." },
  { id: "simulator", title: "Simulator", sub: "Fixture simulator." },
  { id: "skills", title: "Skills", sub: "Skills." },
  { id: "staff_onboarding", title: "Staff Onboarding", sub: "New hire onboarding." },
  { id: "talent", title: "Talent", sub: "Hiring pipeline." },
  { id: "today", title: "Today", sub: "Daily briefing." },
  { id: "token_usage", title: "Token Usage", sub: "Usage." },
  { id: "watchlist", title: "Watchlist", sub: "External monitoring." },
];

export function getGuideSection(id: string): GuideSectionSpec | null {
  return GUIDE_SECTIONS.find((s) => s.id === id) ?? null;
}

export function listGuidePrebuilt(): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  const candidates = [
    new URL("../../../../packages/core/openexecutive/guide/prebuilt", import.meta.url).pathname,
    new URL("../../guide/prebuilt", import.meta.url).pathname,
  ];
  for (const dir of candidates) {
    try {
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".json")) continue;
        const id = entry.replace(/\.json$/, "");
        if (map.has(id)) continue;
        try {
          const text = readFileSync(join(dir, entry), "utf8");
          map.set(id, JSON.parse(text) as Record<string, unknown>);
        } catch { /* ignore */ }
      }
      if (map.size > 0) break;
    } catch { /* dir missing */ }
  }
  if (map.size === 0) {
    for (const spec of GUIDE_SECTIONS) {
      map.set(spec.id, {
        section_id: spec.id,
        title: spec.title,
        markdown: `# ${spec.title}\n\n_Content not yet authored._`,
        mermaid: null,
        generated_at: new Date().toISOString(),
      });
    }
  }
  return map;
}

export function getGuidePrebuilt(id: string): Record<string, unknown> | null {
  return listGuidePrebuilt().get(id) ?? null;
}

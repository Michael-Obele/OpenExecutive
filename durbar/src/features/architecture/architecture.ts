/**
 * Architecture — static prebuilt sections.
 *
 * Port of `architecture/prebuilt.py` + `architecture/sections.py` +
 * `api/routes/architecture.py`. Sections are pre-authored JSON under
 * `packages/core/openexecutive/architecture/prebuilt/*.json` (copied to
 * `durbar/architecture/prebuilt/` or read from the reference dir). No LLM
 * calls on this path.
 */

export interface SectionSpec {
  id: string;
  title: string;
  sub: string;
  wants_mermaid: boolean;
  diagram_kind: string | null;
}

// Mirrors architecture/sections.py SECTIONS — ids must match the UI.
export const SECTIONS: SectionSpec[] = [
  { id: "nojargon_what_it_is", title: "Without the Jargon: What It Is", sub: "The 90-second version.", wants_mermaid: true, diagram_kind: "flowchart" },
  { id: "nojargon_authority", title: "Without the Jargon: How It Decides To Act", sub: "Three modes — act, propose, escalate.", wants_mermaid: true, diagram_kind: "flowchart" },
  { id: "nojargon_proactive", title: "Without the Jargon: When You're Not Watching", sub: "Morning brief, check-ins, nudges.", wants_mermaid: true, diagram_kind: "sequence" },
  { id: "nojargon_org", title: "Without the Jargon: Who Approves What", sub: "Departments, heads, approval tags.", wants_mermaid: true, diagram_kind: "flowchart" },
  { id: "overview", title: "System Overview", sub: "High-level topology.", wants_mermaid: true, diagram_kind: "flowchart" },
  { id: "lifecycle", title: "Request Lifecycle", sub: "Full round-trip of a chat message.", wants_mermaid: true, diagram_kind: "sequence" },
  { id: "agents", title: "Agent Council", sub: "Executive and specialists.", wants_mermaid: true, diagram_kind: "flowchart" },
  { id: "caching", title: "Prompt Caching", sub: "System prompt partitioning.", wants_mermaid: true, diagram_kind: "flowchart" },
  { id: "rag", title: "Retrieval (RAG)", sub: "Knowledge retrieval.", wants_mermaid: true, diagram_kind: "flowchart" },
  { id: "memory", title: "Memory", sub: "Episodic memory.", wants_mermaid: false, diagram_kind: null },
  { id: "scheduler", title: "Scheduler", sub: "Proactive scheduling.", wants_mermaid: true, diagram_kind: "sequence" },
  { id: "workflows", title: "Workflows", sub: "Workflow catalog.", wants_mermaid: false, diagram_kind: null },
  { id: "api", title: "API", sub: "HTTP surface.", wants_mermaid: false, diagram_kind: null },
  { id: "schemas", title: "Schemas", sub: "Data shapes.", wants_mermaid: false, diagram_kind: null },
  { id: "integrations", title: "Integrations", sub: "External integrations.", wants_mermaid: false, diagram_kind: null },
  { id: "mcp_server", title: "MCP Server", sub: "Model Context Protocol.", wants_mermaid: false, diagram_kind: null },
  { id: "today", title: "Today", sub: "Daily briefing.", wants_mermaid: false, diagram_kind: null },
  { id: "review", title: "Review Queue", sub: "Human review.", wants_mermaid: false, diagram_kind: null },
  { id: "talent", title: "Talent", sub: "Hiring pipeline.", wants_mermaid: false, diagram_kind: null },
  { id: "staff_onboarding", title: "Staff Onboarding", sub: "New hire onboarding.", wants_mermaid: false, diagram_kind: null },
  { id: "external_monitoring", title: "External Monitoring", sub: "Watchlist.", wants_mermaid: false, diagram_kind: null },
  { id: "clients", title: "Clients", sub: "Multi-client slots.", wants_mermaid: false, diagram_kind: null },
  { id: "org", title: "Org", sub: "Departments and people.", wants_mermaid: false, diagram_kind: null },
  { id: "peer_memory", title: "Peer Memory", sub: "Honcho integration.", wants_mermaid: false, diagram_kind: null },
  { id: "audit", title: "Audit", sub: "Audit log.", wants_mermaid: false, diagram_kind: null },
];

export function getSection(id: string): SectionSpec | null {
  return SECTIONS.find((s) => s.id === id) ?? null;
}

export function listPrebuilt(): Map<string, Record<string, unknown>> {
  const map = new Map<string, Record<string, unknown>>();
  // Try to read from filesystem — reference prebuilt dir or durbar copy.
  const candidates = [
    // Reference implementation prebuilt
    new URL("../../../../packages/core/openexecutive/architecture/prebuilt", import.meta.url).pathname,
    // Durbar local copy if present
    new URL("../../architecture/prebuilt", import.meta.url).pathname,
  ];
  for (const dir of candidates) {
    try {
      const { readdirSync, readFileSync } = require("node:fs") as typeof import("node:fs");
      const { join } = require("node:path") as typeof import("node:path");
      for (const entry of readdirSync(dir)) {
        if (!entry.endsWith(".json")) continue;
        const id = entry.replace(/\.json$/, "");
        if (map.has(id)) continue;
        try {
          const text = readFileSync(join(dir, entry), "utf8");
          map.set(id, JSON.parse(text) as Record<string, unknown>);
        } catch { /* ignore malformed */ }
      }
      if (map.size > 0) break;
    } catch { /* dir missing */ }
  }
  // If no files found, synthesize minimal stubs so the API doesn't 404 everything.
  if (map.size === 0) {
    for (const spec of SECTIONS) {
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

export function getPrebuilt(id: string): Record<string, unknown> | null {
  return listPrebuilt().get(id) ?? null;
}

/**
 * Agents — runtime overrides for specialist configuration.
 *
 * Port of `agents/overrides.py` + `api/routes/agents.py`.
 * Each agent has defaults (model, prompt, role, deep_reasoning); overrides
 * are stored in SQLite and shadow the defaults. History is append-only.
 */

import type { Db } from "../../db.ts";

export const KNOWN_AGENTS = [
  "executive",
  "cso",
  "cfo",
  "chro",
  "gc",
  "coo",
  "cmo",
  "cpo",
  "board_comms",
  "talent",
  "triage",
  "quality_judge",
  "utility_fast",
  "research",
  "fixture_generator",
  "engagement_intake",
  "onboarding_interviewer",
] as const;

export type AgentId = (typeof KNOWN_AGENTS)[number];

const DEFAULT_MODELS: Record<string, string> = {
  executive: "deepseek-chat",
  cso: "deepseek-chat",
  cfo: "deepseek-chat",
  chro: "deepseek-chat",
  gc: "deepseek-chat",
  coo: "deepseek-chat",
  cmo: "deepseek-chat",
  cpo: "deepseek-chat",
  board_comms: "deepseek-chat",
  talent: "deepseek-chat",
  triage: "deepseek-chat",
  quality_judge: "deepseek-chat",
  utility_fast: "deepseek-chat",
  research: "deepseek-chat",
  fixture_generator: "deepseek-chat",
  engagement_intake: "deepseek-chat",
  onboarding_interviewer: "deepseek-chat",
};

const DEFAULT_ROLES: Record<string, string> = {
  executive: "Executive",
  cso: "Chief Strategy Officer",
  cfo: "Chief Financial Officer",
  chro: "Chief Human Resources Officer",
  gc: "General Counsel",
  coo: "Chief Operating Officer",
  cmo: "Chief Marketing Officer",
  cpo: "Chief Product Officer",
  board_comms: "Board Communications",
  talent: "Talent",
  triage: "Triage",
  quality_judge: "Committee · Quality Judge",
  utility_fast: "Utility · Fast model",
  research: "Utility · Research model",
  fixture_generator: "Utility · Company fixture generator",
  engagement_intake: "Utility · Client engagement intake",
  onboarding_interviewer: "Utility · Company setup interviewer",
};

export interface AgentOverride {
  agent_id: string;
  prompt: string | null;
  model: string | null;
  use_deep_reasoning: boolean | null;
  role: string | null;
  voice_persona_slug: string | null;
  research_focus: string | null;
  updated_at: string | null;
}

export interface AgentHistoryEntry {
  id: number;
  agent_id: string;
  prompt: string | null;
  model: string | null;
  use_deep_reasoning: boolean | null;
  role: string | null;
  voice_persona_slug: string | null;
  research_focus: string | null;
  created_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToOverride(row: Record<string, unknown>): AgentOverride {
  const deep = row["use_deep_reasoning"];
  return {
    agent_id: row["agent_id"] as string,
    prompt: (row["prompt"] as string | null) ?? null,
    model: (row["model"] as string | null) ?? null,
    use_deep_reasoning:
      deep !== null && deep !== undefined ? Boolean(deep) : null,
    role: (row["role"] as string | null) ?? null,
    voice_persona_slug: (row["voice_persona_slug"] as string | null) ?? null,
    research_focus: (row["research_focus"] as string | null) ?? null,
    updated_at: (row["updated_at"] as string | null) ?? null,
  };
}

function rowToHistory(row: Record<string, unknown>): AgentHistoryEntry {
  const deep = row["use_deep_reasoning"];
  return {
    id: row["id"] as number,
    agent_id: row["agent_id"] as string,
    prompt: (row["prompt"] as string | null) ?? null,
    model: (row["model"] as string | null) ?? null,
    use_deep_reasoning:
      deep !== null && deep !== undefined ? Boolean(deep) : null,
    role: (row["role"] as string | null) ?? null,
    voice_persona_slug: (row["voice_persona_slug"] as string | null) ?? null,
    research_focus: (row["research_focus"] as string | null) ?? null,
    created_at: row["created_at"] as string,
  };
}

export function getOverride(db: Db, agentId: string): AgentOverride | null {
  const row = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT * FROM agent_overrides WHERE agent_id = ?")
    .get(agentId);
  return row ? rowToOverride(row) : null;
}

export function listOverrides(db: Db): AgentOverride[] {
  const rows = db
    .query<Record<string, unknown>, []>("SELECT * FROM agent_overrides")
    .all();
  return rows.map(rowToOverride);
}

export function setOverride(
  db: Db,
  agentId: string,
  patch: Partial<Omit<AgentOverride, "agent_id" | "updated_at">> & {
    _set?: Set<string>;
  },
): AgentOverride {
  const now = nowIso();
  const existing = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT * FROM agent_overrides WHERE agent_id = ?")
    .get(agentId);
  if (existing) {
    // Snapshot to history
    db.run(
      "INSERT INTO agent_override_history (agent_id, prompt, model, use_deep_reasoning, role, voice_persona_slug, research_focus, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        agentId,
        existing["prompt"] as string | null,
        existing["model"] as string | null,
        existing["use_deep_reasoning"] as number | null,
        existing["role"] as string | null,
        existing["voice_persona_slug"] as string | null,
        existing["research_focus"] as string | null,
        existing["updated_at"] as string,
      ],
    );
    const set =
      patch._set ?? new Set(Object.keys(patch).filter((k) => k !== "_set"));
    const newPrompt = set.has("prompt")
      ? (patch.prompt ?? null)
      : (existing["prompt"] as string | null);
    const newModel = set.has("model")
      ? (patch.model ?? null)
      : (existing["model"] as string | null);
    const newDeep = set.has("use_deep_reasoning")
      ? patch.use_deep_reasoning !== undefined &&
        patch.use_deep_reasoning !== null
        ? patch.use_deep_reasoning
          ? 1
          : 0
        : null
      : (existing["use_deep_reasoning"] as number | null);
    const newRole = set.has("role")
      ? (patch.role ?? null)
      : (existing["role"] as string | null);
    const newVp = set.has("voice_persona_slug")
      ? (patch.voice_persona_slug ?? null)
      : (existing["voice_persona_slug"] as string | null);
    const newRf = set.has("research_focus")
      ? (patch.research_focus ?? null)
      : (existing["research_focus"] as string | null);
    db.run(
      "UPDATE agent_overrides SET prompt = ?, model = ?, use_deep_reasoning = ?, role = ?, voice_persona_slug = ?, research_focus = ?, updated_at = ? WHERE agent_id = ?",
      [newPrompt, newModel, newDeep, newRole, newVp, newRf, now, agentId],
    );
  } else {
    const set =
      patch._set ?? new Set(Object.keys(patch).filter((k) => k !== "_set"));
    const prompt = set.has("prompt") ? (patch.prompt ?? null) : null;
    const model = set.has("model") ? (patch.model ?? null) : null;
    const deep = set.has("use_deep_reasoning")
      ? patch.use_deep_reasoning !== undefined &&
        patch.use_deep_reasoning !== null
        ? patch.use_deep_reasoning
          ? 1
          : 0
        : null
      : null;
    const role = set.has("role") ? (patch.role ?? null) : null;
    const vp = set.has("voice_persona_slug")
      ? (patch.voice_persona_slug ?? null)
      : null;
    const rf = set.has("research_focus")
      ? (patch.research_focus ?? null)
      : null;
    db.run(
      "INSERT INTO agent_overrides (agent_id, prompt, model, use_deep_reasoning, role, voice_persona_slug, research_focus, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [agentId, prompt, model, deep, role, vp, rf, now],
    );
  }
  const updated = getOverride(db, agentId);
  if (!updated) throw new Error("Override vanished after set");
  return updated;
}

export function clearOverride(db: Db, agentId: string): boolean {
  const existing = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT * FROM agent_overrides WHERE agent_id = ?")
    .get(agentId);
  if (!existing) return false;
  db.run(
    "INSERT INTO agent_override_history (agent_id, prompt, model, use_deep_reasoning, role, voice_persona_slug, research_focus, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      agentId,
      existing["prompt"] as string | null,
      existing["model"] as string | null,
      existing["use_deep_reasoning"] as number | null,
      existing["role"] as string | null,
      existing["voice_persona_slug"] as string | null,
      existing["research_focus"] as string | null,
      existing["updated_at"] as string,
    ],
  );
  db.run("DELETE FROM agent_overrides WHERE agent_id = ?", [agentId]);
  return true;
}

export function listHistory(
  db: Db,
  agentId: string,
  limit = 50,
): AgentHistoryEntry[] {
  const rows = db
    .query<
      Record<string, unknown>,
      [string, number]
    >("SELECT * FROM agent_override_history WHERE agent_id = ? ORDER BY id DESC LIMIT ?")
    .all(agentId, limit);
  return rows.map(rowToHistory);
}

export function rollbackTo(
  db: Db,
  agentId: string,
  historyId: number,
): AgentOverride | null {
  const entry = db
    .query<
      Record<string, unknown>,
      [number, string]
    >("SELECT * FROM agent_override_history WHERE id = ? AND agent_id = ?")
    .get(historyId, agentId);
  if (!entry) return null;
  const h = rowToHistory(entry);
  // Snapshot current to history before rollback
  const current = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT * FROM agent_overrides WHERE agent_id = ?")
    .get(agentId);
  if (current) {
    db.run(
      "INSERT INTO agent_override_history (agent_id, prompt, model, use_deep_reasoning, role, voice_persona_slug, research_focus, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [
        agentId,
        current["prompt"] as string | null,
        current["model"] as string | null,
        current["use_deep_reasoning"] as number | null,
        current["role"] as string | null,
        current["voice_persona_slug"] as string | null,
        current["research_focus"] as string | null,
        current["updated_at"] as string,
      ],
    );
  }
  const now = nowIso();
  const deep =
    h.use_deep_reasoning !== null ? (h.use_deep_reasoning ? 1 : 0) : null;
  db.run(
    "INSERT OR REPLACE INTO agent_overrides (agent_id, prompt, model, use_deep_reasoning, role, voice_persona_slug, research_focus, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    [
      agentId,
      h.prompt,
      h.model,
      deep,
      h.role,
      h.voice_persona_slug,
      h.research_focus,
      now,
    ],
  );
  return getOverride(db, agentId);
}

export function buildAgentMeta(
  db: Db,
  agentId: string,
): Record<string, unknown> {
  const ov = getOverride(db, agentId);
  return {
    name: agentId,
    role: ov?.role ?? DEFAULT_ROLES[agentId] ?? agentId,
    model: ov?.model ?? DEFAULT_MODELS[agentId] ?? "deepseek-chat",
    deep_reasoning: ov?.use_deep_reasoning ?? false,
    domains: [],
    has_override: ov !== null,
  };
}

export function buildAgentDetail(
  db: Db,
  agentId: string,
): Record<string, unknown> {
  const ov = getOverride(db, agentId);
  const overridden: string[] = [];
  if (ov) {
    if (ov.prompt !== null) overridden.push("prompt");
    if (ov.model !== null) overridden.push("model");
    if (ov.use_deep_reasoning !== null) overridden.push("use_deep_reasoning");
    if (ov.role !== null) overridden.push("role");
    if (ov.voice_persona_slug !== null) overridden.push("voice_persona_slug");
    if (ov.research_focus !== null) overridden.push("research_focus");
  }
  return {
    name: agentId,
    role: ov?.role ?? DEFAULT_ROLES[agentId] ?? agentId,
    role_default: DEFAULT_ROLES[agentId] ?? agentId,
    model: ov?.model ?? DEFAULT_MODELS[agentId] ?? "deepseek-chat",
    model_default: DEFAULT_MODELS[agentId] ?? "deepseek-chat",
    deep_reasoning: ov?.use_deep_reasoning ?? false,
    deep_reasoning_default: false,
    prompt: ov?.prompt ?? `You are ${agentId}.`,
    prompt_default: `You are ${agentId}.`,
    domains: [],
    has_override: ov !== null,
    overridden_fields: overridden,
    updated_at: ov?.updated_at ?? null,
    voice_persona_slug: ov?.voice_persona_slug ?? null,
    research_focus: ov?.research_focus ?? null,
    research_focus_default: null,
  };
}

export function isKnownAgent(agentId: string): boolean {
  return (KNOWN_AGENTS as readonly string[]).includes(agentId);
}

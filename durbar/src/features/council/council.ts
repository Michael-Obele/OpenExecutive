/**
 * The council — fan out a question to the relevant specialists, then synthesize
 * their analyses into one answer.
 *
 * Port of `orchestrator/router.py` (route_parallel) plus the Executive's
 * synthesis step. Three phases, matching upstream:
 *
 *   1. select  — a cheap routing model picks which specialists are relevant.
 *   2. consult — those specialists answer in parallel, each with its own domain
 *                prompt and the same company context.
 *   3. convene — the Executive merges the analyses into one voice.
 *
 * The invariant that matters most is phase 3's: **the internal architecture is
 * never exposed**. The reader is the principal, and "the CFO said X while the
 * GC disagreed" is a failure, not transparency. The machinery is invisible.
 */

import type { Db } from '../../db.ts';
import type { Provider } from '../../providers.ts';
import {
  renderFailureCases,
  renderKnowledge,
  searchKnowledge,
} from '../knowledge/knowledge.ts';
import {
  SPECIALISTS,
  SPECIALIST_KEYS,
  type SpecialistKey,
} from "./specialists.ts";

/** Upper bound on a single question's fan-out, as upstream caps it. */
export const MAX_SPECIALISTS = 4;

export interface Consultation {
  readonly specialist: SpecialistKey;
  readonly title: string;
  readonly analysis: string;
}

export interface CouncilResult {
  readonly answer: string;
  readonly consultations: readonly Consultation[];
  /** True when routing failed and every specialist was consulted instead. */
  readonly routedByFallback: boolean;
}

export interface CouncilDeps {
  readonly provider: Provider;
  /** Company context (profile, goals, relevant documents) given to every specialist. */
  readonly context?: string;
  /**
   * Knowledge corpus. Optional so the council can be exercised without one, but
   * without it specialists answer from their prompt alone — no reference
   * material, and no `<failure_cases>` block for the prompts to draw on.
   */
  readonly db?: Db;
  readonly maxSpecialists?: number;
}

/**
 * Maps a specialist to the knowledge domain its corpus lives under.
 *
 * These are two different namespaces and the mapping is not mechanical: the
 * specialist roster uses role keys (`chro`, `gc`, `board_comms`) while the
 * corpus is organised by business function (`hr`, `legal`, `board`). There is
 * no `talent` corpus, so `talent` reads `hr` — the closest functional match.
 */
export function specialistDomain(key: SpecialistKey): string {
  const map: Record<SpecialistKey, string> = {
    cso: 'strategy',
    cfo: 'finance',
    chro: 'hr',
    gc: 'legal',
    coo: 'operations',
    cmo: 'marketing',
    cpo: 'product',
    board_comms: 'board',
    talent: 'hr',
  };
  return map[key];
}

export const SYNTHESIS_PROMPT = `You are the principal's executive team, speaking with one voice.

You have just received analyses from several functional specialists. Merge them
into a single answer for the principal.

Rules:
- Speak as one person. Never mention specialists, roles, tools, models, prompts,
  or that any of this was produced by a system.
- Never attribute a point to "the CFO" or "legal" — if a function's perspective
  matters, state the conclusion directly.
- Lead with the recommendation, then the reasoning that changes the decision.
  Cut anything that does not.
- Where specialists disagree, resolve it: pick a position and say what would
  change your mind. Do not present both sides as equally weighted.
- Be specific and concrete. Numbers, thresholds, named risks. No framework
  recitals, no hedging, no restating the question.
- If the honest answer is "this is not worth doing", say that.`;

/**
 * Renders the specialist roster for the routing prompt.
 *
 * The title is part of the line, matching upstream's `SPECIALIST_DESCRIPTIONS`
 * ("cso": "Chief Strategy Officer — competitive analysis, …"). Dropping it
 * leaves the router picking between bare topic lists with no indication of
 * whose domain each is, which measurably degrades routing on ambiguous
 * questions. `description` stays atomic so it can also serve as a tool enum.
 */
export function routingMenu(): string {
  return SPECIALIST_KEYS.map((key) => {
    const { title, description } = SPECIALISTS[key];
    return `- ${key}: ${title} — ${description}`;
  }).join("\n");
}

/**
 * Picks the specialists relevant to a question using the cheap routing model.
 *
 * Falls back to consulting *every* specialist when the routing model returns
 * something unparseable. That is deliberate: a routing failure should cost
 * money and latency, never correctness. Silently consulting nobody would
 * produce a confident answer with no expertise behind it — the worst possible
 * failure mode, because it is invisible.
 */
export async function selectSpecialists(
  question: string,
  deps: CouncilDeps,
): Promise<{ keys: readonly SpecialistKey[]; fallback: boolean }> {
  const max = deps.maxSpecialists ?? MAX_SPECIALISTS;

  const raw = await deps.provider.chat(
    [
      {
        role: "system",
        content:
          "You route questions to specialist advisors. Reply with ONLY a JSON " +
          "array of the relevant specialist keys, most relevant first, at most " +
          `${max} entries. Reply with [] if none are relevant.\n\n` +
          routingMenu(),
      },
      { role: "user", content: question },
    ],
    { model: deps.provider.defaultModel, temperature: 0 },
  );

  const keys = parseKeys(raw, max);
  if (keys === null) {
    return { keys: SPECIALIST_KEYS.slice(0, max), fallback: true };
  }
  return { keys, fallback: false };
}

/**
 * Extracts valid specialist keys from a routing reply.
 * Returns null when nothing usable was found, so the caller can fall back.
 */
export function parseKeys(raw: string, max: number): SpecialistKey[] | null {
  // Models wrap JSON in prose or fences often enough that a strict parse is
  // unreliable; find the array and tolerate the surrounding noise.
  const match = raw.match(/\[[\s\S]*?\]/);
  if (!match) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const known = new Set<string>(SPECIALIST_KEYS);
  const keys = parsed
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => known.has(item));

  // Deduplicate while preserving the model's ranking.
  return [...new Set(keys)].slice(0, max) as SpecialistKey[];
}

/**
 * Assembles one specialist's prompt: company context, retrieved reference
 * material, relevant failure cases, then the question.
 *
 * Order matters. Context frames the situation; reference material informs it;
 * failure cases come last before the question so the model reaches the question
 * with the caution freshly in mind rather than buried above it.
 */
export function buildSpecialistPrompt(
  key: SpecialistKey,
  question: string,
  deps: CouncilDeps,
): string {
  const parts: string[] = [];
  if (deps.context) parts.push(deps.context);

  if (deps.db) {
    const domain = specialistDomain(key);

    const reference = renderKnowledge(
      searchKnowledge(deps.db, question, { domain, limit: 3 }),
    );
    if (reference !== '') parts.push(reference);

    const failures = renderFailureCases(
      searchKnowledge(deps.db, question, { domain, kind: 'failure', limit: 2 }),
    );
    if (failures !== '') parts.push(failures);
  }

  parts.push(question);
  return parts.join('\n\n');
}

/** One specialist's take. Failures are contained so one cannot sink the turn. */
export async function consult(
  key: SpecialistKey,
  question: string,
  deps: CouncilDeps,
): Promise<Consultation | null> {
  const specialist = SPECIALISTS[key];

  const messages = [
    { role: 'system' as const, content: specialist.prompt },
    { role: 'user' as const, content: buildSpecialistPrompt(key, question, deps) },
  ];

  try {
    const analysis = await deps.provider.chat(messages);
    return { specialist: key, title: specialist.title, analysis };
  } catch (error) {
    // A specialist that fails must not take the whole answer down; the others
    // still have something useful to say. Logged, never surfaced to the reader.
    const message = error instanceof Error ? error.message : String(error);
    console.error(`specialist ${key} failed: ${message}`);
    return null;
  }
}

/** Full council turn: select, consult in parallel, synthesize. */
export async function convene(
  question: string,
  deps: CouncilDeps,
): Promise<CouncilResult> {
  const { keys, fallback } = await selectSpecialists(question, deps);

  if (keys.length === 0) {
    // Nothing relevant: answer directly rather than inventing expertise.
    const answer = await deps.provider.chat([
      { role: "system", content: SYNTHESIS_PROMPT },
      {
        role: "user",
        content: deps.context
          ? `${deps.context}\n\n---\n\n${question}`
          : question,
      },
    ]);
    return { answer, consultations: [], routedByFallback: false };
  }

  const consultations = (
    await Promise.all(keys.map((key) => consult(key, question, deps)))
  ).filter((result): result is Consultation => result !== null);

  const briefs = consultations
    .map((c) => `## ${c.title}\n${c.analysis}`)
    .join("\n\n");

  const answer = await deps.provider.chat([
    { role: "system", content: SYNTHESIS_PROMPT },
    {
      role: "user",
      content:
        (deps.context ? `${deps.context}\n\n---\n\n` : "") +
        `Question:\n${question}\n\n` +
        `Specialist analyses:\n\n${briefs}`,
    },
  ]);

  return { answer, consultations, routedByFallback: fallback };
}

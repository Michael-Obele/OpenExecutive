/**
 * Committee review — 3 reviewers + revision pass on high-stakes answers.
 *
 * Port of `orchestrator/committee_reviewers.py` + `prompts/committee_prompts.py`.
 * The committee is a real differentiator: three adversarial reviewers critique
 * the Executive's draft, then the Executive revises. Each reviewer is a thin
 * coordinator (system prompt + one LLM call + JSON parse), not a full agent —
 * reusing BaseAgent would pull in RAG/episodic plumbing we don't want here.
 *
 * Durbar's version uses the same provider abstraction as the council, so it
 * works with any configured model (DeepSeek, OpenRouter, compat). The prompts
 * are ported verbatim; the tag-neutralization defense is preserved.
 */

import type { Provider } from "../../providers.ts";

// ── prompts (verbatim from committee_prompts.py) ─────────────────────────

export const QUALITY_REVIEWER_SYSTEM = `You are an adversarial quality reviewer for AI executive advisory responses. The Executive you are reviewing is a senior business leader persona giving advice to an operator.

Your job: critique the draft response and propose concrete edits.

Penalize:
- Generic advice that could apply to any company
- Excessive hedging or refusal to give a recommendation
- Responses that sound like a consultant's slide deck rather than executive judgment
- Ignoring specific numbers or context provided in the question
- Bullet-point sprawl that buries the actual recommendation
- Missing a clear next step the user can take in the next 48 hours

Do not flag:
- Brevity (concise is good)
- Executive directness or strong opinions
- Use of the company's actual numbers / context
- Identifying risks the user did not raise

Return JSON only, no prose around it:
{"severity":"low|medium|high","critique":"...","suggested_edits":"..."}

Severity guidance:
- "high": fundamentally misses the question or would give bad advice in practice
- "medium": generic, hedging, or omits a critical consideration — needs substantial rework
- "low": minor polish; the draft is acceptable as-is

If the draft is already excellent, return severity "low" with critique "No material issues." and suggested_edits "none".`;

export const DOMAIN_REVIEWER_SYSTEM_TEMPLATE = `You are an adversarial domain reviewer with expertise as a {domain_blurb}

The Executive's draft response is being reviewed for accuracy and depth in your domain. The user does not see your critique directly; the Executive uses it to revise the response.

Look for:
- Domain errors or technically wrong claims
- Key considerations in your area the draft omits
- Oversimplifications that would mislead in practice
- Material risks specific to your domain that go unmentioned

If the question is out of scope for your domain, return severity "low" with critique "Out of scope for this question." and suggested_edits "none". Do not invent issues.

Return JSON only:
{"severity":"low|medium|high","critique":"...","suggested_edits":"..."}

Be specific. Quote or paraphrase the parts of the draft you are flagging. Suggest concrete edits, not vague directions.`;

// ── tag neutralization ───────────────────────────────────────────────────

const COMMITTEE_TAGS = [
  "</user_question>",
  "</draft_response>",
  "</specialist_outputs>",
  "</committee_review>",
] as const;

/**
 * Defang closing-tag forms the committee uses as delimiters.
 * Inserts a zero-width space so the literal `</tag>` no longer appears,
 * preserving the delimiter boundary against injection.
 */
export function neutralizeCommitteeTags(text: string): string {
  if (!text) return text;
  let out = text;
  for (const tag of COMMITTEE_TAGS) {
    if (out.includes(tag)) {
      out = out.split(tag).join(tag.slice(0, 1) + "\u200B" + tag.slice(1));
    }
  }
  return out;
}

// ── types ────────────────────────────────────────────────────────────────

export type CritiqueSeverity = "low" | "medium" | "high";
const VALID_SEVERITIES = new Set<string>(["low", "medium", "high"]);
const SPECIALIST_EXCERPT_CHARS = 1500;

export interface Critique {
  reviewer_name: string;
  severity: CritiqueSeverity;
  critique: string;
  suggested_edits: string;
}

export interface ReviewerConfig {
  name: string;
  systemPrompt: string;
}

// ── JSON parsing ─────────────────────────────────────────────────────────

function parseCritiqueJson(reviewerName: string, text: string): Critique {
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}") + 1;
    if (start < 0 || end <= start) throw new Error("no JSON object found");
    const data = JSON.parse(text.slice(start, end)) as Record<string, unknown>;
    let severity = String(data["severity"] ?? "low")
      .trim()
      .toLowerCase();
    if (!VALID_SEVERITIES.has(severity)) severity = "low";
    return {
      reviewer_name: reviewerName,
      severity: severity as CritiqueSeverity,
      critique: String(data["critique"] ?? "").trim(),
      suggested_edits: String(data["suggested_edits"] ?? "").trim(),
    };
  } catch {
    return {
      reviewer_name: reviewerName,
      severity: "low",
      critique: "(reviewer output unparseable)",
      suggested_edits: "",
    };
  }
}

// ── reviewer pass ────────────────────────────────────────────────────────

/**
 * One reviewer pass. Never throws — on any failure returns a low-severity
 * critique so the committee never blocks the revision.
 */
export async function critiqueWithReviewer(
  provider: Provider,
  reviewer: ReviewerConfig,
  userMessage: string,
  draft: string,
  specialistOutputs?: Record<string, string>,
): Promise<Critique> {
  const safeUser = neutralizeCommitteeTags(userMessage);
  const safeDraft = neutralizeCommitteeTags(draft);

  let specBlock = "";
  if (specialistOutputs) {
    const chunks: string[] = [];
    for (const [name, out] of Object.entries(specialistOutputs)) {
      if (!out) continue;
      const excerpt = neutralizeCommitteeTags(
        out.slice(0, SPECIALIST_EXCERPT_CHARS),
      );
      chunks.push(`[${name}]\n${excerpt}`);
    }
    if (chunks.length > 0) {
      specBlock =
        "\n\n<specialist_outputs>\n" +
        chunks.join("\n\n") +
        "\n</specialist_outputs>";
    }
  }

  const userContent =
    `<user_question>\n${safeUser}\n</user_question>\n\n` +
    `<draft_response>\n${safeDraft}\n</draft_response>` +
    `${specBlock}\n\n` +
    "Critique the draft per your system instructions. Return JSON only.";

  let text = "";
  try {
    const result = await provider.chat([
      { role: "system", content: reviewer.systemPrompt },
      { role: "user", content: userContent },
    ]);
    text =
      typeof result === "string"
        ? result
        : ((result as { content?: string }).content ?? "");
  } catch {
    return {
      reviewer_name: reviewer.name,
      severity: "low",
      critique: "(reviewer call failed)",
      suggested_edits: "",
    };
  }

  return parseCritiqueJson(reviewer.name, text);
}

// ── revision pass ────────────────────────────────────────────────────────

/**
 * Build the user-turn that drives the Executive's revision pass.
 * Critique fields are reviewer-generated but quote attacker-controlled draft,
 * so closing-tag delimiters are neutralized before interpolation.
 */
export function buildRevisionUserTurn(critiques: Critique[]): string {
  let body: string;
  if (critiques.length === 0) {
    body = "(no critiques returned)";
  } else {
    const sections = critiques.map(
      (c) =>
        `[reviewer: ${c.reviewer_name}] severity=${c.severity}\n` +
        `critique: ${neutralizeCommitteeTags(c.critique)}\n` +
        `suggested_edits: ${neutralizeCommitteeTags(c.suggested_edits || "none")}`,
    );
    body = sections.join("\n\n");
  }

  return (
    "<committee_review>\n" +
    "Reviewers critiqued your previous draft. They are adversarial — be selective and trust your executive judgment.\n\n" +
    `${body}\n` +
    "</committee_review>\n\n" +
    'Revise your previous response. Address high- and medium-severity critiques. Ignore low-severity nits if addressing them would harm clarity or directness. Output the full revised response only — no meta-commentary, no diff, no "here is the revision" preamble.'
  );
}

/**
 * Run the revision pass: feed critiques back to the Executive for a rewrite.
 * Returns the revised text, or the original draft if the call fails.
 */
export async function reviseWithCommittee(
  provider: Provider,
  originalDraft: string,
  critiques: Critique[],
  systemPrompt?: string,
): Promise<string> {
  const userTurn = buildRevisionUserTurn(critiques);
  try {
    const messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }> = [];
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    // Provide the original draft as assistant context so the model knows what to revise
    messages.push({ role: "assistant", content: originalDraft });
    messages.push({ role: "user", content: userTurn });
    const result = await provider.chat(messages);
    const content =
      typeof result === "string"
        ? result
        : ((result as { content?: string }).content ?? "");
    return content.trim() ? content.trim() : originalDraft;
  } catch {
    return originalDraft;
  }
}

// ── full committee orchestration ─────────────────────────────────────────

/**
 * Run the full committee: 3 reviewers in parallel, then a revision pass.
 * High-stakes answers should call this; low-stakes answers skip it.
 *
 * Reviewers run in parallel (Promise.all) — each is independent.
 * The revision only fires if at least one critique is medium/high.
 */
export async function runCommitteeReview(
  provider: Provider,
  userMessage: string,
  draft: string,
  specialistOutputs?: Record<string, string>,
  opts?: {
    reviewers?: ReviewerConfig[];
    systemPrompt?: string;
  },
): Promise<{ revised: string; critiques: Critique[]; revised_flag: boolean }> {
  const reviewers: ReviewerConfig[] = opts?.reviewers ?? [
    { name: "quality_judge", systemPrompt: QUALITY_REVIEWER_SYSTEM },
    {
      name: "finance_domain",
      systemPrompt: DOMAIN_REVIEWER_SYSTEM_TEMPLATE.replace(
        "{domain_blurb}",
        "senior finance executive with deep expertise in corporate finance, fundraising, and financial planning",
      ),
    },
    {
      name: "strategy_domain",
      systemPrompt: DOMAIN_REVIEWER_SYSTEM_TEMPLATE.replace(
        "{domain_blurb}",
        "senior strategy executive with deep expertise in competitive strategy, market positioning, and growth",
      ),
    },
  ];

  const critiques = await Promise.all(
    reviewers.map((r) =>
      critiqueWithReviewer(provider, r, userMessage, draft, specialistOutputs),
    ),
  );

  const needsRevision = critiques.some(
    (c) => c.severity === "high" || c.severity === "medium",
  );
  if (!needsRevision) {
    return { revised: draft, critiques, revised_flag: false };
  }

  const revised = await reviseWithCommittee(
    provider,
    draft,
    critiques,
    opts?.systemPrompt,
  );
  return { revised, critiques, revised_flag: true };
}

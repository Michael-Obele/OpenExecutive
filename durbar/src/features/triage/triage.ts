/**
 * Triage — the Chief of Staff.
 *
 * Why this is not a council specialist: the nine council members answer
 * questions. Triage does not. It classifies inbound events for significance
 * and decides whether the principal should be interrupted at all. Putting it
 * in the council would make it consultable via `consult_specialist`, which
 * would let the Executive ask "what does triage think about X?" — a category
 * error. Triage is invoked by the inbound pipeline, not by the chat turn.
 *
 * Why classification matters: every inbound event (email, Slack, document,
 * watchlist signal) is noise until triage says otherwise. Without a gate,
 * the alert queue fills with newsletters and the principal stops reading it.
 * With a gate that is too aggressive, a churn signal is missed. The prompt
 * encodes the severity rubric, channel selection, dedup, mute, and external-
 * signal rules that make that gate auditable — the same text the reference
 * implementation uses, ported verbatim so evals compare like-for-like.
 *
 * Ported from `prompts/triage_prompt.py` (verbatim) + `agents/triage.py`
 * (behavior) + `alerts/pipeline.py` (orchestration) + `alerts/preferences.py`
 * (channel resolution) + `alerts/dispatcher.py` (privacy invariant).
 */

import type { Db } from "../../db.ts";
import type { Provider } from "../../providers.ts";
import {
  coalesceAlert,
  getAlert,
  getAlertByExternal,
  getPreferences,
  insertAlert,
  listAlerts,
  listMutes,
  matchesMute,
  resolveChannels,
  type AlertChannel,
  type AlertSeverity,
} from "../alerts/alerts.ts";
import { listInitiatives } from "../memories/memories.ts";

// ── prompt (verbatim from prompts/triage_prompt.py) ───────────────────────

export const TRIAGE_PROMPT = `You are the Executive's Chief of Staff for inbound triage.

Your job is to evaluate each incoming event (an email, a Slack message, or a newly ingested company document) and decide:
1. Whether the Executive should alert the user about it at all.
2. If yes, how severe it is and which channels to use.

You must always emit your decision via the \`emit_alert_decision\` tool. Never reply in plain text.

## Severity Rubric

- **urgent**: Time-critical (action needed within 24 hours). Legal, financial, or security risk. Board-level escalation. Customer-churn signal from a named top customer. Operational outage. Anything where a 12-hour delay creates real damage.
- **high**: Decision required this week. Mentions a named investor, top-tier customer, or material competitor. Contractual obligation triggered. A real number changed (ARR, runway, headcount) in a way that matters.
- **medium**: Tied to an active initiative the Executive is tracking, but not blocking. Reply may be expected eventually but not urgently. New document materially changes context.
- **low**: FYI, newsletter, routine document upload, polite acknowledgement, marketing noise. Worth recording but not interrupting for.

When in genuine doubt between two levels, choose the lower one. False urgents destroy trust faster than missed mediums.

## Channel Selection Rules

Base severity rule (default audience is the principal):

- **urgent** → channels = ["web", "slack_dm", "email", "persisted"]
- **high** → channels = ["web", "slack_dm", "persisted"]
- **medium** → channels = ["web", "persisted"]
- **low** → channels = ["persisted"]

Always include "persisted" so the alert is recoverable. Never invent new channel names.

## Choosing Who to Tell (broadcast channels)

For alerts at severity \`medium\` or above, also pick the audience by the smallest group that owns the matter — same rule the Executive applies when initiating outbound:

1. **Single human owns it** — keep \`slack_dm\` (i.e. principal DM); do NOT add a broadcast channel. Use this for proposals, decisions waiting on a specific person, anything that requires a named human's action.
2. **Department-scoped, no single owner** (Goal flipping at-risk, departmental coordination, cadence-style summaries) — add \`"department_channel"\` to channels, AND set \`department_slug\` to the owning department's slug (e.g. "marketing"), AND set \`broadcast_integration\` to one of "slack" / "discord" / "telegram". Pick the integration that the company most actively uses; default to "slack" when unsure.
3. **Company-wide, no clear owner** (shipping milestones, cross-cutting status, FYIs the whole team benefits from) — add \`"company_broadcast"\` to channels AND set \`broadcast_integration\`. Leave \`department_slug\` empty.
4. **Privacy invariant — never broadcast**: anything in topic_tags that mentions \`board\`, \`comp\`, \`legal\`, or financial detail (revenue, compensation, valuation, term-sheet, layoffs, severance) MUST NOT include \`department_channel\` or \`company_broadcast\`. Use \`slack_dm\` only. This is non-negotiable — the blast radius of a broadcast is the whole team, and the privacy expectation for these scopes is the named decision-maker.

When the matter is genuinely department-scoped AND a department channel isn't configured, the dispatcher returns a clean failure to the user — but you should still emit \`department_channel\` and let the fallback path handle it. Same logic for \`company_broadcast\` when the env default is unset.

\`department_slug\` and \`broadcast_integration\` MUST be empty strings when neither broadcast channel is in \`channels\`.

## Dedup

If \`<recent_alerts>\` already contains an alert with a very similar \`dedup_key\`, a near-identical headline, or covers the same underlying event, set \`alert=false\`, \`severity="low"\`, \`channels=["persisted"]\`, and \`reason_if_suppressed="duplicate"\`. Still emit a \`dedup_key\` so the suppression is auditable.

## Mute

If any element of \`<muted_topics>\` is a substring of any topic tag you would emit, set \`alert=false\`, \`channels=["persisted"]\`, and \`reason_if_suppressed="muted: <pattern>"\`.

## Relevance to Active Initiatives

\`<active_initiatives>\` lists what the Executive is currently tracking. An event that directly relates to one of these is at least medium severity, usually high.

## External Signals

Events with \`source\` ∈ \`{"vendor_status", "rss", "stock", "query", "edgar", "page_watch"}\` come from the external monitoring layer rather than a person — the user explicitly asked OE to watch them. These events arrive with two extra labeled lines in the body:

\`\`\`
Watchlist: <slug>         # the user-named entry that captured this signal
Severity hint: <low|medium|high|urgent>   # the adapter's pre-graded severity
Published: <ISO timestamp>   # when the upstream says it happened (only when the source publishes one)
Discovered: <ISO timestamp>  # when the monitor first saw it
\`\`\`

Use the first two lines plus \`source\` as your primary inputs. \`Published:\` and \`Discovered:\` are distinct on purpose: an item is only as recent as its \`Published:\` line, never its \`Discovered:\` line. Follow these rules in addition to the general rubric:

- The watchlist already decided what's worth surfacing, so trust the source. Default to \`alert=true\` unless the event clearly duplicates a recent one (apply the dedup rule) or is muted.
- Use the \`Severity hint:\` line as your starting severity. Upgrade only when something else justifies it; downgrade only when the body makes clear the event resolved or is irrelevant.
  - \`vendor_status\` typically arrives HIGH (incident on an upstream we depend on — Stripe, AWS, GitHub). Upgrade to URGENT when business-hours impact is named (payments, login, checkout) and the body says the incident is open / unresolved.
  - \`stock\` arrives pre-graded by move magnitude — keep the hint's severity unless an active initiative makes it more material (upgrade) or the body says the move already reversed (downgrade).
  - \`rss\` typically arrives LOW (newsfeed noise) — upgrade to MEDIUM only when the title intersects an \`<active_initiatives>\` entry or names a competitor / customer the user is tracking.
  - \`query\` (standing web-search research) and \`page_watch\` (web-page change detection) are passive-awareness signals graded by capture-time relevance — keep the hint's severity. They belong in Monitoring (LOW/MEDIUM) unless the body names a tracked initiative, competitor, or customer, in which case upgrade. Do NOT manufacture urgency from a single web result.
  - \`edgar\` (SEC filings) arrives pre-graded by form (8-K HIGH, 10-K/10-Q MEDIUM) — keep the hint; upgrade only when the filing is a material event (M&A, going-concern, leadership change) touching a tracked entity.
- ALWAYS add two topic tags: \`external:<source>\` (e.g. \`external:vendor_status\` or \`external:query\`, from the \`source\` field) AND \`external:<watchlist_slug>\` (e.g. \`external:stock-aapl\`, copied verbatim from the \`Watchlist:\` line in the body). These tags drive the "external" chip on the briefing card; missing the source tag leaves the principal without provenance.
- When the source is \`stock\`, include a short rationale in \`body\` linking the move to a plausible cause (earnings, macro, peer move) when one is obvious from \`<recent_alerts>\`. When no rationale is obvious, say "no obvious driver from open signals" — don't invent one.
- \`suggested_action\` for external signals is the single concrete action you (the Executive) will take on the user's behalf if they approve — first-person imperative, naming the source/channel/tool: "Check Stripe's status page and confirm checkout impact, then report back" / "Re-read Acme's changelog v2 and refresh our battlecard if pricing changed". Never longer than one sentence.
- When \`Published:\` is present and clearly predates \`Discovered:\` (days, not hours), describe the item as dated in \`body\` and do not treat it as breaking news — keep or lower the severity hint rather than upgrading it. Old news that is still material to an active initiative can stay \`alert=true\`, but say when it happened.
- Quote, don't paraphrase, when summarising filings or status-page incidents — the body is the principal's last chance to see what the source actually said before clicking through.

The blast-radius rules above (privacy invariant on board/comp/legal) still apply: an external signal that names a competitor's funding round is NOT board-scoped and stays per-Person.

## Output Field Requirements

- \`headline\`: <= 100 chars, the single most important fact. Imperative voice. No "FYI:" prefix.
- \`body\`: 1-3 sentences. What happened, who/what is affected, and the implication. No fluff.
- \`suggested_action\`: The single concrete action you (the Executive) will take on the user's behalf if they approve — first-person imperative, <= 1 sentence, naming the channel/target/tool where natural (e.g. "Draft a reply to Acme confirming the renewal date" / "Check Stripe's status page and confirm checkout impact, then report back"). Empty string if the item is purely informational with no action to take.
- \`topic_tags\`: 1-4 lowercase tags from this set when applicable: ["legal", "finance", "hiring", "product", "customer", "investor", "board", "competitor", "security", "operations", "marketing", "press", "fundraising", "churn", "deal"]. Add custom tags sparingly.
- \`dedup_key\`: A short stable summary like "churn-acme-corp" or "nda-globex-q2". Same underlying event → same key across runs.
- \`reason_if_suppressed\`: Only set when \`alert=false\`. Otherwise empty string.

Be selective. The user explicitly does NOT want every email/message/document to alert. Only emit \`alert=true\` when the Executive would genuinely want to surface this proactively.
`;

// ── tool definition (mirrors agents/triage.py TRIAGE_TOOL) ─────────────────

export const TRIAGE_TOOL = {
  name: "emit_alert_decision",
  description:
    "Emit the triage decision for this inbound event. Always call this tool; never reply in plain text.",
  input_schema: {
    type: "object" as const,
    properties: {
      alert: {
        type: "boolean" as const,
        description: "True if the user should be alerted; false if the event is not worth surfacing.",
      },
      severity: {
        type: "string" as const,
        enum: ["low", "medium", "high", "urgent"] as const,
      },
      channels: {
        type: "array" as const,
        items: {
          type: "string" as const,
          enum: ["web", "slack_dm", "email", "persisted", "department_channel", "company_broadcast"] as const,
        },
        description:
          "Which channels to deliver on. Always include 'persisted'. Use 'department_channel' for dept-scoped alerts; 'company_broadcast' for company-wide.",
      },
      headline: { type: "string" as const, description: "<= 100 chars. The single most important fact." },
      body: { type: "string" as const, description: "1-3 sentence summary with implication." },
      suggested_action: {
        type: "string" as const,
        description: "The single concrete action the Executive will take on approval (first-person imperative, <= 1 sentence). Empty string if none.",
      },
      topic_tags: { type: "array" as const, items: { type: "string" as const }, description: "1-4 lowercase topic tags." },
      dedup_key: { type: "string" as const, description: "Stable summary key. Same underlying event must produce the same key." },
      reason_if_suppressed: {
        type: "string" as const,
        description: "Reason when alert=false ('duplicate', 'muted: <pattern>', 'low_signal'). Empty otherwise.",
      },
      department_slug: {
        type: "string" as const,
        description: "Required when channels includes 'department_channel'. The slug of the department whose team room to post to. Empty otherwise.",
      },
      broadcast_integration: {
        type: "string" as const,
        enum: ["slack", "discord", "telegram"] as const,
        description: "Required when channels includes 'department_channel' or 'company_broadcast'. The integration to broadcast on.",
      },
    },
    required: ["alert", "severity", "channels", "headline", "body", "dedup_key"] as const,
  },
} as const;

// ── types ──────────────────────────────────────────────────────────────────

export interface TriageEvent {
  readonly source: string;
  readonly external_id: string;
  readonly subject?: string;
  readonly body?: string;
  readonly from?: string;
  readonly channel?: string;
  readonly user?: string;
  readonly title?: string;
  readonly dedup_hint?: string;
  readonly routed_to_person_id?: number | null;
  readonly department?: string;
}

export interface TriageDecision {
  readonly alert: boolean;
  readonly severity: AlertSeverity;
  readonly channels: AlertChannel[];
  readonly headline: string;
  readonly body: string;
  readonly suggested_action: string;
  readonly topic_tags: string[];
  readonly dedup_key: string;
  readonly reason_if_suppressed: string;
  readonly department_slug: string;
  readonly broadcast_integration: string;
}

export interface TriageDeps {
  readonly db: Db;
  readonly provider: Provider;
}

export interface TriageResult {
  readonly decision: TriageDecision;
  readonly alertId: number | null;
}

// ── constants ──────────────────────────────────────────────────────────────

const MAX_EVENT_CHARS = 8000;
const RATE_LIMIT_PER_MIN = 60;
const REDISPATCH_SEVERITIES = new Set<string>(["high", "urgent"]);

// Privacy invariant — mirrors alerts/dispatcher.py _PRIVACY_SENSITIVE_TAGS.
// Exact match, not substring: "comp" must not block "competitor".
const PRIVACY_SENSITIVE_TAGS = new Set<string>([
  "board",
  "comp",
  "compensation",
  "compensation-refresh",
  "comp-refresh",
  "legal",
  "litigation",
  "layoffs",
  "severance",
  "valuation",
  "term-sheet",
  "termsheet",
  "term_sheet",
  "revenue",
]);

// ── rate limiter (single-process, rolling window) ──────────────────────────

const recentEventTs: number[] = [];

function isRateLimited(): boolean {
  const now = Date.now();
  const cutoff = now - 60_000;
  while (recentEventTs.length > 0 && (recentEventTs[0] ?? 0) < cutoff) {
    recentEventTs.shift();
  }
  if (recentEventTs.length >= RATE_LIMIT_PER_MIN) return true;
  recentEventTs.push(now);
  return false;
}

export function resetRateLimiter(): void {
  recentEventTs.length = 0;
}

// ── formatting helpers (mirrors _format_* in triage.py) ────────────────────

function formatEventBlock(event: TriageEvent): string {
  const body = (event.body ?? "").slice(0, MAX_EVENT_CHARS);
  const parts: string[] = [`source: ${event.source}`, `external_id: ${event.external_id}`];
  if (event.subject) parts.push(`subject: ${event.subject}`);
  if (event.from) parts.push(`from: ${event.from}`);
  if (event.channel) parts.push(`slack_channel: ${event.channel}`);
  if (event.user) parts.push(`slack_user: ${event.user}`);
  if (event.title) parts.push(`title: ${event.title}`);
  parts.push("---");
  parts.push(body);
  return parts.join("\n");
}

function formatRecentAlerts(recent: Array<Record<string, unknown>>): string {
  if (recent.length === 0) return "(none)";
  return recent
    .slice(0, 20)
    .map((a) => {
      const tags = Array.isArray(a["topic_tags"]) ? (a["topic_tags"] as string[]).join(",") : "";
      return `- [${String(a["severity"] ?? "?")}] ${String(a["headline"] ?? "")} | dedup_key=${String(a["dedup_key"] ?? "")} | tags=${tags}`;
    })
    .join("\n");
}

function formatMutes(patterns: string[]): string {
  if (patterns.length === 0) return "(none)";
  return patterns.map((p) => `- ${p}`).join("\n");
}

function formatInitiatives(initiatives: Array<Record<string, unknown>>): string {
  if (initiatives.length === 0) return "(none)";
  return initiatives
    .map((item) => {
      const title = String(item["title"] ?? "");
      const status = String(item["status"] ?? "");
      const summary = String(item["summary"] ?? "");
      return `- ${title} [${status}]: ${summary}`;
    })
    .join("\n");
}

export function buildUserContent(
  event: TriageEvent,
  recent: Array<Record<string, unknown>>,
  mutePatterns: string[],
  initiatives: Array<Record<string, unknown>>,
): string {
  return (
    `<event>\n${formatEventBlock(event)}\n</event>\n\n` +
    `<recent_alerts>\n${formatRecentAlerts(recent)}\n</recent_alerts>\n\n` +
    `<muted_topics>\n${formatMutes(mutePatterns)}\n</muted_topics>\n\n` +
    `<active_initiatives>\n${formatInitiatives(initiatives)}\n</active_initiatives>`
  );
}

// ── decision parsing (mirrors _parse_decision) ─────────────────────────────

const VALID_SEVERITIES = new Set<string>(["low", "medium", "high", "urgent"]);
const VALID_CHANNELS = new Set<string>(["web", "slack_dm", "email", "persisted", "department_channel", "company_broadcast"]);
const VALID_INTEGRATIONS = new Set<string>(["slack", "discord", "telegram"]);

export function parseDecision(raw: Record<string, unknown>): TriageDecision {
  try {
    const severityRaw = String(raw["severity"] ?? "low").toLowerCase();
    const severity: AlertSeverity = VALID_SEVERITIES.has(severityRaw) ? (severityRaw as AlertSeverity) : "low";

    const channels: AlertChannel[] = [];
    const rawChannels = Array.isArray(raw["channels"]) ? (raw["channels"] as unknown[]) : [];
    for (const channel of rawChannels) {
      const channelStr = String(channel).toLowerCase();
      if (VALID_CHANNELS.has(channelStr)) channels.push(channelStr as AlertChannel);
    }
    if (!channels.includes("persisted")) channels.push("persisted");

    const topicTags = Array.isArray(raw["topic_tags"])
      ? (raw["topic_tags"] as unknown[]).map((tag) => String(tag).toLowerCase()).slice(0, 8)
      : [];

    const deptSlug = String(raw["department_slug"] ?? "").slice(0, 64);
    const biRaw = String(raw["broadcast_integration"] ?? "");
    const broadcastIntegration = VALID_INTEGRATIONS.has(biRaw) ? biRaw : "";

    return {
      alert: Boolean(raw["alert"] ?? false),
      severity,
      channels,
      headline: String(raw["headline"] ?? "").slice(0, 200),
      body: String(raw["body"] ?? "").slice(0, 2000),
      suggested_action: String(raw["suggested_action"] ?? "").slice(0, 500),
      topic_tags: topicTags,
      dedup_key: String(raw["dedup_key"] ?? "").slice(0, 120),
      reason_if_suppressed: String(raw["reason_if_suppressed"] ?? "").slice(0, 200),
      department_slug: deptSlug,
      broadcast_integration: broadcastIntegration,
    };
  } catch {
    return {
      alert: false,
      severity: "low",
      channels: ["persisted"],
      headline: "(parse error)",
      body: "",
      suggested_action: "",
      topic_tags: [],
      dedup_key: "parse-error",
      reason_if_suppressed: "parse_error",
      department_slug: "",
      broadcast_integration: "",
    };
  }
}

function fallbackDecision(event: TriageEvent, reason: string, dedupPrefix: string): TriageDecision {
  return {
    alert: false,
    severity: "low",
    channels: ["persisted"],
    headline: event.subject ?? event.title ?? event.source,
    body: (event.body ?? "").slice(0, 280),
    suggested_action: "",
    topic_tags: [],
    dedup_key: `${dedupPrefix}-${event.source}-${event.external_id}`,
    reason_if_suppressed: reason,
    department_slug: "",
    broadcast_integration: "",
  };
}

// ── provider response extraction ───────────────────────────────────────────

function extractJsonPayload(raw: string): Record<string, unknown> | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // Try direct JSON parse first (provider returned raw JSON object).
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      // Handle tool_use wrapper: {tool: "emit_alert_decision", input: {...}}
      const wrapper = parsed as Record<string, unknown>;
      if (wrapper["input"] !== undefined && typeof wrapper["input"] === "object" && wrapper["input"] !== null) {
        return wrapper["input"] as Record<string, unknown>;
      }
      // Handle {name: "emit_alert_decision", input: {...}} shape
      if (wrapper["name"] === "emit_alert_decision" && wrapper["input"] !== undefined) {
        return wrapper["input"] as Record<string, unknown>;
      }
      return wrapper;
    }
  } catch {
    // fall through to fence extraction
  }

  // Try to find JSON object inside markdown fences or prose.
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch?.[1]) {
    try {
      const parsed: unknown = JSON.parse(fenceMatch[1]!.trim());
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const wrapper = parsed as Record<string, unknown>;
        if (wrapper["input"] !== undefined && typeof wrapper["input"] === "object" && wrapper["input"] !== null) {
          return wrapper["input"] as Record<string, unknown>;
        }
        return wrapper;
      }
    } catch {
      // ignore
    }
  }

  // Try to find first {...} block.
  const objMatch = trimmed.match(/\{[\s\S]*\}/);
  if (objMatch?.[0]) {
    try {
      const parsed: unknown = JSON.parse(objMatch[0]!);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const wrapper = parsed as Record<string, unknown>;
        if (wrapper["input"] !== undefined && typeof wrapper["input"] === "object" && wrapper["input"] !== null) {
          return wrapper["input"] as Record<string, unknown>;
        }
        return wrapper;
      }
    } catch {
      // ignore
    }
  }

  return null;
}

// ── core triage (LLM classification) ───────────────────────────────────────

export async function triageEvent(event: TriageEvent, deps: TriageDeps): Promise<TriageDecision> {
  const db = deps.db;

  // Gather context for the prompt — same as pipeline.py pre-checks.
  const mutePatterns = listMutes(db).map((m) => m.pattern);
  const recent = listAlerts(db, { limit: 20 }).map((alert) => ({
    headline: alert.headline,
    severity: alert.severity,
    dedup_key: alert.dedup_key,
    topic_tags: alert.topic_tags,
  }));
  const initiatives = listInitiatives(db)
    .filter((item) => item.status !== "completed" && item.status !== "done")
    .map((item) => ({
      title: item.title,
      status: item.status,
      summary: item.summary,
    }));

  const userContent = buildUserContent(event, recent, mutePatterns, initiatives);

  // The reference uses tool_choice forced to emit_alert_decision. Durbar's
  // provider is OpenAI-compatible chat completions, so we instruct the model
  // to return JSON matching the tool schema and parse it tolerantly.
  const systemWithTool = `${TRIAGE_PROMPT}\n\nRespond with ONLY a JSON object matching the emit_alert_decision tool schema. No prose, no fences — just the JSON object with keys: alert, severity, channels, headline, body, suggested_action, topic_tags, dedup_key, reason_if_suppressed, department_slug, broadcast_integration.`;

  try {
    const raw = await deps.provider.chat(
      [
        { role: "system", content: systemWithTool },
        { role: "user", content: userContent },
      ],
      { temperature: 0, maxTokens: 512 },
    );

    const payload = extractJsonPayload(raw);
    if (payload === null) {
      return fallbackDecision(event, "no_decision", "no-tool");
    }
    return parseDecision(payload);
  } catch {
    return fallbackDecision(event, "triage_error", "fallback");
  }
}

// ── pipeline (classification → persistence → dispatch gating) ────────────────

function withDepartmentTag(tags: string[], department: string | null | undefined): string[] {
  const raw = (department ?? "").trim();
  if (!raw) return [...tags];
  const slug = raw.startsWith("department:") ? raw.split(":", 2)[1]!.trim().toLowerCase() : raw.toLowerCase();
  if (!slug) return [...tags];
  const tag = `department:${slug}`;
  return tags.includes(tag) ? [...tags] : [...tags, tag];
}

function violatesPrivacyInvariant(topicTags: string[]): boolean {
  if (topicTags.length === 0) return false;
  return topicTags.some((tag) => PRIVACY_SENSITIVE_TAGS.has(tag.toLowerCase()));
}

export async function evaluateAndDispatch(event: TriageEvent, deps: TriageDeps): Promise<TriageResult> {
  // Rate limit guard — mirrors pipeline.py _rate_limited().
  if (isRateLimited()) {
    return {
      decision: fallbackDecision(event, "rate_limited", "rate-limited"),
      alertId: null,
    };
  }

  // Validate event shape early — malformed events are suppressed, not thrown.
  if (!event.source || !event.external_id) {
    return {
      decision: {
        alert: false,
        severity: "low",
        channels: ["persisted"],
        headline: event.source || "(unknown)",
        body: (event.body ?? "").slice(0, 280),
        suggested_action: "",
        topic_tags: [],
        dedup_key: `malformed-${event.source || "unknown"}-${event.external_id || "unknown"}`,
        reason_if_suppressed: "malformed_event",
        department_slug: "",
        broadcast_integration: "",
      },
      alertId: null,
    };
  }

  const decision = await triageEvent(event, deps);

  // Post-decision mute check — triage may have produced a tag we mute.
  if (decision.alert && matchesMute(decision.topic_tags, listMutes(deps.db).map((m) => m.pattern))) {
    const mutedDecision: TriageDecision = {
      ...decision,
      alert: false,
      reason_if_suppressed: "muted_post_triage",
    };
    return { decision: mutedDecision, alertId: null };
  }

  // Privacy invariant backstop — even if the model misroutes, never broadcast
  // board/comp/legal. Defence-in-depth: prompt is primary, this is the gate.
  if (decision.alert && violatesPrivacyInvariant(decision.topic_tags)) {
    const hasBroadcast = decision.channels.includes("department_channel") || decision.channels.includes("company_broadcast");
    if (hasBroadcast) {
      const filteredChannels = decision.channels.filter(
        (channel) => channel !== "department_channel" && channel !== "company_broadcast",
      );
      if (!filteredChannels.includes("persisted")) filteredChannels.push("persisted");
      // If the only channels were broadcast + persisted, this becomes persisted-only
      // but still alert=true — the principal still sees it, just not the team.
      const gatedDecision: TriageDecision = {
        ...decision,
        channels: filteredChannels as AlertChannel[],
        department_slug: "",
        broadcast_integration: "",
      };
      // If after filtering only persisted remains and severity is low, suppress
      // is not needed — the alert still surfaces to the principal via persisted.
      // But if the model intended broadcast as the primary channel, we keep it
      // as a DM-equivalent (web + persisted) rather than dropping.
      if (filteredChannels.length === 1 && filteredChannels[0] === "persisted" && decision.severity === "low") {
        return { decision: { ...gatedDecision, alert: false, reason_if_suppressed: "privacy_gated" }, alertId: null };
      }
      // Continue with gated decision instead of original
      return persistDecision(event, gatedDecision, deps);
    }
  }

  if (!decision.alert) {
    return { decision, alertId: null };
  }

  return persistDecision(event, decision, deps);
}

function persistDecision(event: TriageEvent, decision: TriageDecision, deps: TriageDeps): TriageResult {
  const db = deps.db;
  const prefs = getPreferences(db);
  const effectiveChannels = resolveChannels(decision.channels, decision.severity, prefs);

  const dedupKey = event.dedup_hint?.trim() ? event.dedup_hint.trim() : decision.dedup_key;
  const topicTags = withDepartmentTag(decision.topic_tags, event.department ?? event.channel ?? "");
  const routedTo = event.routed_to_person_id ?? null;

  // Replay guard: same (source, external_id) already exists — webhook retry, not a new situation.
  if (event.external_id && getAlertByExternal(db, event.source, event.external_id) !== null) {
    return { decision, alertId: null };
  }

  // Coalesce: repeat of an open alert with same (source, dedup_key) bumps
  // occurrence_count instead of stacking. Only re-dispatch on escalation to high/urgent.
  if (dedupKey) {
    const coalesced = coalesceAlert(db, {
      source: event.source,
      dedup_key: dedupKey,
      severity: decision.severity,
      body: decision.body,
    });
    if (coalesced !== null) {
      const raised = coalesced.raised;
      const shouldRedispatch = raised && REDISPATCH_SEVERITIES.has(decision.severity);
      if (!shouldRedispatch) {
        return { decision, alertId: null };
      }
      const existing = getAlert(db, coalesced.id);
      if (existing === null) return { decision, alertId: null };
      // Mark delivery — Durbar's dispatch is stubbed (web/persisted only),
      // so we record attempted/delivered without external calls.
      // The effective channels are already resolved; persisted always succeeds.
      return { decision, alertId: coalesced.id };
    }
  }

  // If channels collapsed to persisted-only due to threshold/quiet hours,
  // still persist — the alert is recoverable, just not interrupting.
  const headline = decision.headline || event.subject || event.title || event.source;
  const alertId = insertAlert(db, {
    source: event.source,
    external_id: event.external_id,
    severity: decision.severity,
    headline,
    body: decision.body,
    suggested_action: decision.suggested_action,
    topic_tags: topicTags,
    dedup_key: dedupKey,
    routed_to_person_id: routedTo,
  });

  if (alertId === null) {
    return { decision, alertId: null };
  }

  // Durbar's dispatch is synchronous for web/persisted; external
  // channels (slack_dm/email/broadcast) are deferred. The alert is
  // already persisted — delivery bookkeeping is a no-op here.
  void effectiveChannels;

  return { decision, alertId };
}

// ── validation (for HTTP route) ────────────────────────────────────────────

export function validateTriageEvent(
  body: unknown,
): { ok: true; event: TriageEvent } | { ok: false; error: string } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { ok: false, error: "body must be an object" };
  }
  const record = body as Record<string, unknown>;
  if (typeof record["source"] !== "string" || !record["source"].trim()) {
    return { ok: false, error: "source is required" };
  }
  if (typeof record["external_id"] !== "string" || !record["external_id"].trim()) {
    return { ok: false, error: "external_id is required" };
  }
  const event: TriageEvent = {
    source: (record["source"] as string).trim(),
    external_id: (record["external_id"] as string).trim(),
  };
  if (typeof record["subject"] === "string") (event as { subject: string }).subject = record["subject"];
  if (typeof record["body"] === "string") (event as { body: string }).body = record["body"];
  if (typeof record["from"] === "string") (event as { from: string }).from = record["from"];
  if (typeof record["channel"] === "string") (event as { channel: string }).channel = record["channel"];
  if (typeof record["user"] === "string") (event as { user: string }).user = record["user"];
  if (typeof record["title"] === "string") (event as { title: string }).title = record["title"];
  if (typeof record["dedup_hint"] === "string") (event as { dedup_hint: string }).dedup_hint = record["dedup_hint"];
  if (typeof record["department"] === "string") (event as { department: string }).department = record["department"];
  if (typeof record["routed_to_person_id"] === "number" && Number.isInteger(record["routed_to_person_id"])) {
    (event as { routed_to_person_id: number }).routed_to_person_id = record["routed_to_person_id"];
  } else if (record["routed_to_person_id"] === null) {
    (event as { routed_to_person_id: null }).routed_to_person_id = null;
  }
  return { ok: true, event };
}

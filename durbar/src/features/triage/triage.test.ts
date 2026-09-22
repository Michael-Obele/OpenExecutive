/**
 * Spec for triage — the Chief of Staff.
 *
 * Ported from `tests/unit/test_triage_agent.py` (prompt context, decision
 * parsing, fallback) + `tests/unit/test_alerts_pipeline.py` (pipeline rules:
 * mute, dedup, coalescing, routing, replay guard, rate limit) +
 * `tests/unit/test_alerts_broadcast_dispatch.py` (privacy invariant).
 *
 * Uses a fake provider so no network call is made; the DB is :memory:.
 * Every test verifies what its name claims — no tautologies.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import type { Provider } from "../../providers.ts";
import { insertAlert, addMute, getAlert } from "../alerts/alerts.ts";
import { insertInitiative } from "../memories/memories.ts";
import {
  buildUserContent,
  evaluateAndDispatch,
  parseDecision,
  resetRateLimiter,
  triageEvent,
  TRIAGE_PROMPT,
  TRIAGE_TOOL,
  validateTriageEvent,
  type TriageEvent,
} from "./triage.ts";

// ── helpers ────────────────────────────────────────────────────────────────

function fakeProvider(response: string): Provider {
  return {
    name: "fake",
    defaultModel: "fake-model",
    async chat(): Promise<string> {
      return response;
    },
  };
}

function throwingProvider(): Provider {
  return {
    name: "fake",
    defaultModel: "fake-model",
    async chat(): Promise<string> {
      throw new Error("provider down");
    },
  };
}

function jsonDecision(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    alert: true,
    severity: "high",
    channels: ["web", "slack_dm", "persisted"],
    headline: "Test headline",
    body: "Test body with implication.",
    suggested_action: "Draft a reply",
    topic_tags: ["customer"],
    dedup_key: "test-key",
    reason_if_suppressed: "",
    department_slug: "",
    broadcast_integration: "",
    ...overrides,
  });
}

// ── TRIAGE_PROMPT ──────────────────────────────────────────────────────────

describe("TRIAGE_PROMPT", () => {
  test("contains the severity rubric", () => {
    expect(TRIAGE_PROMPT).toContain("## Severity Rubric");
    expect(TRIAGE_PROMPT).toContain("urgent");
    expect(TRIAGE_PROMPT).toContain("high");
    expect(TRIAGE_PROMPT).toContain("medium");
    expect(TRIAGE_PROMPT).toContain("low");
  });

  test("contains channel selection rules", () => {
    expect(TRIAGE_PROMPT).toContain("## Channel Selection Rules");
    expect(TRIAGE_PROMPT).toContain("persisted");
  });

  test("contains dedup and mute sections", () => {
    expect(TRIAGE_PROMPT).toContain("## Dedup");
    expect(TRIAGE_PROMPT).toContain("## Mute");
    expect(TRIAGE_PROMPT).toContain("recent_alerts");
    expect(TRIAGE_PROMPT).toContain("muted_topics");
  });

  test("contains external signals section covering all adapter sources", () => {
    expect(TRIAGE_PROMPT).toContain("## External Signals");
    for (const source of [
      "vendor_status",
      "rss",
      "stock",
      "query",
      "edgar",
      "page_watch",
    ]) {
      expect(TRIAGE_PROMPT).toContain(source);
    }
  });

  test("contains privacy invariant", () => {
    expect(TRIAGE_PROMPT).toContain("Privacy invariant");
    expect(TRIAGE_PROMPT).toContain("board");
    expect(TRIAGE_PROMPT).toContain("comp");
    expect(TRIAGE_PROMPT).toContain("legal");
  });

  test("contains output field requirements", () => {
    expect(TRIAGE_PROMPT).toContain("## Output Field Requirements");
    expect(TRIAGE_PROMPT).toContain("headline");
    expect(TRIAGE_PROMPT).toContain("dedup_key");
  });
});

// ── TRIAGE_TOOL ────────────────────────────────────────────────────────────

describe("TRIAGE_TOOL", () => {
  test("has the correct name and required fields", () => {
    expect(TRIAGE_TOOL.name).toBe("emit_alert_decision");
    const required = TRIAGE_TOOL.input_schema.required as readonly string[];
    expect(required).toContain("alert");
    expect(required).toContain("severity");
    expect(required).toContain("channels");
    expect(required).toContain("headline");
    expect(required).toContain("body");
    expect(required).toContain("dedup_key");
  });

  test("severity enum covers all levels", () => {
    const severityProp = TRIAGE_TOOL.input_schema.properties["severity"] as {
      enum: readonly string[];
    };
    expect(severityProp.enum).toEqual(["low", "medium", "high", "urgent"]);
  });

  test("channels enum includes broadcast channels", () => {
    const channelsProp = TRIAGE_TOOL.input_schema.properties["channels"] as {
      items: { enum: readonly string[] };
    };
    expect(channelsProp.items.enum).toContain("department_channel");
    expect(channelsProp.items.enum).toContain("company_broadcast");
  });
});

// ── buildUserContent ───────────────────────────────────────────────────────

describe("buildUserContent", () => {
  test("includes event, recent_alerts, muted_topics, active_initiatives blocks", () => {
    const content = buildUserContent(
      {
        source: "email",
        external_id: "msg-1",
        subject: "Hello",
        body: "World",
      },
      [
        {
          headline: "Prior alert",
          severity: "high",
          dedup_key: "k1",
          topic_tags: ["finance"],
        },
      ],
      ["weekly_newsletter"],
      [
        {
          title: "Reduce churn",
          status: "active",
          summary: "Lower churn to <2%",
        },
      ],
    );
    expect(content).toContain("<event>");
    expect(content).toContain("Hello");
    expect(content).toContain("<recent_alerts>");
    expect(content).toContain("Prior alert");
    expect(content).toContain("<muted_topics>");
    expect(content).toContain("weekly_newsletter");
    expect(content).toContain("<active_initiatives>");
    expect(content).toContain("Reduce churn");
  });

  test("renders (none) for empty context", () => {
    const content = buildUserContent(
      { source: "email", external_id: "x", body: "hi" },
      [],
      [],
      [],
    );
    expect(content).toContain("(none)");
  });

  test("includes slack channel/user/title when present", () => {
    const content = buildUserContent(
      {
        source: "slack",
        external_id: "s1",
        channel: "general",
        user: "U123",
        title: "Doc title",
        body: "hi",
      },
      [],
      [],
      [],
    );
    expect(content).toContain("slack_channel: general");
    expect(content).toContain("slack_user: U123");
    expect(content).toContain("title: Doc title");
  });
});

// ── parseDecision ──────────────────────────────────────────────────────────

describe("parseDecision", () => {
  test("parses a valid decision", () => {
    const decision = parseDecision({
      alert: true,
      severity: "urgent",
      channels: ["web", "slack_dm", "persisted"],
      headline: "Top customer cancelling",
      body: "ARR loss of $200k",
      suggested_action: "Call them in the next hour",
      topic_tags: ["customer", "churn"],
      dedup_key: "churn-acme",
      reason_if_suppressed: "",
    });
    expect(decision.alert).toBe(true);
    expect(decision.severity).toBe("urgent");
    expect(decision.channels).toContain("slack_dm");
    expect(decision.channels).toContain("persisted");
    expect(decision.headline).toBe("Top customer cancelling");
    expect(decision.dedup_key).toBe("churn-acme");
  });

  test("always includes persisted in channels", () => {
    const decision = parseDecision({
      alert: true,
      severity: "high",
      channels: ["web"],
      headline: "x",
      body: "y",
      dedup_key: "k",
    });
    expect(decision.channels).toContain("persisted");
  });

  test("caps headline/body/topic_tags/dedup_key lengths", () => {
    const decision = parseDecision({
      alert: true,
      severity: "high",
      channels: ["web"],
      headline: "x".repeat(300),
      body: "y".repeat(3000),
      topic_tags: ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"],
      dedup_key: "k".repeat(200),
    });
    expect(decision.headline.length).toBeLessThanOrEqual(200);
    expect(decision.body.length).toBeLessThanOrEqual(2000);
    expect(decision.topic_tags.length).toBeLessThanOrEqual(8);
    expect(decision.dedup_key.length).toBeLessThanOrEqual(120);
  });

  test("unknown severity falls to low", () => {
    const decision = parseDecision({
      alert: true,
      severity: "OMG_CRITICAL",
      channels: [],
    });
    expect(decision.severity).toBe("low");
    expect(decision.channels).toEqual(["persisted"]);
  });

  test("unknown channel values are dropped", () => {
    const decision = parseDecision({
      alert: true,
      severity: "high",
      channels: ["web", "unknown_channel"],
      headline: "x",
      body: "y",
      dedup_key: "k",
    });
    expect(decision.channels).toContain("web");
    expect(decision.channels).not.toContain("unknown_channel" as never);
  });

  test("broadcast fields are propagated when valid", () => {
    const decision = parseDecision({
      alert: true,
      severity: "high",
      channels: ["department_channel", "persisted"],
      headline: "x",
      body: "y",
      dedup_key: "k",
      department_slug: "marketing",
      broadcast_integration: "slack",
    });
    expect(decision.department_slug).toBe("marketing");
    expect(decision.broadcast_integration).toBe("slack");
  });

  test("invalid broadcast_integration is dropped", () => {
    const decision = parseDecision({
      alert: true,
      severity: "high",
      channels: ["department_channel", "persisted"],
      headline: "x",
      body: "y",
      dedup_key: "k",
      broadcast_integration: "invalid",
    });
    expect(decision.broadcast_integration).toBe("");
  });

  test("lowercases topic tags", () => {
    const decision = parseDecision({
      alert: true,
      severity: "high",
      channels: ["web"],
      headline: "x",
      body: "y",
      dedup_key: "k",
      topic_tags: ["Finance", "LEGAL"],
    });
    expect(decision.topic_tags).toEqual(["finance", "legal"]);
  });
});

// ── triageEvent ────────────────────────────────────────────────────────────

describe("triageEvent", () => {
  test("returns parsed decision and passes context to provider", async () => {
    resetRateLimiter();
    const db = openDb();
    insertInitiative(db, {
      title: "Reduce churn",
      status: "active",
      summary: "Lower 6m churn to <2%",
    });
    addMute(db, "weekly_newsletter");

    let capturedMessages: Array<{ role: string; content: string }> = [];
    const provider: Provider = {
      name: "fake",
      defaultModel: "fake-model",
      async chat(messages): Promise<string> {
        capturedMessages = [...messages] as Array<{
          role: string;
          content: string;
        }>;
        return jsonDecision({
          headline: "Top customer cancelling",
          severity: "urgent",
          dedup_key: "churn-acme",
        });
      },
    };

    const decision = await triageEvent(
      {
        source: "email",
        external_id: "msg-1",
        subject: "Cancelling our subscription",
        body: "We will be cancelling next month.",
      },
      { db, provider },
    );

    expect(decision.alert).toBe(true);
    expect(decision.severity).toBe("urgent");
    expect(decision.headline).toBe("Top customer cancelling");
    expect(decision.dedup_key).toBe("churn-acme");

    const userMsg =
      capturedMessages.find((m) => m.role === "user")?.content ?? "";
    expect(userMsg).toContain("<event>");
    expect(userMsg).toContain("Cancelling our subscription");
    expect(userMsg).toContain("<recent_alerts>");
    expect(userMsg).toContain("<muted_topics>");
    expect(userMsg).toContain("weekly_newsletter");
    expect(userMsg).toContain("<active_initiatives>");
    expect(userMsg).toContain("Reduce churn");

    const systemMsg =
      capturedMessages.find((m) => m.role === "system")?.content ?? "";
    expect(systemMsg).toContain("Chief of Staff");
  });

  test("falls back to no_decision when provider returns non-JSON", async () => {
    resetRateLimiter();
    const db = openDb();
    const decision = await triageEvent(
      { source: "email", external_id: "m-2", subject: "hi", body: "b" },
      { db, provider: fakeProvider("Just chatting, no JSON here") },
    );
    expect(decision.alert).toBe(false);
    expect(decision.reason_if_suppressed).toBe("no_decision");
    expect(decision.channels).toEqual(["persisted"]);
  });

  test("falls back to triage_error when provider throws", async () => {
    resetRateLimiter();
    const db = openDb();
    const decision = await triageEvent(
      { source: "email", external_id: "m-3", subject: "x", body: "" },
      { db, provider: throwingProvider() },
    );
    expect(decision.alert).toBe(false);
    expect(decision.reason_if_suppressed).toBe("triage_error");
    expect(decision.channels).toEqual(["persisted"]);
  });

  test("handles JSON wrapped in markdown fences", async () => {
    resetRateLimiter();
    const db = openDb();
    const fenced =
      "```json\n" + jsonDecision({ headline: "Fenced headline" }) + "\n```";
    const decision = await triageEvent(
      { source: "email", external_id: "m-4", subject: "hi", body: "b" },
      { db, provider: fakeProvider(fenced) },
    );
    expect(decision.headline).toBe("Fenced headline");
  });

  test("handles tool_use wrapper shape", async () => {
    resetRateLimiter();
    const db = openDb();
    const wrapped = JSON.stringify({
      name: "emit_alert_decision",
      input: JSON.parse(jsonDecision({ headline: "Wrapped" })),
    });
    const decision = await triageEvent(
      { source: "email", external_id: "m-5", subject: "hi", body: "b" },
      { db, provider: fakeProvider(wrapped) },
    );
    expect(decision.headline).toBe("Wrapped");
  });

  test("includes recent alerts in context", async () => {
    resetRateLimiter();
    const db = openDb();
    insertAlert(db, {
      source: "email",
      external_id: "prior-1",
      severity: "high",
      headline: "Prior alert",
      body: "prior body",
      dedup_key: "prior-key",
    });

    let capturedUser = "";
    const provider: Provider = {
      name: "fake",
      defaultModel: "fake-model",
      async chat(messages): Promise<string> {
        capturedUser =
          (messages.find((m) => m.role === "user")?.content as string) ?? "";
        return jsonDecision();
      },
    };

    await triageEvent(
      {
        source: "email",
        external_id: "new-1",
        subject: "new",
        body: "new body",
      },
      { db, provider },
    );
    expect(capturedUser).toContain("Prior alert");
    expect(capturedUser).toContain("prior-key");
  });
});

// ── evaluateAndDispatch ────────────────────────────────────────────────────

describe("evaluateAndDispatch", () => {
  test("persists alert when triage says alert=true", async () => {
    resetRateLimiter();
    const db = openDb();
    const result = await evaluateAndDispatch(
      { source: "email", external_id: "msg-x", subject: "hi", body: "world" },
      {
        db,
        provider: fakeProvider(
          jsonDecision({ headline: "Stub alert", body: "A real signal" }),
        ),
      },
    );
    expect(result.decision.alert).toBe(true);
    expect(result.alertId).not.toBeNull();
    const alert = getAlert(db, result.alertId!);
    expect(alert?.headline).toBe("Stub alert");
  });

  test("does not persist when triage says alert=false", async () => {
    resetRateLimiter();
    const db = openDb();
    const result = await evaluateAndDispatch(
      {
        source: "email",
        external_id: "msg-quiet",
        subject: "newsletter",
        body: "noise",
      },
      {
        db,
        provider: fakeProvider(
          jsonDecision({
            alert: false,
            severity: "low",
            channels: ["persisted"],
            reason_if_suppressed: "low_signal",
          }),
        ),
      },
    );
    expect(result.decision.alert).toBe(false);
    expect(result.alertId).toBeNull();
  });

  test("suppresses on post-decision mute match", async () => {
    resetRateLimiter();
    const db = openDb();
    addMute(db, "hiring");
    const result = await evaluateAndDispatch(
      { source: "email", external_id: "m-mute", subject: "cand", body: "b" },
      {
        db,
        provider: fakeProvider(
          jsonDecision({ topic_tags: ["hiring"], dedup_key: "cand-1" }),
        ),
      },
    );
    expect(result.decision.alert).toBe(false);
    expect(result.decision.reason_if_suppressed).toBe("muted_post_triage");
    expect(result.alertId).toBeNull();
  });

  test("replay of same external_id is a no-op (webhook retry)", async () => {
    resetRateLimiter();
    const db = openDb();
    const provider = fakeProvider(jsonDecision({ dedup_key: "same-key" }));
    const first = await evaluateAndDispatch(
      { source: "email", external_id: "msg-1", body: "x" },
      { db, provider },
    );
    expect(first.alertId).not.toBeNull();
    const second = await evaluateAndDispatch(
      { source: "email", external_id: "msg-1", body: "x" },
      { db, provider },
    );
    expect(second.alertId).toBeNull();
    const alert = getAlert(db, first.alertId!);
    expect(alert?.occurrence_count).toBe(1);
  });

  test("coalesces same dedup_key without re-dispatch when severity does not rise", async () => {
    resetRateLimiter();
    const db = openDb();
    const lowProvider = fakeProvider(
      jsonDecision({ severity: "low", dedup_key: "k", body: "first" }),
    );
    const first = await evaluateAndDispatch(
      { source: "stock", external_id: "day1", body: "x" },
      { db, provider: lowProvider },
    );
    expect(first.alertId).not.toBeNull();
    const second = await evaluateAndDispatch(
      { source: "stock", external_id: "day2", body: "x" },
      { db, provider: lowProvider },
    );
    expect(second.alertId).toBeNull();
    const alert = getAlert(db, first.alertId!);
    expect(alert?.occurrence_count).toBe(2);
  });

  test("re-dispatches coalesced alert when severity escalates to urgent", async () => {
    resetRateLimiter();
    const db = openDb();
    const lowProvider = fakeProvider(
      jsonDecision({ severity: "low", dedup_key: "k", body: "low body" }),
    );
    const first = await evaluateAndDispatch(
      { source: "stock", external_id: "day1", body: "x" },
      { db, provider: lowProvider },
    );
    expect(first.alertId).not.toBeNull();
    const urgentProvider = fakeProvider(
      jsonDecision({ severity: "urgent", dedup_key: "k", body: "crash" }),
    );
    const third = await evaluateAndDispatch(
      { source: "stock", external_id: "day3", body: "crash" },
      { db, provider: urgentProvider },
    );
    expect(third.alertId).toBe(first.alertId);
    const alert = getAlert(db, first.alertId!);
    expect(alert?.severity).toBe("urgent");
  });

  test("dedup_hint overrides model dedup_key", async () => {
    resetRateLimiter();
    const db = openDb();
    const provider = fakeProvider(jsonDecision({ dedup_key: "model-key" }));
    const first = await evaluateAndDispatch(
      {
        source: "stock",
        external_id: "s1",
        body: "x",
        dedup_hint: "watch:my-watch",
      },
      { db, provider },
    );
    expect(first.alertId).not.toBeNull();
    const alert = getAlert(db, first.alertId!);
    expect(alert?.dedup_key).toBe("watch:my-watch");
    // Second event with same dedup_hint should coalesce, not create new.
    const second = await evaluateAndDispatch(
      {
        source: "stock",
        external_id: "s2",
        body: "x",
        dedup_hint: "watch:my-watch",
      },
      {
        db,
        provider: fakeProvider(
          jsonDecision({ severity: "low", dedup_key: "other-key" }),
        ),
      },
    );
    expect(second.alertId).toBeNull();
  });

  test("adds department tag from event.department", async () => {
    resetRateLimiter();
    const db = openDb();
    const result = await evaluateAndDispatch(
      { source: "email", external_id: "d", body: "x", department: "Finance" },
      { db, provider: fakeProvider(jsonDecision({ topic_tags: ["finance"] })) },
    );
    expect(result.alertId).not.toBeNull();
    const alert = getAlert(db, result.alertId!);
    expect(alert?.topic_tags).toContain("department:finance");
  });

  test("routes to person only from explicit routed_to_person_id", async () => {
    resetRateLimiter();
    const db = openDb();
    // Use distinct dedup_keys so coalescing does not collapse the second event.
    const providerA = fakeProvider(jsonDecision({ dedup_key: "route-a" }));
    const providerB = fakeProvider(jsonDecision({ dedup_key: "route-b" }));
    const routed = await evaluateAndDispatch(
      { source: "email", external_id: "f", body: "x", routed_to_person_id: 4 },
      { db, provider: providerA },
    );
    expect(getAlert(db, routed.alertId!)?.routed_to_person_id).toBe(4);
    const viaUser = await evaluateAndDispatch(
      { source: "email", external_id: "u", body: "x", user: "person:9" },
      { db, provider: providerB },
    );
    const viaUserAlert =
      viaUser.alertId !== null ? getAlert(db, viaUser.alertId) : null;
    expect(viaUserAlert).not.toBeNull();
    expect(viaUserAlert?.routed_to_person_id).toBeNull();
  });

  test("malformed event (missing source) is suppressed without throwing", async () => {
    resetRateLimiter();
    const db = openDb();
    const result = await evaluateAndDispatch(
      { source: "", external_id: "x", body: "hi" } as unknown as TriageEvent,
      { db, provider: fakeProvider(jsonDecision()) },
    );
    expect(result.decision.alert).toBe(false);
    expect(result.decision.reason_if_suppressed).toBe("malformed_event");
    expect(result.alertId).toBeNull();
  });

  test("malformed event (missing external_id) is suppressed without throwing", async () => {
    resetRateLimiter();
    const db = openDb();
    const result = await evaluateAndDispatch(
      {
        source: "email",
        external_id: "",
        body: "hi",
      } as unknown as TriageEvent,
      { db, provider: fakeProvider(jsonDecision()) },
    );
    expect(result.decision.alert).toBe(false);
    expect(result.decision.reason_if_suppressed).toBe("malformed_event");
    expect(result.alertId).toBeNull();
  });

  test("provider throw during evaluate is suppressed as triage_error", async () => {
    resetRateLimiter();
    const db = openDb();
    const result = await evaluateAndDispatch(
      { source: "email", external_id: "err-1", body: "x" },
      { db, provider: throwingProvider() },
    );
    expect(result.decision.alert).toBe(false);
    expect(result.decision.reason_if_suppressed).toBe("triage_error");
    expect(result.alertId).toBeNull();
  });

  test("rate limiter suppresses after 60 events in a minute", async () => {
    resetRateLimiter();
    const db = openDb();
    const provider = fakeProvider(jsonDecision());
    // Fill the window.
    for (let idx = 0; idx < 60; idx++) {
      await evaluateAndDispatch(
        { source: "email", external_id: `rate-${idx}`, body: "x" },
        { db, provider },
      );
    }
    const limited = await evaluateAndDispatch(
      { source: "email", external_id: "rate-60", body: "x" },
      { db, provider },
    );
    expect(limited.decision.reason_if_suppressed).toBe("rate_limited");
    expect(limited.alertId).toBeNull();
    resetRateLimiter();
  });

  test("privacy invariant strips broadcast channels for sensitive tags", async () => {
    resetRateLimiter();
    const db = openDb();
    const result = await evaluateAndDispatch(
      { source: "email", external_id: "priv-1", body: "board meeting notes" },
      {
        db,
        provider: fakeProvider(
          jsonDecision({
            topic_tags: ["board"],
            channels: ["department_channel", "persisted"],
            department_slug: "finance",
            broadcast_integration: "slack",
          }),
        ),
      },
    );
    // Should still create an alert but without broadcast channels.
    if (result.alertId !== null) {
      expect(result.decision.channels).not.toContain(
        "department_channel" as never,
      );
      expect(result.decision.department_slug).toBe("");
      expect(result.decision.broadcast_integration).toBe("");
    } else {
      // If suppressed as privacy_gated, that's also valid for low severity.
      expect(result.decision.reason_if_suppressed).toBe("privacy_gated");
    }
  });

  test("privacy invariant does not block competitor tag (substring guard)", async () => {
    resetRateLimiter();
    const db = openDb();
    const result = await evaluateAndDispatch(
      { source: "email", external_id: "comp-1", body: "competitor analysis" },
      {
        db,
        provider: fakeProvider(
          jsonDecision({
            topic_tags: ["competitor"],
            channels: ["department_channel", "persisted"],
            department_slug: "marketing",
            broadcast_integration: "slack",
          }),
        ),
      },
    );
    expect(result.alertId).not.toBeNull();
    expect(result.decision.channels).toContain("department_channel");
  });
});

// ── validateTriageEvent ────────────────────────────────────────────────────

describe("validateTriageEvent", () => {
  test("accepts a valid event", () => {
    const result = validateTriageEvent({
      source: "email",
      external_id: "msg-1",
      subject: "hi",
      body: "hello",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.source).toBe("email");
      expect(result.event.external_id).toBe("msg-1");
    }
  });

  test("rejects missing source", () => {
    const result = validateTriageEvent({ external_id: "x" });
    expect(result.ok).toBe(false);
  });

  test("rejects missing external_id", () => {
    const result = validateTriageEvent({ source: "email" });
    expect(result.ok).toBe(false);
  });

  test("rejects non-object body", () => {
    expect(validateTriageEvent(null).ok).toBe(false);
    expect(validateTriageEvent("string").ok).toBe(false);
    expect(validateTriageEvent([]).ok).toBe(false);
  });

  test("accepts optional fields", () => {
    const result = validateTriageEvent({
      source: "slack",
      external_id: "s1",
      channel: "general",
      user: "U123",
      title: "Doc",
      dedup_hint: "watch:foo",
      department: "finance",
      routed_to_person_id: 42,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.channel).toBe("general");
      expect(result.event.dedup_hint).toBe("watch:foo");
      expect(result.event.routed_to_person_id).toBe(42);
    }
  });

  test("trims source and external_id", () => {
    const result = validateTriageEvent({
      source: "  email  ",
      external_id: "  msg-1  ",
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.event.source).toBe("email");
      expect(result.event.external_id).toBe("msg-1");
    }
  });
});

// ── HTTP routes ────────────────────────────────────────────────────────────

describe("triage HTTP routes", () => {
  test("GET /features/triage/prompt returns prompt and tool", async () => {
    const { openDb: open } = await import("../../db.ts");
    const { createApp } = await import("../../index.ts");
    const db = open();
    const provider = fakeProvider("{}");
    const app = createApp({
      settings: {
        dbPath: ":memory:",
        port: 8787,
        publicServerUrl: "",
        allowedOrigins: [],
        morningBriefTime: "08:00",
        eodDigestTime: "18:00",
        reflectionTime: "07:30",
        scheduledAdminToken: "",
        provider: {
          name: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "test",
          model: "deepseek-chat",
          reasoningModel: "deepseek-reasoner",
          routingModel: "deepseek-chat",
          headers: {},
        },
      },
      db,
      provider,
    });
    const res = await app(
      new Request("http://localhost/features/triage/prompt"),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["prompt"]).toBe("string");
    expect((body["prompt"] as string).length).toBeGreaterThan(1000);
    expect((body["tool"] as Record<string, unknown>)["name"]).toBe(
      "emit_alert_decision",
    );
  });

  test("POST /features/triage/classify validates and classifies", async () => {
    const { openDb: open } = await import("../../db.ts");
    const { createApp } = await import("../../index.ts");
    resetRateLimiter();
    const db = open();
    const provider = fakeProvider(
      jsonDecision({ headline: "Classified headline" }),
    );
    const app = createApp({
      settings: {
        dbPath: ":memory:",
        port: 8787,
        publicServerUrl: "",
        allowedOrigins: [],
        morningBriefTime: "08:00",
        eodDigestTime: "18:00",
        reflectionTime: "07:30",
        scheduledAdminToken: "",
        provider: {
          name: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "test",
          model: "deepseek-chat",
          reasoningModel: "deepseek-reasoner",
          routingModel: "deepseek-chat",
          headers: {},
        },
      },
      db,
      provider,
    });
    const res = await app(
      new Request("http://localhost/features/triage/classify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "email",
          external_id: "test-1",
          subject: "hi",
          body: "hello",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body["headline"]).toBe("Classified headline");
  });

  test("POST /features/triage/classify rejects missing source", async () => {
    const { openDb: open } = await import("../../db.ts");
    const { createApp } = await import("../../index.ts");
    const db = open();
    const provider = fakeProvider("{}");
    const app = createApp({
      settings: {
        dbPath: ":memory:",
        port: 8787,
        publicServerUrl: "",
        allowedOrigins: [],
        morningBriefTime: "08:00",
        eodDigestTime: "18:00",
        reflectionTime: "07:30",
        scheduledAdminToken: "",
        provider: {
          name: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "test",
          model: "deepseek-chat",
          reasoningModel: "deepseek-reasoner",
          routingModel: "deepseek-chat",
          headers: {},
        },
      },
      db,
      provider,
    });
    const res = await app(
      new Request("http://localhost/features/triage/classify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ external_id: "x" }),
      }),
    );
    expect(res.status).toBe(422);
  });

  test("POST /features/triage/evaluate persists alert", async () => {
    const { openDb: open } = await import("../../db.ts");
    const { createApp } = await import("../../index.ts");
    resetRateLimiter();
    const db = open();
    const provider = fakeProvider(
      jsonDecision({ headline: "Evaluated headline" }),
    );
    const app = createApp({
      settings: {
        dbPath: ":memory:",
        port: 8787,
        publicServerUrl: "",
        allowedOrigins: [],
        morningBriefTime: "08:00",
        eodDigestTime: "18:00",
        reflectionTime: "07:30",
        scheduledAdminToken: "",
        provider: {
          name: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "test",
          model: "deepseek-chat",
          reasoningModel: "deepseek-reasoner",
          routingModel: "deepseek-chat",
          headers: {},
        },
      },
      db,
      provider,
    });
    const res = await app(
      new Request("http://localhost/features/triage/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "email",
          external_id: "eval-1",
          subject: "hi",
          body: "hello",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    const decision = body["decision"] as Record<string, unknown>;
    expect(decision["headline"]).toBe("Evaluated headline");
    expect(body["alertId"]).not.toBeNull();
  });

  test("POST /triage/evaluate alias works", async () => {
    const { openDb: open } = await import("../../db.ts");
    const { createApp } = await import("../../index.ts");
    resetRateLimiter();
    const db = open();
    const provider = fakeProvider(jsonDecision({ headline: "Alias headline" }));
    const app = createApp({
      settings: {
        dbPath: ":memory:",
        port: 8787,
        publicServerUrl: "",
        allowedOrigins: [],
        morningBriefTime: "08:00",
        eodDigestTime: "18:00",
        reflectionTime: "07:30",
        scheduledAdminToken: "",
        provider: {
          name: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "test",
          model: "deepseek-chat",
          reasoningModel: "deepseek-reasoner",
          routingModel: "deepseek-chat",
          headers: {},
        },
      },
      db,
      provider,
    });
    const res = await app(
      new Request("http://localhost/triage/evaluate", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          source: "email",
          external_id: "alias-1",
          subject: "hi",
          body: "hello",
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect((body["decision"] as Record<string, unknown>)["headline"]).toBe(
      "Alias headline",
    );
  });

  test("POST /triage/debug returns prompt context without calling provider", async () => {
    const { openDb: open } = await import("../../db.ts");
    const { createApp } = await import("../../index.ts");
    const db = open();
    const provider = throwingProvider();
    const app = createApp({
      settings: {
        dbPath: ":memory:",
        port: 8787,
        publicServerUrl: "",
        allowedOrigins: [],
        morningBriefTime: "08:00",
        eodDigestTime: "18:00",
        reflectionTime: "07:30",
        scheduledAdminToken: "",
        provider: {
          name: "deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKey: "test",
          model: "deepseek-chat",
          reasoningModel: "deepseek-reasoner",
          routingModel: "deepseek-chat",
          headers: {},
        },
      },
      db,
      provider,
    });
    const res = await app(
      new Request("http://localhost/triage/debug", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: {
            source: "email",
            external_id: "dbg-1",
            subject: "debug me",
            body: "hello",
          },
        }),
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(typeof body["system"]).toBe("string");
    expect(typeof body["user"]).toBe("string");
    expect(body["user"] as string).toContain("debug me");
  });
});

// ── council invariant ──────────────────────────────────────────────────────

describe("council invariant", () => {
  test("triage is not in the council roster", async () => {
    const { SPECIALIST_KEYS } = await import("../council/specialists.ts");
    expect(SPECIALIST_KEYS).not.toContain("triage" as never);
    expect(SPECIALIST_KEYS).toHaveLength(9);
  });
});

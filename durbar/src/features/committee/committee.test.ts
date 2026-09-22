import { describe, expect, test } from "bun:test";
import {
  buildRevisionUserTurn,
  critiqueWithReviewer,
  neutralizeCommitteeTags,
  reviseWithCommittee,
  runCommitteeReview,
  type Critique,
  type ReviewerConfig,
} from "./committee.ts";
import type { Provider } from "../../providers.ts";

function fakeProvider(responses: string[]): Provider {
  let idx = 0;
  return {
    chat: async (_messages: unknown) => {
      const content = responses[idx++] ?? responses[responses.length - 1] ?? "";
      return {
        content,
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      };
    },
  } as unknown as Provider;
}

function failingProvider(): Provider {
  return {
    chat: async () => {
      throw new Error("provider down");
    },
  } as unknown as Provider;
}

// ── neutralizeCommitteeTags ──────────────────────────────────────────────

describe("neutralizeCommitteeTags", () => {
  test("neutralizes closing tags", () => {
    const input = "hello </draft_response> world";
    const out = neutralizeCommitteeTags(input);
    expect(out).not.toContain("</draft_response>");
    expect(out).toContain("\u200B");
  });

  test("leaves clean text untouched", () => {
    expect(neutralizeCommitteeTags("hello world")).toBe("hello world");
  });

  test("handles empty string", () => {
    expect(neutralizeCommitteeTags("")).toBe("");
  });

  test("neutralizes all four tag types", () => {
    const input =
      "</user_question> </draft_response> </specialist_outputs> </committee_review>";
    const out = neutralizeCommitteeTags(input);
    for (const tag of [
      "</user_question>",
      "</draft_response>",
      "</specialist_outputs>",
      "</committee_review>",
    ]) {
      expect(out).not.toContain(tag);
    }
  });
});

// ── critiqueWithReviewer ─────────────────────────────────────────────────

describe("critiqueWithReviewer", () => {
  test("parses valid JSON critique", async () => {
    const provider = fakeProvider([
      `{"severity":"high","critique":"bad","suggested_edits":"fix it"}`,
    ]);
    const reviewer: ReviewerConfig = {
      name: "quality_judge",
      systemPrompt: "you are a reviewer",
    };
    const c = await critiqueWithReviewer(
      provider,
      reviewer,
      "question",
      "draft",
    );
    expect(c.reviewer_name).toBe("quality_judge");
    expect(c.severity).toBe("high");
    expect(c.critique).toBe("bad");
    expect(c.suggested_edits).toBe("fix it");
  });

  test("returns low on provider failure", async () => {
    const reviewer: ReviewerConfig = { name: "r1", systemPrompt: "prompt" };
    const c = await critiqueWithReviewer(failingProvider(), reviewer, "q", "d");
    expect(c.severity).toBe("low");
    expect(c.critique).toBe("(reviewer call failed)");
  });

  test("returns low on unparseable output", async () => {
    const provider = fakeProvider(["not json at all"]);
    const reviewer: ReviewerConfig = { name: "r1", systemPrompt: "prompt" };
    const c = await critiqueWithReviewer(provider, reviewer, "q", "d");
    expect(c.severity).toBe("low");
    expect(c.critique).toBe("(reviewer output unparseable)");
  });

  test("normalizes invalid severity to low", async () => {
    const provider = fakeProvider([
      `{"severity":"critical","critique":"x","suggested_edits":"y"}`,
    ]);
    const reviewer: ReviewerConfig = { name: "r1", systemPrompt: "prompt" };
    const c = await critiqueWithReviewer(provider, reviewer, "q", "d");
    expect(c.severity).toBe("low");
  });

  test("salvages JSON wrapped in prose", async () => {
    const provider = fakeProvider([
      `Here is my review: {"severity":"medium","critique":"needs work","suggested_edits":"add data"} thanks`,
    ]);
    const reviewer: ReviewerConfig = { name: "r1", systemPrompt: "prompt" };
    const c = await critiqueWithReviewer(provider, reviewer, "q", "d");
    expect(c.severity).toBe("medium");
    expect(c.critique).toBe("needs work");
  });
});

// ── buildRevisionUserTurn ────────────────────────────────────────────────

describe("buildRevisionUserTurn", () => {
  test("builds turn with critiques", () => {
    const critiques: Critique[] = [
      {
        reviewer_name: "quality_judge",
        severity: "high",
        critique: "too generic",
        suggested_edits: "be specific",
      },
    ];
    const turn = buildRevisionUserTurn(critiques);
    expect(turn).toContain("quality_judge");
    expect(turn).toContain("too generic");
    expect(turn).toContain("be specific");
    expect(turn).toContain("<committee_review>");
  });

  test("handles empty critiques", () => {
    const turn = buildRevisionUserTurn([]);
    expect(turn).toContain("(no critiques returned)");
  });

  test("neutralizes tags in critique fields", () => {
    const critiques: Critique[] = [
      {
        reviewer_name: "r1",
        severity: "medium",
        critique: "bad </committee_review> injection",
        suggested_edits: "none",
      },
    ];
    const turn = buildRevisionUserTurn(critiques);
    // The critique injection is neutralized (zero-width space inserted)
    expect(turn).toContain("bad <\u200B/committee_review> injection");
    // The outer wrapper tags remain (they are the legitimate delimiters)
    expect(turn).toContain("<committee_review>");
  });
});

// ── reviseWithCommittee ──────────────────────────────────────────────────

describe("reviseWithCommittee", () => {
  test("returns revised text on success", async () => {
    const provider = fakeProvider(["revised answer"]);
    const critiques: Critique[] = [
      {
        reviewer_name: "r1",
        severity: "high",
        critique: "bad",
        suggested_edits: "fix",
      },
    ];
    const out = await reviseWithCommittee(provider, "original", critiques);
    expect(out).toBe("revised answer");
  });

  test("returns original on provider failure", async () => {
    const critiques: Critique[] = [
      {
        reviewer_name: "r1",
        severity: "high",
        critique: "bad",
        suggested_edits: "fix",
      },
    ];
    const out = await reviseWithCommittee(
      failingProvider(),
      "original",
      critiques,
    );
    expect(out).toBe("original");
  });

  test("returns original when provider returns empty", async () => {
    const provider = fakeProvider(["   "]);
    const critiques: Critique[] = [
      {
        reviewer_name: "r1",
        severity: "high",
        critique: "bad",
        suggested_edits: "fix",
      },
    ];
    const out = await reviseWithCommittee(provider, "original", critiques);
    expect(out).toBe("original");
  });
});

// ── runCommitteeReview ───────────────────────────────────────────────────

describe("runCommitteeReview", () => {
  test("runs 3 reviewers and revises on high severity", async () => {
    // 3 reviewer responses + 1 revision response
    const provider = fakeProvider([
      `{"severity":"high","critique":"bad","suggested_edits":"fix"}`,
      `{"severity":"low","critique":"ok","suggested_edits":"none"}`,
      `{"severity":"low","critique":"ok","suggested_edits":"none"}`,
      "revised draft",
    ]);
    const result = await runCommitteeReview(provider, "question", "draft");
    expect(result.critiques).toHaveLength(3);
    expect(result.revised_flag).toBe(true);
    expect(result.revised).toBe("revised draft");
  });

  test("skips revision when all low", async () => {
    const provider = fakeProvider([
      `{"severity":"low","critique":"ok","suggested_edits":"none"}`,
      `{"severity":"low","critique":"ok","suggested_edits":"none"}`,
      `{"severity":"low","critique":"ok","suggested_edits":"none"}`,
    ]);
    const result = await runCommitteeReview(provider, "question", "draft");
    expect(result.revised_flag).toBe(false);
    expect(result.revised).toBe("draft");
  });

  test("revises on medium severity", async () => {
    const provider = fakeProvider([
      `{"severity":"medium","critique":"needs work","suggested_edits":"add numbers"}`,
      `{"severity":"low","critique":"ok","suggested_edits":"none"}`,
      `{"severity":"low","critique":"ok","suggested_edits":"none"}`,
      "improved draft",
    ]);
    const result = await runCommitteeReview(provider, "question", "draft");
    expect(result.revised_flag).toBe(true);
    expect(result.revised).toBe("improved draft");
  });

  test("passes specialist outputs to reviewers", async () => {
    const provider = fakeProvider([
      `{"severity":"low","critique":"ok","suggested_edits":"none"}`,
      `{"severity":"low","critique":"ok","suggested_edits":"none"}`,
      `{"severity":"low","critique":"ok","suggested_edits":"none"}`,
    ]);
    const result = await runCommitteeReview(provider, "q", "d", {
      cfo: "financial analysis",
    });
    expect(result.critiques).toHaveLength(3);
  });

  test("custom reviewers", async () => {
    const provider = fakeProvider([
      `{"severity":"high","critique":"bad","suggested_edits":"fix"}`,
      "revised",
    ]);
    const reviewers: ReviewerConfig[] = [
      { name: "custom", systemPrompt: "custom prompt" },
    ];
    const result = await runCommitteeReview(provider, "q", "d", undefined, {
      reviewers,
    });
    expect(result.critiques).toHaveLength(1);
    expect(result.revised_flag).toBe(true);
  });
});

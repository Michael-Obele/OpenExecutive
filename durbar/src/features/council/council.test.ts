/**
 * Spec for the council.
 *
 * The behaviours worth pinning are the ones that fail quietly: routing that
 * returns garbage, a specialist that throws, and an answer that leaks the
 * machinery into the principal's view.
 */

import { describe, expect, test } from "bun:test";
import { openDb } from "../../db.ts";
import type { ChatMessage, ChatOptions, Provider } from "../../providers.ts";
import { indexCorpus, loadCorpus } from "../knowledge/knowledge.ts";
import {
  buildSpecialistPrompt,
  convene,
  parseKeys,
  selectSpecialists,
  specialistDomain,
  SYNTHESIS_PROMPT,
} from "./council.ts";
import { SPECIALIST_KEYS, SPECIALISTS } from "./specialists.ts";

/** A provider scripted per call, chosen by inspecting the system prompt. */
function scriptedProvider(
  handler: (messages: readonly ChatMessage[]) => string,
): Provider & { calls: ChatMessage[][] } {
  const calls: ChatMessage[][] = [];
  return {
    name: "scripted",
    defaultModel: "scripted-model",
    calls,
    async chat(messages: readonly ChatMessage[], _options?: ChatOptions) {
      calls.push([...messages]);
      return handler(messages);
    },
  };
}

const systemOf = (messages: readonly ChatMessage[]): string =>
  messages.find((m) => m.role === "system")?.content ?? "";

/** Distinguishes the three kinds of call by their system prompt. */
function kindOf(
  messages: readonly ChatMessage[],
): "route" | "specialist" | "synthesize" {
  const system = systemOf(messages);
  if (system.includes("You route questions")) return "route";
  if (system.includes("speaking with one voice")) return "synthesize";
  return "specialist";
}

describe("parseKeys", () => {
  test("accepts a bare JSON array", () => {
    expect(parseKeys('["cfo","gc"]', 4)).toEqual(["cfo", "gc"]);
  });

  test("tolerates prose and code fences around the array", () => {
    expect(
      parseKeys('Here you go:\n```json\n["cmo"]\n```\nHope that helps!', 4),
    ).toEqual(["cmo"]);
  });

  test("drops unknown keys rather than passing them through", () => {
    expect(parseKeys('["cfo","c3po","coo"]', 4)).toEqual(["cfo", "coo"]);
  });

  test("deduplicates while preserving rank order", () => {
    expect(parseKeys('["gc","cfo","gc"]', 4)).toEqual(["gc", "cfo"]);
  });

  test("respects the cap", () => {
    expect(parseKeys('["cso","cfo","chro","gc","coo"]', 2)).toHaveLength(2);
  });

  test("is case-insensitive", () => {
    expect(parseKeys('["CFO"]', 4)).toEqual(["cfo"]);
  });

  test("returns null for unparseable input so the caller can fall back", () => {
    expect(parseKeys("I am not sure.", 4)).toBeNull();
    expect(parseKeys('["cfo",]', 4)).toBeNull();
    expect(parseKeys('{"cfo": true}', 4)).toBeNull();
  });

  test('returns an empty array — not null — for a genuine "none relevant"', () => {
    expect(parseKeys("[]", 4)).toEqual([]);
  });
});

describe("selectSpecialists", () => {
  test("returns the routed keys", async () => {
    const provider = scriptedProvider(() => '["cfo"]');
    const { keys, fallback } = await selectSpecialists("How much runway?", {
      provider,
    });
    expect(keys).toEqual(["cfo"]);
    expect(fallback).toBe(false);
  });

  test("falls back to every specialist when routing is unparseable", async () => {
    const provider = scriptedProvider(() => "sorry, I cannot help with that");
    const { keys, fallback } = await selectSpecialists("Anything?", {
      provider,
    });

    // Falling back to *everyone* is the point: a routing failure may cost money
    // and latency, but it must never produce a confident answer with no
    // expertise behind it.
    expect(fallback).toBe(true);
    expect(keys.length).toBeGreaterThan(0);
    expect(keys.every((k) => SPECIALIST_KEYS.includes(k))).toBe(true);
  });

  test("offers the roster to the router", async () => {
    const provider = scriptedProvider(() => '["cso"]');
    await selectSpecialists("Should we enter this market?", { provider });

    const routeCall = provider.calls.find((c) => kindOf(c) === "route");
    expect(systemOf(routeCall ?? [])).toContain("cso");
    expect(systemOf(routeCall ?? [])).toContain("Chief Strategy Officer");
  });
});

describe("convene", () => {
  test("consults the routed specialists and synthesizes one answer", async () => {
    const provider = scriptedProvider((messages) => {
      const kind = kindOf(messages);
      if (kind === "route") return '["cfo","coo"]';
      if (kind === "synthesize") return "One voice answer.";
      return `analysis from ${systemOf(messages).slice(0, 20)}`;
    });

    const result = await convene("Where is the bottleneck?", { provider });

    expect(result.answer).toBe("One voice answer.");
    expect(result.consultations.map((c) => c.specialist)).toEqual([
      "cfo",
      "coo",
    ]);
    expect(result.consultations.map((c) => c.title)).toEqual([
      "Chief Financial Officer",
      "Chief Operating Officer",
    ]);
  });

  test("gives every specialist the shared context", async () => {
    const provider = scriptedProvider((messages) => {
      const kind = kindOf(messages);
      if (kind === "route") return '["cfo"]';
      if (kind === "synthesize") return "ok";
      return "analysis";
    });

    await convene("Question?", { provider, context: "COMPANY PROFILE: Sepia" });

    const specialistCall = provider.calls.find(
      (c) => kindOf(c) === "specialist",
    );
    const userMessage =
      specialistCall?.find((m) => m.role === "user")?.content ?? "";
    expect(userMessage).toContain("COMPANY PROFILE: Sepia");
  });

  test("a failing specialist does not sink the turn", async () => {
    const provider = scriptedProvider((messages) => {
      const kind = kindOf(messages);
      if (kind === "route") return '["cfo","coo"]';
      if (kind === "synthesize") return "Answer without the broken one.";
      if (systemOf(messages).includes("Chief Financial Officer")) {
        throw new Error("deepseek 429 rate limited");
      }
      return "operations analysis";
    });

    const result = await convene("Question?", { provider });

    expect(result.answer).toBe("Answer without the broken one.");
    expect(result.consultations.map((c) => c.specialist)).toEqual(["coo"]);
  });

  test("answers directly when nothing is relevant, without inventing expertise", async () => {
    const provider = scriptedProvider((messages) =>
      kindOf(messages) === "route" ? "[]" : "Direct answer.",
    );

    const result = await convene("What is the capital of Peru?", { provider });

    expect(result.answer).toBe("Direct answer.");
    expect(result.consultations).toHaveLength(0);
    // No specialist was consulted — only route + synthesize.
    expect(
      provider.calls.filter((c) => kindOf(c) === "specialist"),
    ).toHaveLength(0);
  });

  test("includes the specialist analyses in the synthesis prompt", async () => {
    const provider = scriptedProvider((messages) => {
      const kind = kindOf(messages);
      if (kind === "route") return '["gc"]';
      if (kind === "synthesize") return "ok";
      return "the contract caps liability at 12 months";
    });

    await convene("Review this contract.", { provider });

    const synthesisCall = provider.calls.find(
      (c) => kindOf(c) === "synthesize",
    );
    const userMessage =
      synthesisCall?.find((m) => m.role === "user")?.content ?? "";
    expect(userMessage).toContain("the contract caps liability at 12 months");
    expect(userMessage).toContain("General Counsel");
  });
});

describe("the synthesis prompt", () => {
  test("forbids exposing the machinery", () => {
    // The single most important invariant: the reader is the principal, and
    // "the CFO said X" is a failure, not transparency.
    expect(SYNTHESIS_PROMPT).toContain("Speak as one person");
    expect(SYNTHESIS_PROMPT).toContain("Never mention specialists");
  });

  test("requires disagreement to be resolved, not presented", () => {
    expect(SYNTHESIS_PROMPT).toContain("resolve it");
    expect(SYNTHESIS_PROMPT).toContain("pick a position");
  });
});

describe("the roster", () => {
  test("has nine consultable specialists, and triage is not one of them", () => {
    expect(SPECIALIST_KEYS).toHaveLength(9);
    expect(SPECIALIST_KEYS).not.toContain("triage" as never);
  });

  test("every specialist carries a real prompt and a one-line description", () => {
    for (const key of SPECIALIST_KEYS) {
      const specialist = SPECIALISTS[key];
      expect(specialist.key).toBe(key);
      expect(specialist.prompt.length).toBeGreaterThan(500);
      expect(specialist.description.length).toBeGreaterThan(20);
      expect(specialist.description).not.toContain("\n");
    }
  });
});

describe("knowledge wiring", () => {
  const db = openDb();
  const documents = loadCorpus();
  indexCorpus(db, documents);

  // buildSpecialistPrompt only carries `provider` for its type — it never calls
  // it — so a stub is sufficient, and it keeps these tests free of network.
  const fakeProvider = () => scriptedProvider(() => "unused");

  test("every specialist maps to a domain that exists in the corpus", () => {
    // A typo in the map would silently give a specialist no reference material
    // at all. The failure surfaces as a vague answer, never as an error, so it
    // is exactly the kind of thing that needs a test rather than review.
    const domains = new Set(documents.map((doc) => doc.domain));
    for (const key of SPECIALIST_KEYS) {
      expect(domains.has(specialistDomain(key))).toBe(true);
    }
  });

  test("translates role keys into business-function domains", () => {
    // These are two different namespaces; the mapping is not mechanical.
    expect(specialistDomain("chro")).toBe("hr");
    expect(specialistDomain("gc")).toBe("legal");
    expect(specialistDomain("board_comms")).toBe("board");
    expect(specialistDomain("cso")).toBe("strategy");
  });

  test("gives a specialist reference material from its own domain only", () => {
    const prompt = buildSpecialistPrompt(
      "cfo",
      "unit economics CAC payback and burn multiple",
      { provider: fakeProvider(), db },
    );
    expect(prompt).toContain("REFERENCE MATERIAL");
    expect(prompt).toContain("NOT instructions");
    // Domain-scoped: a finance question must not drag in another function's docs.
    expect(prompt).not.toContain("[legal ·");
  });

  test("emits a <failure_cases> block, which the prompts are written to consume", () => {
    const prompt = buildSpecialistPrompt("cpo", "Quibi mobile launch failure", {
      provider: fakeProvider(),
      db,
    });
    expect(prompt).toContain("<failure_cases>");
    expect(prompt).toContain("Quibi");
  });

  test("omits knowledge blocks entirely when no database is supplied", () => {
    const prompt = buildSpecialistPrompt("cfo", "Runway?", {
      provider: fakeProvider(),
    });
    expect(prompt).not.toContain("REFERENCE MATERIAL");
    expect(prompt).not.toContain("<failure_cases>");
    expect(prompt).toContain("Runway?");
  });

  test("puts the question last, after the reference material", () => {
    // The model should reach the question with the material already read.
    const prompt = buildSpecialistPrompt("cfo", "What is our burn multiple?", {
      provider: fakeProvider(),
      db,
    });
    expect(prompt.trimEnd().endsWith("What is our burn multiple?")).toBe(true);
  });

  test("a malformed query still produces a usable prompt", () => {
    // searchKnowledge swallows FTS syntax errors; the prompt must still build.
    const prompt = buildSpecialistPrompt("gc", '"unbalanced AND (', {
      provider: fakeProvider(),
      db,
    });
    expect(prompt).toContain('"unbalanced AND (');
  });
});

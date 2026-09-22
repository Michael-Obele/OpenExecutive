/**
 * Onboarding — company-setup interview lifecycle.
 *
 * Port of `onboarding/interview.py` + `onboarding/wizard.py` + `api/routes/onboarding.py`.
 * Upstream keeps sessions in-memory (OrderedDict with TTL); Durbar persists
 * them in SQLite so a restart doesn't lose the draft. The LLM interview
 * (`advance`) is stubbed: it returns a canned question or a draft built from
 * the transcript. Commit validates and writes to company_profile.
 */

import type { Db } from "../../db.ts";
import { getCompanyProfile, patchCompanyProfile } from "../company/company.ts";

export interface OnboardingSession {
  id: string;
  transcript: Array<{ role: string; text: string }>;
  questions_asked: number;
  draft: Record<string, unknown> | null;
  saved: boolean;
  created_at: string;
  updated_at: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rowToSession(row: Record<string, unknown>): OnboardingSession {
  let transcript: Array<{ role: string; text: string }> = [];
  try {
    transcript = JSON.parse(
      (row["transcript_json"] as string) ?? "[]",
    ) as typeof transcript;
  } catch {
    transcript = [];
  }
  let draft: Record<string, unknown> | null = null;
  try {
    const raw = row["draft_json"] as string | null;
    if (raw) draft = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    draft = null;
  }
  return {
    id: row["id"] as string,
    transcript,
    questions_asked: (row["questions_asked"] as number) ?? 0,
    draft,
    saved: Boolean(row["saved"]),
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
  };
}

export function createSession(db: Db, id: string): OnboardingSession {
  const now = nowIso();
  const opening =
    "Tell me about your company — what do you do, who do you serve, and what stage are you at?";
  const transcript = [{ role: "assistant", text: opening }];
  db.run(
    "INSERT INTO onboarding_sessions (id, transcript_json, questions_asked, created_at, updated_at) VALUES (?, ?, 0, ?, ?)",
    [id, JSON.stringify(transcript), now, now],
  );
  const row = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT * FROM onboarding_sessions WHERE id = ?")
    .get(id);
  if (!row) throw new Error("Session vanished after insert");
  return rowToSession(row);
}

export function getSession(db: Db, id: string): OnboardingSession | null {
  const row = db
    .query<
      Record<string, unknown>,
      [string]
    >("SELECT * FROM onboarding_sessions WHERE id = ?")
    .get(id);
  return row ? rowToSession(row) : null;
}

export function appendMessage(
  db: Db,
  id: string,
  role: string,
  text: string,
): OnboardingSession | null {
  const session = getSession(db, id);
  if (!session) return null;
  if (session.saved) throw new Error("Already committed");
  session.transcript.push({ role, text });
  // Stub interviewer: after 3 user messages, produce a draft; otherwise ask next question.
  const userCount = session.transcript.filter((t) => t.role === "user").length;
  let draft: Record<string, unknown> | null = session.draft;
  let questionsAsked = session.questions_asked;
  const cannedQuestions = [
    "What is your current headcount and how is the team organized?",
    "What are your top strategic priorities this year?",
    "What does success look like in the next 12 months?",
  ];
  if (userCount >= 3 && !draft) {
    // Build a minimal draft from transcript
    const allUserText = session.transcript
      .filter((t) => t.role === "user")
      .map((t) => t.text)
      .join(" ");
    draft = {
      profile: {
        name: allUserText.slice(0, 80) || "Acme Inc",
        industry: "Technology",
        stage: "Series A",
        mission: allUserText.slice(0, 200),
      },
      people: [{ full_name: "Founder", is_principal: true, role: "CEO" }],
      departments: [{ title: "Operations", mission: "Run the company" }],
      confidence_notes: ["Draft generated from interview transcript (stub)"],
      summary: allUserText.slice(0, 500),
    };
  } else if (!draft) {
    const q =
      cannedQuestions[questionsAsked] ??
      "Anything else you'd like to add about your company?";
    session.transcript.push({ role: "assistant", text: q });
    questionsAsked += 1;
  }
  db.run(
    "UPDATE onboarding_sessions SET transcript_json = ?, questions_asked = ?, draft_json = ?, updated_at = ? WHERE id = ?",
    [
      JSON.stringify(session.transcript),
      questionsAsked,
      draft ? JSON.stringify(draft) : null,
      nowIso(),
      id,
    ],
  );
  return getSession(db, id);
}

export function forceDraft(db: Db, id: string): OnboardingSession | null {
  const session = getSession(db, id);
  if (!session) return null;
  if (session.draft) return session;
  const allUserText = session.transcript
    .filter((t) => t.role === "user")
    .map((t) => t.text)
    .join(" ");
  const draft = {
    profile: {
      name: allUserText.slice(0, 80) || "Acme Inc",
      industry: "Technology",
      stage: "Series A",
      mission: allUserText.slice(0, 200),
    },
    people: [{ full_name: "Founder", is_principal: true, role: "CEO" }],
    departments: [{ title: "Operations", mission: "Run the company" }],
    confidence_notes: ["Draft forced (stub)"],
    summary: allUserText.slice(0, 500),
  };
  db.run(
    "UPDATE onboarding_sessions SET draft_json = ?, updated_at = ? WHERE id = ?",
    [JSON.stringify(draft), nowIso(), id],
  );
  return getSession(db, id);
}

export function commitSession(
  db: Db,
  id: string,
  profilePatch?: Record<string, unknown>,
): OnboardingSession | null {
  const session = getSession(db, id);
  if (!session) return null;
  if (!session.draft)
    throw new Error(
      "No draft to commit — answer more questions or force a draft",
    );
  if (session.saved) throw new Error("Already committed");
  const draft = session.draft as Record<string, unknown>;
  const profile = (draft["profile"] as Record<string, unknown>) ?? {};
  const mergedPatch = { ...profile, ...(profilePatch ?? {}) };
  // Validate: must have name
  if (
    typeof mergedPatch["name"] !== "string" ||
    !(mergedPatch["name"] as string).trim()
  ) {
    throw new Error("Draft profile must have a name");
  }
  // Write to company_profile via existing helper
  // Use patchCompanyProfile which merges
  const existing = getCompanyProfile(db);
  if (!existing) {
    // Create via patch with full profile
    patchCompanyProfile(
      db,
      mergedPatch as Parameters<typeof patchCompanyProfile>[1],
    );
  } else {
    patchCompanyProfile(
      db,
      mergedPatch as Parameters<typeof patchCompanyProfile>[1],
    );
  }
  // Also seed people/departments if present. Enforce single principal:
  // if a principal already exists, new people are inserted as non-principal.
  let hasPrincipal = !!db
    .query<
      Record<string, unknown>,
      []
    >("SELECT id FROM people WHERE is_principal = 1 AND archived = 0 LIMIT 1")
    .get();
  const people = (draft["people"] as Array<Record<string, unknown>>) ?? [];
  for (const p of people) {
    const name = typeof p["full_name"] === "string" ? p["full_name"] : "";
    if (!name) continue;
    const existingPerson = db
      .query<
        Record<string, unknown>,
        [string]
      >("SELECT id FROM people WHERE full_name = ?")
      .get(name);
    if (!existingPerson) {
      const now = nowIso();
      const wantsPrincipal = Boolean(p["is_principal"]);
      const isPrincipal = wantsPrincipal && !hasPrincipal ? 1 : 0;
      db.run(
        "INSERT INTO people (full_name, role, is_principal, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        [name, (p["role"] as string) ?? "", isPrincipal, now, now],
      );
      if (isPrincipal) hasPrincipal = true;
    }
  }
  const departments =
    (draft["departments"] as Array<Record<string, unknown>>) ?? [];
  for (const d of departments) {
    const title = typeof d["title"] === "string" ? d["title"] : "";
    if (!title) continue;
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const existingDept = db
      .query<
        Record<string, unknown>,
        [string]
      >("SELECT slug FROM departments WHERE slug = ?")
      .get(slug);
    if (!existingDept) {
      db.run(
        "INSERT INTO departments (slug, title, charter_mission, updated_at) VALUES (?, ?, ?, ?)",
        [slug, title, (d["mission"] as string) ?? "", nowIso()],
      );
    }
  }
  db.run(
    "UPDATE onboarding_sessions SET saved = 1, updated_at = ? WHERE id = ?",
    [nowIso(), id],
  );
  return getSession(db, id);
}

export function sessionToResponse(
  session: OnboardingSession,
): Record<string, unknown> {
  if (session.draft) {
    const d = session.draft as Record<string, unknown>;
    return {
      session_id: session.id,
      phase: "draft",
      questions_asked: session.questions_asked,
      max_questions: 5,
      draft: d["profile"] ?? null,
      draft_people: d["people"] ?? [],
      draft_departments: d["departments"] ?? [],
      confidence_notes: d["confidence_notes"] ?? [],
      summary: d["summary"] ?? "",
    };
  }
  let question = "";
  for (let i = session.transcript.length - 1; i >= 0; i--) {
    if (session.transcript[i]!.role === "assistant") {
      question = session.transcript[i]!.text;
      break;
    }
  }
  return {
    session_id: session.id,
    phase: "question",
    questions_asked: session.questions_asked,
    max_questions: 5,
    question: question || "Tell me about your company",
  };
}

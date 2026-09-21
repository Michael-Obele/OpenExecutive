/**
 * Sessions — chat history.
 *
 * Port of `memory/session_store.py` + `api/routes/sessions.py`. One file owns
 * the types and store helpers so the route layer stays thin.
 *
 * Upstream scopes `GET /sessions` by caller_person_id (auth). Durbar has no
 * auth yet, so it returns all sessions newest-first. The scoping is noted for
 * the multiuser future — see the route comment in `src/index.ts`.
 *
 * Sessions are created by the chat flow; this module only reads them. The
 * helpers here are the read side plus the write helpers tests use to seed data.
 */

import type { Db } from "../../db.ts";

// ── types ──────────────────────────────────────────────────────────────────

export interface SessionSummary {
  session_id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface ChatMessage {
  role: string;
  content: string;
  actions?: unknown;
}

// ── helpers ────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

// ── store ──────────────────────────────────────────────────────────────────

export function createSession(
  db: Db,
  params: { session_id: string; title: string; caller_person_id?: number | null },
): void {
  const now = nowIso();
  db.run(
    "INSERT OR IGNORE INTO sessions (session_id, title, created_at, updated_at, caller_person_id) VALUES (?, ?, ?, ?, ?)",
    [params.session_id, params.title, now, now, params.caller_person_id ?? null],
  );
  if (params.caller_person_id !== undefined && params.caller_person_id !== null) {
    db.run("UPDATE sessions SET caller_person_id = ? WHERE session_id = ? AND caller_person_id IS NULL", [
      params.caller_person_id,
      params.session_id,
    ]);
  }
}

export function updateSessionTimestamp(db: Db, sessionId: string): void {
  db.run("UPDATE sessions SET updated_at = ? WHERE session_id = ?", [nowIso(), sessionId]);
}

export function saveMessage(
  db: Db,
  sessionId: string,
  role: string,
  content: string,
  actionChips?: string | null,
): void {
  db.run("INSERT INTO chat_messages (session_id, role, content, created_at, action_chips) VALUES (?, ?, ?, ?, ?)", [
    sessionId,
    role,
    content,
    nowIso(),
    actionChips ?? null,
  ]);
}

export function loadMessages(db: Db, sessionId: string): ChatMessage[] {
  const rows = db
    .query<Record<string, unknown>, [string]>(
      "SELECT role, content, action_chips FROM chat_messages WHERE session_id = ? ORDER BY id",
    )
    .all(sessionId);
  return rows.map((row) => {
    const msg: ChatMessage = { role: row["role"] as string, content: row["content"] as string };
    const raw = row["action_chips"] as string | null;
    if (raw) {
      try {
        const chips = JSON.parse(raw);
        if (chips) (msg as unknown as Record<string, unknown>)["actions"] = chips;
      } catch {
        // ignore malformed chips
      }
    }
    return msg;
  });
}

export function listSessions(db: Db): SessionSummary[] {
  const rows = db
    .query<Record<string, unknown>, []>(
      `SELECT s.session_id, s.title, s.created_at, s.updated_at, COUNT(m.id) AS message_count
       FROM sessions s
       LEFT JOIN chat_messages m ON m.session_id = s.session_id
       GROUP BY s.session_id
       ORDER BY s.updated_at DESC`,
    )
    .all();
  return rows.map((r) => ({
    session_id: r["session_id"] as string,
    title: r["title"] as string,
    created_at: r["created_at"] as string,
    updated_at: r["updated_at"] as string,
    message_count: Number(r["message_count"] ?? 0),
  }));
}

export function getSessionMetadata(db: Db, sessionId: string): SessionSummary | null {
  const row = db
    .query<Record<string, unknown>, [string]>(
      `SELECT s.session_id, s.title, s.created_at, s.updated_at, COUNT(m.id) AS message_count
       FROM sessions s
       LEFT JOIN chat_messages m ON m.session_id = s.session_id
       WHERE s.session_id = ?
       GROUP BY s.session_id`,
    )
    .get(sessionId);
  if (!row) return null;
  return {
    session_id: row["session_id"] as string,
    title: row["title"] as string,
    created_at: row["created_at"] as string,
    updated_at: row["updated_at"] as string,
    message_count: Number(row["message_count"] ?? 0),
  };
}

export function deleteSession(db: Db, sessionId: string): boolean {
  db.run("DELETE FROM chat_messages WHERE session_id = ?", [sessionId]);
  const result = db.run("DELETE FROM sessions WHERE session_id = ?", [sessionId]);
  return result.changes > 0;
}

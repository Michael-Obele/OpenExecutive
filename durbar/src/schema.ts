/**
 * Consolidated schema.
 *
 * The reference implementation (OpenExecutive, Python) has no single schema
 * file — roughly 40 tables are created ad-hoc across 18 store modules, so the
 * shape of the database can only be learned by reading all of them. This file
 * is the consolidation: one place, one migration list, SQLite.
 *
 * Each table records where it came from so the port stays auditable. Column
 * names, defaults and constraints are copied from the Python DDL rather than
 * re-invented, because those defaults are load-bearing (e.g. `authority_level`
 * defaulting to `propose_only` is what makes a new department safe by default).
 *
 * Known upstream defect, deliberately not reproduced: `voice_personas` is
 * created in BOTH `memory/episodic.py` and `personas/loader.py` upstream, so
 * whichever module runs first wins and a column change in one silently
 * diverges. It has a single owner here.
 */

export const SCHEMA_VERSION = 1;

export interface Migration {
  readonly id: number;
  readonly name: string;
  /** Idempotent: every statement must be safe to re-run. */
  readonly statements: readonly string[];
}

export const MIGRATIONS: readonly Migration[] = [
  {
    id: 1,
    name: "core",
    statements: [
      // ── departments ────────────────────────────────────────────────────
      // from: departments/store.py
      `CREATE TABLE IF NOT EXISTS departments (
        slug TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        specialist_key TEXT,
        charter_mission TEXT NOT NULL DEFAULT '',
        charter_scope_json TEXT NOT NULL DEFAULT '[]',
        charter_out_of_scope_json TEXT NOT NULL DEFAULT '[]',
        authority_level TEXT NOT NULL DEFAULT 'propose_only',
        head_person_id INTEGER,
        head_persona_slug TEXT,
        cadences_json TEXT NOT NULL DEFAULT '{}',
        headcount INTEGER,
        budget_usd REAL,
        updated_at TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS department_goals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        department_slug TEXT NOT NULL,
        period_type TEXT NOT NULL DEFAULT 'quarter',
        period_value TEXT NOT NULL,
        key_result TEXT NOT NULL,
        target TEXT NOT NULL,
        current TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'on_track',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_reviewed_at TEXT,
        FOREIGN KEY (department_slug) REFERENCES departments(slug)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_goals_dept
        ON department_goals(department_slug)`,
      `CREATE INDEX IF NOT EXISTS idx_goals_status
        ON department_goals(status)`,

      `CREATE TABLE IF NOT EXISTS departments_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,

      // ── people ─────────────────────────────────────────────────────────
      // from: people/store.py
      `CREATE TABLE IF NOT EXISTS people (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        full_name TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT '',
        is_principal INTEGER NOT NULL DEFAULT 0,
        department_slugs_json TEXT NOT NULL DEFAULT '[]',
        email TEXT,
        slack_user_id TEXT,
        telegram_chat_id TEXT,
        discord_user_id TEXT,
        preferred_channel TEXT NOT NULL DEFAULT 'any',
        response_sla_hours INTEGER NOT NULL DEFAULT 24,
        on_leave_until TEXT,
        reports_to_person_id INTEGER,
        archived INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (reports_to_person_id) REFERENCES people(id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_people_principal
        ON people(is_principal) WHERE archived = 0`,

      `CREATE TABLE IF NOT EXISTS person_authority_scope (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id INTEGER NOT NULL,
        scope_token TEXT NOT NULL,
        UNIQUE(person_id, scope_token),
        FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
      )`,
      `CREATE INDEX IF NOT EXISTS idx_pas_person
        ON person_authority_scope(person_id)`,
      `CREATE INDEX IF NOT EXISTS idx_pas_scope
        ON person_authority_scope(scope_token)`,

      `CREATE TABLE IF NOT EXISTS person_availability (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        person_id INTEGER NOT NULL,
        weekdays_json TEXT NOT NULL DEFAULT '[]',
        start_local TEXT NOT NULL,
        end_local TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'UTC',
        FOREIGN KEY (person_id) REFERENCES people(id) ON DELETE CASCADE
      )`,

      // ── alerts (proposals awaiting a decision) ─────────────────────────
      // from: alerts/store.py
      `CREATE TABLE IF NOT EXISTS alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        external_id TEXT,
        source TEXT NOT NULL,
        severity TEXT NOT NULL,
        headline TEXT NOT NULL,
        body TEXT NOT NULL,
        suggested_action TEXT DEFAULT '',
        topic_tags TEXT DEFAULT '[]',
        channels_attempted TEXT DEFAULT '[]',
        channels_delivered TEXT DEFAULT '[]',
        dedup_key TEXT DEFAULT '',
        status TEXT NOT NULL DEFAULT 'unread',
        created_at TEXT NOT NULL,
        UNIQUE(source, external_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_alerts_status
        ON alerts(status, created_at DESC)`,

      `CREATE TABLE IF NOT EXISTS mute_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pattern TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL
      )`,

      `CREATE TABLE IF NOT EXISTS user_preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        severity_threshold TEXT NOT NULL DEFAULT 'medium',
        quiet_hours_start TEXT DEFAULT '',
        quiet_hours_end TEXT DEFAULT '',
        quiet_hours_tz TEXT DEFAULT 'UTC',
        channels_enabled TEXT NOT NULL DEFAULT 'web',
        updated_at TEXT NOT NULL
      )`,

      // ── audit ──────────────────────────────────────────────────────────
      // from: audit/logger.py
      `CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ts TEXT NOT NULL,
        event_type TEXT NOT NULL,
        session_id TEXT,
        turn_id TEXT,
        actor TEXT,
        summary TEXT NOT NULL,
        details_json TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_log(ts DESC)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_log(session_id)`,
      `CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_log(event_type)`,

      // ── briefings ──────────────────────────────────────────────────────
      // from: briefing/narrative_cache.py
      // `scope` is the PRIMARY KEY, and it doubles as the watermark for
      // "since the last brief I actually delivered" — see sinceFor().
      `CREATE TABLE IF NOT EXISTS briefing_narrative (
        scope TEXT PRIMARY KEY,
        input_hash TEXT NOT NULL,
        narrative_text TEXT NOT NULL,
        generated_at TEXT NOT NULL
      )`,

      // ── workflow runs ──────────────────────────────────────────────────
      // from: workflows/persistence.py
      `CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id        TEXT PRIMARY KEY,
        workflow_name TEXT NOT NULL,
        title         TEXT NOT NULL,
        status        TEXT NOT NULL,
        inputs        TEXT NOT NULL,
        artifact      TEXT,
        error         TEXT,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_runs_workflow
        ON workflow_runs(workflow_name, created_at DESC)`,

      // ── migration bookkeeping ──────────────────────────────────────────
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
    ],
  },

  {
    id: 2,
    name: "knowledge",
    statements: [
      // Full-text index over the curated knowledge corpus, replacing the
      // reference implementation's ChromaDB + local ONNX embedding stack.
      //
      // FTS5 is not a like-for-like swap for embeddings — it matches terms, not
      // meaning, so a query using different vocabulary than the documents will
      // miss. It is the right trade here because the corpus is 96 curated files
      // that use the domain's own vocabulary, and the alternative cost 3.8 GB of
      // torch/CUDA to embed them on a CPU.
      //
      // One row per *section*, not per file: a whole 140-line document returned
      // as a single hit floods the prompt and buries the relevant passage.
      //
      // Metadata columns are UNINDEXED so MATCH searches prose only — a query
      // for "board" should not match every row whose domain happens to be
      // `board`. Verified that equality filters still work on UNINDEXED columns.
      `CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
        kind UNINDEXED,
        domain UNINDEXED,
        path UNINDEXED,
        title,
        summary,
        body,
        tokenize = 'porter unicode61'
      )`,
    ],
  },

  {
    id: 3,
    name: "scheduler",
    statements: [
      // The proactive half: rows that come due on their own.
      //
      // Upstream reaches this shape via `CREATE TABLE` followed by a series of
      // `ALTER TABLE ... ADD COLUMN` migrations (`kind`, `assigned_to_person_id`,
      // `awaiting_response_since`, `scope_key`, `required_scope`), plus
      // `department`/`session_id` added to every table by a loop. The columns are
      // declared together here because a fresh schema has no history to preserve —
      // the set is what matters, not the archaeology that produced it.
      `CREATE TABLE IF NOT EXISTS scheduled_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL,
        run_at TEXT NOT NULL,
        channel TEXT NOT NULL,
        channel_ref TEXT NOT NULL,
        intent_text TEXT NOT NULL,
        originating_session_id TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT DEFAULT '',
        department TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT '',
        kind TEXT NOT NULL DEFAULT 'ad_hoc',
        assigned_to_person_id INTEGER,
        awaiting_response_since TEXT,
        scope_key TEXT,
        required_scope TEXT
      )`,

      // The claim query is `status = 'pending' AND run_at <= ? ORDER BY run_at`,
      // so the index is on exactly that.
      `CREATE INDEX IF NOT EXISTS idx_scheduled_due
        ON scheduled_actions(status, run_at)`,

      // Partial index: only nudge rows ever set scope_key, so this stays small
      // regardless of how many ordinary actions accumulate.
      `CREATE INDEX IF NOT EXISTS idx_scheduled_scope_key
        ON scheduled_actions(scope_key, created_at DESC)
        WHERE scope_key IS NOT NULL`,
    ],
  },

  {
    id: 4,
    name: "company_profile",
    statements: [
      // from: memory/company_profile.py + api/routes/company_profile.py
      // Upstream is a YAML file; Durbar keeps it in SQLite so the whole state
      // is one file to back up. One row (id=1) — absence means onboarding has
      // not been completed, surfaced as 404.
      `CREATE TABLE IF NOT EXISTS company_profile (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        data TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,
    ],
  },

  {
    id: 5,
    name: "departments_channels_watched",
    statements: [
      // Upstream added these via ALTER TABLE; Durbar's migration 1 originally
      // declared them together, which violated append-only. This migration
      // restores append-only: id:1 is the original DDL, this adds the columns.
      // Each ALTER is idempotent via migrate() duplicate-column tolerance.
      `ALTER TABLE departments ADD COLUMN slack_channel_id TEXT`,
      `ALTER TABLE departments ADD COLUMN discord_channel_id TEXT`,
      `ALTER TABLE departments ADD COLUMN telegram_chat_id TEXT`,
      `ALTER TABLE departments ADD COLUMN watched_entities_json TEXT NOT NULL DEFAULT '[]'`,
    ],
  },

  {
    id: 6,
    name: "state_api_memories_sessions_artifacts",
    statements: [
      // ── episodic memories ────────────────────────────────────────────
      // from: memory/episodic.py
      `CREATE TABLE IF NOT EXISTS decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        domain TEXT NOT NULL,
        summary TEXT NOT NULL,
        rationale TEXT DEFAULT '',
        outcome TEXT DEFAULT '',
        tags TEXT DEFAULT '',
        department TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE TABLE IF NOT EXISTS initiatives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        summary TEXT DEFAULT '',
        department TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE TABLE IF NOT EXISTS advice_given (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        domain TEXT NOT NULL,
        query_summary TEXT NOT NULL,
        advice_summary TEXT NOT NULL,
        department TEXT NOT NULL DEFAULT '',
        session_id TEXT NOT NULL DEFAULT ''
      )`,

      // ── sessions ─────────────────────────────────────────────────────
      // from: memory/session_store.py
      `CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        caller_person_id INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL,
        action_chips TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(session_id)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_chat_messages_session
        ON chat_messages(session_id)`,

      // ── alerts lifecycle columns ─────────────────────────────────────
      // from: alerts/store.py additive migrations
      `ALTER TABLE alerts ADD COLUMN routed_to_person_id INTEGER`,
      `ALTER TABLE alerts ADD COLUMN archived_at TEXT`,
      `ALTER TABLE alerts ADD COLUMN last_seen_at TEXT`,
      `ALTER TABLE alerts ADD COLUMN occurrence_count INTEGER NOT NULL DEFAULT 1`,
      `ALTER TABLE alerts ADD COLUMN last_reviewed_at TEXT`,
      `ALTER TABLE alerts ADD COLUMN review_verdict TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE alerts ADD COLUMN review_note TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE alerts ADD COLUMN recommended_move TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE alerts ADD COLUMN why_now TEXT NOT NULL DEFAULT ''`,
      `ALTER TABLE alerts ADD COLUMN due_at TEXT`,
      `ALTER TABLE alerts ADD COLUMN superseded_by_alert_id INTEGER`,
      `ALTER TABLE alerts ADD COLUMN snoozed_until TEXT`,
      `ALTER TABLE alerts ADD COLUMN suggested_workflow TEXT NOT NULL DEFAULT ''`,

      // ── workflow_runs artifact archive ────────────────────────────────
      // from: workflows/persistence.py
      `ALTER TABLE workflow_runs ADD COLUMN archived_at TEXT`,
    ],
  },

  {
    id: 7,
    name: "documents",
    statements: [
      // from: api/routes/documents.py + knowledge/loader.py
      // Upstream stores files on disk under company/docs/ and indexes into
      // ChromaDB. Durbar stores them in SQLite so the whole state is one file.
      `CREATE TABLE IF NOT EXISTS company_documents (
        filename TEXT PRIMARY KEY,
        domain TEXT NOT NULL,
        content TEXT NOT NULL,
        size_bytes INTEGER NOT NULL,
        created_at TEXT NOT NULL
      )`,
    ],
  },

  {
    id: 8,
    name: "state_api_review_decisions_workflows_audit",
    statements: [
      // ── review queue ─────────────────────────────────────────────────
      // from: knowledge/review_store.py
      `CREATE TABLE IF NOT EXISTS review_items (
        item_id TEXT PRIMARY KEY,
        content_type TEXT NOT NULL,
        domain TEXT NOT NULL,
        filename TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'normal',
        reviewer_notes TEXT DEFAULT '',
        reviewed_at TEXT,
        registered_at TEXT NOT NULL,
        last_modified_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_review_status ON review_items(status)`,
      `CREATE INDEX IF NOT EXISTS idx_review_domain ON review_items(domain, status)`,
      `CREATE TABLE IF NOT EXISTS review_annotations (
        annotation_id TEXT PRIMARY KEY,
        item_id TEXT NOT NULL REFERENCES review_items(item_id) ON DELETE CASCADE,
        domain TEXT NOT NULL,
        correction TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_annot_domain ON review_annotations(domain, is_active)`,

      // ── decision ledger ──────────────────────────────────────────────
      // from: memory/decision_ledger.py + memory/episodic.py (decision DDL)
      `CREATE TABLE IF NOT EXISTS decision_instances (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        decision_class TEXT NOT NULL,
        created_at TEXT NOT NULL,
        department TEXT NOT NULL DEFAULT '',
        originating_session_id TEXT,
        proposed_payload_json TEXT NOT NULL,
        idempotency_key TEXT,
        gate_mode TEXT NOT NULL DEFAULT 'propose',
        approver_person_id INTEGER,
        confidence REAL,
        status TEXT NOT NULL DEFAULT 'proposed',
        resolved_at TEXT,
        resolver_person_id INTEGER,
        final_payload_json TEXT,
        external_event_id TEXT,
        reversal_reason TEXT,
        severity TEXT NOT NULL DEFAULT ''
      )`,
      `CREATE INDEX IF NOT EXISTS idx_di_class_created ON decision_instances(decision_class, created_at DESC)`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_di_idem ON decision_instances(idempotency_key) WHERE idempotency_key IS NOT NULL`,
      `CREATE TABLE IF NOT EXISTS decision_class_state (
        decision_class TEXT PRIMARY KEY,
        mode TEXT NOT NULL DEFAULT 'propose',
        updated_at TEXT NOT NULL,
        last_eval_json TEXT,
        breaker_tripped_at TEXT
      )`,

      // ── dynamic workflows ────────────────────────────────────────────
      // from: workflows/dynamic_store.py
      `CREATE TABLE IF NOT EXISTS dynamic_workflows (
        name TEXT PRIMARY KEY,
        definition TEXT NOT NULL,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )`,

      // ── workflow_runs additive columns ────────────────────────────────
      // from: workflows/persistence.py (Phase 6)
      `ALTER TABLE workflow_runs ADD COLUMN state_json TEXT`,
      `ALTER TABLE workflow_runs ADD COLUMN awaiting_person_id INTEGER`,
      `ALTER TABLE workflow_runs ADD COLUMN awaiting_until TEXT`,
      `ALTER TABLE workflow_runs ADD COLUMN resolution_json TEXT`,

      // ── audit additive columns ───────────────────────────────────────
      // from: audit/logger.py
      `ALTER TABLE audit_log ADD COLUMN full_json TEXT`,
      `ALTER TABLE audit_log ADD COLUMN department TEXT`,
    ],
  },
];

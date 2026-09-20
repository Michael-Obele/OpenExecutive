# Open Executive — AGENTS.md

Agent-facing source of truth for this repository. (Merged from `AGENTS.md` +
`CLAUDE.md` on 2026-09-20 — `CLAUDE.md` was Claude-generated rather than
hand-authored and has been deleted; everything still true from it lives here.)

## Stack (migration in progress)

| Layer      | Current                                | Target                                                             | Status    |
| ---------- | -------------------------------------- | ------------------------------------------------------------------ | --------- |
| Backend    | Python 3.11 FastAPI (`packages/core/`) | **Bun + SQLite** — see "Direction: porting to Bun"                 | Porting   |
| Frontend   | Next.js 15 (`packages/ui/`)            | SvelteKit 2 + Svelte 5 runes + Bun (`packages/web/`)               | Migrating |
| Vector/RAG | ChromaDB (`ChromaDBStore`)             | Unchanged                                                          | Current   |
| Memory     | SQLite `episodic_memory.db` + Honcho   | Unchanged (backend)                                                | Current   |
| Web auth   | Auth.js / NextAuth (`packages/ui/`)    | Better Auth (confirmed)                                            | Migrating |
| Web DB     | —                                      | Drizzle + PostgreSQL (web only)                                    | New       |
| UI kit     | Tailwind (Next.js)                     | Tailwind v4 + shadcn-svelte + TanStack headless + `@lucide/svelte` | Migrating |
| Data-fetch | Next.js routes / server actions        | SvelteKit remote functions + TanStack Query (Svelte)               | Migrating |

Do not add new Next.js routes unless fixing a live bug. The backend is being ported
to Bun — read "Direction: porting to Bun" below before adding anything to
`packages/core/`.

## Layout

- `packages/core/openexecutive/` — Executive, specialists, orchestrator, providers, workflows, integrations.
- `packages/ui/src/` — legacy Next.js UI. Frozen except fixes.
- `packages/web/` — SvelteKit target (scaffold via CLI, never hand-write). Svelte 5 runes only, Bun tooling.
- `knowledge/` — curated MBA docs. `fixtures/` — test companies. `evals/` — eval suite.
- `packages/core/company/` + `.env` — gitignored. Never commit.
- `company/` (repo root) — gitignored runtime dir: `profile.yaml`, uploaded `docs/`, and `notes/`.

### Public vs private writing

`docs/` is **public** and must stay generic: no personal figures, personal hostnames, accounts, prices, or plans. Anything that only makes sense for one operator or one deployment belongs in the gitignored `company/notes/` tree (e.g. `company/notes/fly-io-costs.md`, `company/notes/growth/<topic>.md`).

Keep plans in `company/notes/`, **not** `company/docs/` — the latter is indexed into ChromaDB as `company_docs` for RAG, so operator notes there become agent-retrieved company knowledge. Open the file from `company/notes/` when you need it, and when a fact in one of them changes project behaviour, record only the generic part in the tracked docs.

## Commands

```bash
make dev    # API :8000 + UI :3000, sources repo-root .env
make test   # cd packages/core && uv run pytest tests/ -v --tb=short
make lint   # cd packages/core && uv run ruff check openexecutive/ && uv run mypy openexecutive/
make eval   # eval suite against localhost
```

SvelteKit (once `packages/web/` exists): `bun run dev`, `bun run check` (`bun check`), autofixer validation.

## Standard web preferences (`packages/web/` only)

- **Runtime/tooling**: Bun only (`bun`, `bunx`). Install via `bun add <pkg>`; never edit `package.json` by hand. Format only edited files: `bunx prettier --write <file>` + `bunx prettier --check <file>`. Run `bun check` after substantive edits; fix errors immediately (warnings only may wait).
- **Framework**: SvelteKit + Svelte 5 runes only. `<script lang='ts'>` always. Events as `onclick`, `onsubmit`. No `export let`, no `$:`, no `on:click`, no `createEventDispatcher`, no `<slot />` (use `{@render children()}`), no `<svelte:component>` (render directly), no `$$props`/`$$restProps`, no `beforeUpdate`/`afterUpdate` (use `$effect.pre`/`$effect`). State via `$state` (`$state.raw` for large API payloads), derived via `$derived`/`$derived.by`, side effects via `$effect`. Use `$app/state` (not `$app/stores`).
- **Data**: Remote functions by default over `+page.server.ts` actions. Location `src/lib/remote/*.remote.ts`, re-exported individually from `src/lib/remote/index.ts`. Flavors: `query` (reads, `refresh()`/`loading`/`error`, `query.batch` for fan-out), `form` (mutations via `<form>` + `enhance`, bind with `form.fields.x.as('text')`, never hand-rolled `handleSubmit`), `command` (button/script mutations, `submit().updates(query)`), `prerender` (build-time). Validate with Valibot (+ `preflight(schema)` client-side). `+page.server.ts` / `+layout.server.ts` only for initial `load`. TanStack Query (`@tanstack/svelte-query`, confirmed with first-class Svelte support + SSR) is the client cache over remote `query` fns where needed.
- **DB**: Drizzle ORM + drizzle-kit, PostgreSQL, schema at `src/lib/server/db/schema.ts`, singleton client at `$lib/server/db`. `bun run db:push` for prototyping, `bun run db:migrate` for stable envs. Better Auth tables via `bun run auth:schema`. Web DB is separate from backend `episodic_memory.db`.
- **Auth (confirmed: Better Auth)**: use Better Auth, not Auth.js. Auth.js is in maintenance mode under the Better Auth team and is a dead end for new work; Better Auth has first-class SvelteKit support, DB-backed sessions via Drizzle (`drizzleAdapter`, `auth:schema`), and Google OAuth. Port the `packages/ui/src/auth.ts` roster contract (env fallback → `/auth/allowed-emails`, 5-min cache) as a Better Auth hook/guard.
- **UI split**: shadcn-svelte / Bits UI for most things (primitives: button, dialog, input, etc. — installed via official CLI, never hand-authored; no shadcn form components). TanStack headless for data-heavy parts: Table (`@tanstack/svelte-table`, v9 requires Svelte 5), Charts (`@tanstack/charts/svelte`), Hotkeys (`@tanstack/svelte-hotkeys`), Markdown + Highlight (docs / AI streams), Virtual (`@tanstack/svelte-virtual`, incl. virtualized tables), Pacer (framework-agnostic debounce/throttle/rate-limit/queue/batch). No TanStack Form. All forms are native HTML `<form>` + SvelteKit remote `form` functions (see Data rule). TanStack owns state/logic; shadcn + Tailwind own styling.
- **A11y**: every route passes WCAG AAA (contrast, legibility, hierarchy) before done; audit after each page/route change.
- **Layout**: `src/lib/remote/` (data), `src/lib/components/ui/` (CLI-generated primitives), `src/lib/components/blocks/` (shared) + route-named folders (route-specific), `src/routes/` (router), `static/` (assets).
- **Scaffold rule**: create `packages/web/` with the SvelteKit CLI template (`sv create` / `bunx sv create`), then add deps via CLI. Never hand-write the scaffold or upstream component source.
- **Docs**: `mcp_svelte_get-documentation` for Svelte 5/Kit logic, `mcp_svelte_svelte-autofixer` before finalizing components.

## Invariants (must-follow)

1. Prompt caching: never put dynamic content in cached system blocks. RAG/Honcho context goes in the user turn. Tool defs sorted by name. Persona constant never f-stringed. See `prompts/cache_manager.py`. **Note:** `cache_control` is Anthropic-proprietary syntax and the live config runs DeepSeek over an OpenAI-compatible endpoint, so this invariant only bites when `DEFAULT_MODEL` points at Claude.
2. Backend proxy contract: UI stamps `x-api-key: BACKEND_SHARED_SECRET`, strips `x-caller-*`, re-stamps identity from verified session. SvelteKit must preserve this. See `packages/ui/src/app/api/backend/[...path]/route.ts`, `src/auth.ts`.
3. SSE streaming must not buffer (Node runtime proxy today; SvelteKit equivalent required).
4. Knowledge collections stay separate: `builtin_knowledge` / `company_docs` / `recent_research` / `notion_wiki`. Never blend unvetted research into company docs.
5. Architecture docs: behavior change under a documented topic requires same-PR update to `prebuilt/<section_id>.json` + `architecture-facts.yaml`. New top-level module requires new `SectionSpec` + UI ID + JSON. Validate with `python -m json.tool`.

## SvelteKit rules

- Svelte 5 runes only: `$state`, `$derived`, `$props`, `$effect`. No `export let`, no `$:`.
- `<script lang='ts'>` always. Events as `onclick`, `onsubmit`.
- Data via remote `query` / `form` / `command` from `$app/server`. See `Svelte5docs.instructions.md`.
- Auth: Better Auth (confirmed). Port `packages/ui/src/auth.ts` roster logic (env fallback → `/auth/allowed-emails`, 5-min cache) as a Better Auth hook/guard.

## Direction: porting to Bun (decided 2026-09-20)

**The previous "stay on Python" note is superseded — it has been removed.** The
owner has decided to port this to a lean Bun + SQLite service: the same 28
workflows and behaviour, a fraction of the code and image size, hostable on a
256 MB Fly machine. Upstream is now a **reference implementation**: read it for
behaviour, port the intent, do not add features to it.

Why Python is being left behind: 88k source lines + 64k test lines, needing torch
and 15 `nvidia-*` CUDA packages (~3.8 GB) to run an embedding stack that is
CPU-only, producing a ~10 GB image — for a workload one person used 3 times.

Port rules:

- `packages/core/` is a **read-only reference**. Read it; don't grow it.
- **The spec is the tests**: `packages/core/tests/unit/` (236 files) and
  `packages/core/openexecutive/evals/` (42 yaml scenarios). Port the behaviour
  _and_ the tests for behaviours kept — they encode edge cases that are easy to
  silently lose (outbound dedup windows, quiet hours, `wait_for_human`
  resumption, roster gates).
- **Assets port as-is** (pure data, no logic): `knowledge/builtin/` — 96 files,
  13.5k lines of MBA-level material across `board`, `failures`, `finance`, `hr`,
  `legal`, `marketing`, `operations`, `product`, `skills`, `strategy` — and
  `personas/builtin/`.
- **Deferred, not dropped**: chat integrations (Discord, Telegram, Slack, email,
  Google Chat). Add them only if there is real demand.
- **Multi-provider from the start** (DeepSeek + OpenRouter); do not bake in
  Anthropic-only assumptions such as `cache_control`.
- **Storage**: SQLite (`bun:sqlite`) by default; Postgres when hosted multi-tenant.
- Cherry-pick upstream deliberately. Never track it commit-for-commit.

## Test gotchas

Run unit tests with `env -u BACKEND_SHARED_SECRET -u OE_PUBLIC_DEPLOYMENT`.

- **`BACKEND_SHARED_SECRET` set in your shell** makes full-app `TestClient` tests
  return `401` instead of their expected status. Unset it to match CI.
- **`OE_PUBLIC_DEPLOYMENT` is the same trap, harder:** `api/main.py` calls
  `create_app()` at module level, so with that var set and no
  `BACKEND_SHARED_SECRET` the guard raises at **import** time — the failure is a
  _collection_ error, not a test failure. `tests/conftest.py` pops it defensively.
- **Ad-hoc scripts** need `EXEC_EMAIL_ADDRESS` exported (it has no default)
  alongside `ANTHROPIC_API_KEY`.
- **uv:** `uv export/sync --frozen` does NOT detect a stale lock — `--locked` is
  the flag that fails on staleness. `uv export -o FILE` still echoes the export to
  stdout unless `-q`. CI gates lock freshness with `uv lock --check`.
- **Audit-log pollution:** `audit.log_event` writes to the default
  `./episodic_memory.db` unless the test isolates it, leaking rows that break
  _other_ modules' assertions in a full run. Patch it in an autouse fixture; delete
  a stray `packages/core/episodic_memory.db` if one appears.
- **Known-red on `main`:** `tests/integration/test_chat_committee.py::test_chat_with_committee_streams_phases_and_revised_text`
  fails on the base commit regardless of local changes. Deselect it when comparing
  full-suite runs.
- **Pre-existing ruff hits in `tests/unit/test_attachments.py`** (unsorted imports,
  unused `asyncio`): `make lint` only checks `openexecutive/`, so CI is unaffected —
  lint only the test files you touch.
- **`packages/ui` has no ESLint config** — `npm run lint` opens an interactive
  setup prompt. `npm run build` is that package's lint/type gate.

## How the agent system works (reference)

1. A message reaches `Executive` (`orchestrator/executive.py`).
2. The Executive uses tool use to call `consult_specialist` for relevant domains.
3. Cross-domain questions fan out to several specialists in parallel.
4. Each specialist gets its domain prompt from `prompts/domain_prompts.py`,
   retrieves ChromaDB chunks, and returns analysis.
5. The Executive synthesizes everything into **one voice**.
6. **The internal architecture is never exposed to the user.**

Specialists live in `orchestrator/router.py::SPECIALIST_REGISTRY`: `cso`, `cfo`,
`chro`, `gc`, `coo`, `cmo`, `cpo`, `board_comms`, `talent`, `triage`.

### Adding a specialist (mirror this whole list when porting)

1. `agents/your_agent.py` — subclass `BaseAgent` (`name`, `domain`, `model`,
   `get_system_prompt`).
2. Add the prompt constant to `prompts/domain_prompts.py`.
3. Register in `orchestrator/router.py`: `SPECIALIST_REGISTRY` **and** the
   `consult_specialist` tool's `enum`.
4. Add knowledge docs under the matching `knowledge/builtin/<domain>/`.
5. Add eval scenarios.
6. Update `architecture/architecture-facts.yaml` when the change introduces a new
   pattern (pure registry additions are auto-reflected).

## Architecture docs

The `/architecture` page is served from **static, hand-authored** JSON at
`packages/core/openexecutive/architecture/prebuilt/<section_id>.json` — one file per
section in `architecture/sections.py`. `api/routes/architecture.py` only reads
these; **nothing on that path calls an LLM.** They ship in the Docker image, so
they redeploy with any `packages/core/**` change.

**The common failure mode is new behaviour under an existing topic** (adding an
integration, or changing an endpoint's response shape). Nothing forces an update,
so the page silently goes stale. Treat it as a required same-PR change.

Topic → section: integrations → `integrations`; new workflow primitive →
`workflows`; cache layout → `caching`; new invariant → `overview`/`agents`; routing
→ `agents`/`lifecycle`; schema → `schemas`; endpoint change → `api`. A new
top-level module needs a `SectionSpec` **and** a matching UI id in the page
component, **and** a new JSON.

Each file has `section_id`, `title`, `markdown`, `mermaid` (string or null),
`generated_at`. The Markdown must not repeat the section heading (the UI renders
the title). Validate with `python -m json.tool`.

## Local hosts

`make dev` serves the API on http://localhost:8000 and the web app on :5173.

- `GET /architecture/sections` · `GET /architecture/sections/{id}`
- SQLite: `sqlite3 ./episodic_memory.db` (or `$EPISODIC_DB_PATH`)
- `GET /health` is exempt from the shared-secret gate so a platform health checker
  can reach it. Give a cold container ~5 minutes of startup grace: it builds the
  MCP tool-discovery index and loads Chroma before serving.

## PR requirements

- No stubs — working code only
- Tests for new behaviour
- Eval scenarios for new agents or prompt changes
- `ruff check` and `mypy` pass
- Architecture docs updated when integrations, scheduler, departments/people,
  caching, invariants, routing patterns, or top-level modules change
- Descriptive PR description explaining the change and rationale

## Workflow

For any task that writes, modifies, refactors, fixes, or plans code in this repo,
invoke the `anvil` skill (`.claude/skills/anvil/SKILL.md`) before editing — bug
fixes, features, refactors, and config changes, including small edits.
Research-only tasks (read, search, explain, summarize) do not require it.

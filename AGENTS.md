# Open Executive — AGENTS.md

Source of truth: `CLAUDE.md`. This file is the pointer. No duplication.

## Stack (migration in progress)

| Layer      | Current                                | Target                                                             | Status    |
| ---------- | -------------------------------------- | ------------------------------------------------------------------ | --------- |
| Backend    | Python 3.11 FastAPI (`packages/core/`) | Python (stay) — see rewrite note                                   | Current   |
| Frontend   | Next.js 15 (`packages/ui/`)            | SvelteKit 2 + Svelte 5 runes + Bun (`packages/web/`)               | Migrating |
| Vector/RAG | ChromaDB (`ChromaDBStore`)             | Unchanged                                                          | Current   |
| Memory     | SQLite `episodic_memory.db` + Honcho   | Unchanged (backend)                                                | Current   |
| Web auth   | Auth.js / NextAuth (`packages/ui/`)    | Better Auth (confirmed)                                            | Migrating |
| Web DB     | —                                      | Drizzle + PostgreSQL (web only)                                    | New       |
| UI kit     | Tailwind (Next.js)                     | Tailwind v4 + shadcn-svelte + TanStack headless + `@lucide/svelte` | Migrating |
| Data-fetch | Next.js routes / server actions        | SvelteKit remote functions + TanStack Query (Svelte)               | Migrating |

Do not start a backend rewrite. Do not add new Next.js routes unless fixing a live bug.

## Layout

- `packages/core/openexecutive/` — Executive, specialists, orchestrator, providers, workflows, integrations.
- `packages/ui/src/` — legacy Next.js UI. Frozen except fixes.
- `packages/web/` — SvelteKit target (scaffold via CLI, never hand-write). Svelte 5 runes only, Bun tooling.
- `knowledge/` — curated MBA docs. `fixtures/` — test companies. `evals/` — eval suite.
- `packages/core/company/` + `.env` — gitignored. Never commit.

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

1. Prompt caching: never put dynamic content in cached system blocks. RAG/Honcho context goes in the user turn. Tool defs sorted by name. Persona constant never f-stringed. See `prompts/cache_manager.py`, `CLAUDE.md`.
2. Backend proxy contract: UI stamps `x-api-key: BACKEND_SHARED_SECRET`, strips `x-caller-*`, re-stamps identity from verified session. SvelteKit must preserve this. See `packages/ui/src/app/api/backend/[...path]/route.ts`, `src/auth.ts`.
3. SSE streaming must not buffer (Node runtime proxy today; SvelteKit equivalent required).
4. Knowledge collections stay separate: `builtin_knowledge` / `company_docs` / `recent_research` / `notion_wiki`. Never blend unvetted research into company docs.
5. Architecture docs: behavior change under a documented topic requires same-PR update to `prebuilt/<section_id>.json` + `architecture-facts.yaml`. New top-level module requires new `SectionSpec` + UI ID + JSON. Validate with `python -m json.tool`.

## SvelteKit rules

- Svelte 5 runes only: `$state`, `$derived`, `$props`, `$effect`. No `export let`, no `$:`.
- `<script lang='ts'>` always. Events as `onclick`, `onsubmit`.
- Data via remote `query` / `form` / `command` from `$app/server`. See `Svelte5docs.instructions.md`.
- Auth: Better Auth (confirmed). Port `packages/ui/src/auth.ts` roster logic (env fallback → `/auth/allowed-emails`, 5-min cache) as a Better Auth hook/guard.

## Rewrite note (decision: stay on Python)

Full backend rewrite not advised (Python or TS/Bun or Go): ~72k LOC / 289 files / 242 tests, plus Python-only deps (ChromaDB, sentence-transformers, honcho-ai, pypdf/docx/openpyxl, slack-bolt/discord.py). Rewrite cost is months with eval/regression risk and no prompt-caching or latency gain (cost is Anthropic API-bound). If a rewrite is ever forced, TS+Bun (Elysia/Hono, Anthropic TS SDK with caching/tools/streaming, Chroma JS client, Vercel AI SDK) is the least-bad target: unified TS with SvelteKit, far better fit than Go (Go suits LLM gateways, not agent/RAG/ML logic). If ops footprint hurts, extract stateless edges (webhooks, ingest, scheduler runner) to separate services behind the same API contract. Keep agent core, prompts, RAG, evals in Python.

## Test gotchas

Run unit tests with `env -u BACKEND_SHARED_SECRET -u OE_PUBLIC_DEPLOYMENT`. See `CLAUDE.md` for `uv lock --check`, audit-log pollution, known-red test.

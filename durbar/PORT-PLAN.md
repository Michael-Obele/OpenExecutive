# Durbar — port plan

**Read this whole file before writing any code.** It is written to be self-contained: a
model starting cold should need no further briefing. If something here is ambiguous, read
the reference implementation rather than guessing — the reference is the spec.

---

## 1. Mission

**Durbar is a lean, self-hostable reimplementation of OpenExecutive.**

OpenExecutive is a genuinely good design — one coherent executive voice, a council of
specialists behind it, company context in every answer, and a set of proactive workflows
that brief you without being asked. Running it, though, meant ~88k lines of Python, a
**10 GB** Docker image, and a dependency on several hosted services.

The 10 GB came almost entirely from one thing: a local ONNX embedding stack reached via
`sentence-transformers`, which dragged in `torch` plus 15 `nvidia-*` CUDA packages
(**3.8 GB installed**) to do retrieval over a few dozen Markdown files, on machines with no
GPU. Durbar replaces that with SQLite FTS5, which lives in the same file as everything
else.

**The goal is the same product, at a size you can actually self-host.** Same behaviour,
a fraction of the code and image size, one container, one SQLite file, no third-party
accounts required.

**Durbar is a port, not a fork.** It reproduces *behaviour*. It does not track upstream's
code, and upstream is never merged wholesale.

---

## 2. Corrections to earlier briefings — read this first

Two numbers that were repeated earlier in the project are **wrong**. Do not work from them.

| Claim | Reality |
| --- | --- |
| "28 workflows" | **31 workflows.** Enumerated in §6.1. A port that stops at 28 silently skips three. |
| "~72k LOC" | **88,297 lines** of Python across 289 files, plus 64,409 lines of tests. |

Also: earlier project notes said *"do not start a backend rewrite."* That instruction has
been **superseded**. This port is the decided direction, and `AGENTS.md` in the parent repo
now says so.

---

## 3. The reference implementation

`packages/core/` in the parent repository (`OpenExecutive`). It is a **read-only
reference**: read it, port the intent, **never add features to it**.

Key entry points when you need to understand a behaviour:

| What | Where |
| --- | --- |
| The workflow catalogue | `packages/core/openexecutive/workflows/__init__.py` (`WORKFLOW_REGISTRY`) |
| Specialist roster + routing | `orchestrator/router.py` (`SPECIALIST_REGISTRY`, `SPECIALIST_DESCRIPTIONS`, `SPECIALIST_TOOLS`) |
| Domain prompts | `prompts/domain_prompts.py` (9) + `prompts/triage_prompt.py` (1) |
| The scheduler | `scheduler/runner.py`, plus `memory/episodic.py` (`scheduled_actions` store) |
| Knowledge retrieval | `knowledge/retriever.py`, `knowledge/store.py` |
| The API surface | `api/routes/*.py` (35 files) — 153 paths; `curl localhost:8000/openapi.json` when running |
| **The real spec** | `packages/core/tests/unit/` (236 files) and `openexecutive/evals/` (42 yaml scenarios) |

**The tests are the specification.** They encode edge cases that are easy to lose silently:
outbound dedup windows, quiet hours, `wait_for_human` resumption, roster gates, the
fail-open outbound guard, watermark semantics. When you port a behaviour, read its test.

---

## 4. Decisions already made — do not relitigate

These were settled deliberately. Reopening them wastes the work that settled them.

| Decision | Rationale |
| --- | --- |
| **Bun + SQLite**, not Python, not Node | One runtime for server + MCP + dashboard. `bun:sqlite` and `bun test` are built in. |
| **SQLite FTS5 for retrieval**, not embeddings | Term matching, not meaning — accepted because the corpus is curated and uses its own vocabulary. The alternative was 3.8 GB of CUDA on CPU-only machines. |
| **Multi-provider from the start** (DeepSeek + OpenRouter + any OpenAI-compatible endpoint) | Upstream is Anthropic-native and bolted a second provider on later under a misleading name (`LOCAL_MODELS_*`), which cost real time to unpick. |
| **No prompt caching** | `cache_control` is Anthropic-proprietary syntax. DeepSeek and OpenRouter cache server-side unprompted. There is nothing to configure. |
| **Chat integrations deferred** (Slack, Discord, Telegram, email, Google Chat) | Each is a permanent maintenance surface. They exist so a non-technical user can reach it from Slack — a product feature, not a personal one. Listed in the README as requestable. |
| **Integrations are out; MCP is in** | An MCP client already reaches the same state, and the owner prefers MCP. |
| **`src/features/<feature>/` layout** | Each feature owns its directory. Features talk to the DB through `db.ts` and to models through `providers.ts`, never to each other's internals. |
| **A fresh schema, not migration archaeology** | Upstream reaches its schema via `CREATE` plus a series of `ALTER TABLE` statements across 18 modules. A new database has no history to preserve, so the columns are declared together. |
| **Port all 31 workflows** | Owner's explicit decision. Do not unilaterally trim. |

---

## 5. What is already built — do not rebuild

`durbar/` currently contains **11 source files, 2,575 lines, 105 tests, tsc clean.**

```
src/
├── index.ts                 Bun.serve — /health, briefings, council, scheduler routes
├── config.ts                Env + provider selection (deepseek | openrouter | compat)
├── db.ts                    bun:sqlite client + idempotent migrations
├── schema.ts                The whole database, in one file (3 migrations)
├── providers.ts             One OpenAI-compatible client, parameterised per vendor
└── features/
    ├── briefings/morning-brief.ts    context → synthesize → watermark → persist
    ├── council/specialists.ts        nine domain prompts, ported verbatim
    ├── council/council.ts            select → consult → synthesize
    ├── knowledge/documents.ts        parses the three corpus shapes
    ├── knowledge/knowledge.ts        FTS5 index, search, prompt rendering
    └── scheduler/scheduler.ts        claim, retry, defer, chain
knowledge/builtin/           96 documents, 13,526 lines (copied as data)
```

**Built:** consolidated schema (15 tables) · multi-provider client · HTTP server ·
`morning_brief` (**1 of 31** workflows) · the council (**9 of 10** specialists) · the
knowledge base with FTS5 retrieval · the scheduler.

**Verify the baseline before you start:** `bun test` (105 pass) and `bun check` (clean).
If either is red, fix that first — you have a broken starting point, not a bug to port around.

---

## 6. The remaining scope

### 6.1 Workflows — 30 remaining of 31

Only `morning_brief` is done. The full catalogue, in upstream's registry order:

```
 1. annual_plan                17. engagement_value_report
 2. department_check_in        18. investor_update
 3. board_prep                 19. ma_evaluation
 4. candidate_outreach         20. mbr
 5. candidate_screen           21. offer_approval
 6. churn_deep_dive            22. new_hire_onboarding
 7. comp_refresh               23. org_design
 8. competitive_teardown       24. performance_review
 9. crisis_comms               25. pricing_review
10. morning_brief        ✅     26. product_strategy
11. end_of_day_digest          27. quarterly_plan
12. executive_reflection       28. reference_check
13. exec_search_brief          29. risk_register
14. fundraising_prep           30. role_onboarding
15. gtm_launch                 31. executive_research
16. interview_coordination
```

Each lives at `packages/core/openexecutive/workflows/<name>.py`. They are **thin** — the
`morning_brief` reference is 240 lines for two steps. Most are prompt + context assembly +
a rendered Markdown artifact. The weight is in the stores they read, not the workflow.

**Note the three that are easy to miss:** `end_of_day_digest`, `executive_reflection`, and
`executive_research` are the *scheduled* ones — they run without being asked, and are the
only workflows the owner has actually used in production.

### 6.2 The state API — nothing can currently be configured

**This is the most urgent gap.** Today you cannot add a goal, a person, or a department
without hand-writing SQL. The reference exposes **153 paths**; Durbar exposes 7.

Grouped by resource, from `api/routes/`:

| Group | Representative paths |
| --- | --- |
| **Company** | `GET/PATCH /company-profile` |
| **Departments** | `GET/POST /departments`, `GET/PATCH/DELETE /departments/{slug}`, `GET/POST /departments/{slug}/goals`, `PATCH/DELETE .../goals/{id}`, `.../okrs` (deprecated aliases) |
| **People** | `GET/POST /people`, `GET/PATCH /people/{id}`, `/people/{id}/archive`, `/people/by-scope/{token}` |
| **Briefing** | `GET /today`, `/today/activity`, `/today/activity/daily`, `/morning-brief` |
| **Chat** | `POST /chat` (SSE stream), `/chat/upload`, `/chat/suggested-prompts` |
| **Sessions** | `GET /sessions`, `/sessions/{id}`, `/sessions/{id}/messages` |
| **Memories** | `/memories/decisions`, `/memories/initiatives`, `/memories/advice` (+ `PATCH`/`DELETE` by id) |
| **Artifacts** | `GET /artifacts`, `/artifacts/{id}`, `/archive`, `/restore` |
| **Alerts** | `GET /alerts/review`, `/alerts/{id}/ack`, `/reopen`, `POST /alerts/bulk-ack` |
| **Decisions** | `GET /decisions`, `POST /decisions/{id}/approve`, `/reject`, `/cancel` |
| **Review queue** | `/review/items`, `/review/items/{id}`, `/review/annotations`, `/review/stats`, `POST /review/bulk-approve` |
| **Scheduled** | `GET /scheduled`, `/scheduled/{id}` |
| **Workflows** | `GET /workflows`, `GET/POST /workflows/{name}`, `/workflows/{name}/runs`, `/workflows/runs`, `/workflows/custom/*` |
| **Audit** | `/audit/logs`, `/audit/logs/{id}`, `/audit/usage`, `/audit/reliability`, `/audit/sessions/{id}` |
| **Knowledge** | `/knowledge/builtin`, `/knowledge/search`, `/knowledge/failures`, `/knowledge/external` |
| **Documents** | `GET/POST /documents`, `/documents/{filename}` |
| **Talent** | `/candidates`, `/candidates/{id}/stage`, `/similar`, `/archive`, `/engagements`, `/engagements/{id}/matches`, `/offers`, `/offers/{id}/extend`, `/offers/{id}/decision` |
| **Watchlist** | `/watchlist`, `/watchlist/{slug}`, `/approve`, `/decline`, `/signals` |
| **Clients** | `/clients`, `/clients/{slug}`, `/clients/cockpit`, `/clients/generate`, `/clients/save`, `/activate` |
| **Onboarding** | `/onboard/*` (interview lifecycle), `/onboarding-plans/*`, `/onboarding-tasks/*`, `/onboarding-templates/*` |
| **Staff onboarding** | `/onboarding-plans/{id}/advance`, `/tasks`, `/activate`, `/archive` |
| **Agents** | `/agents`, `/agents/models`, `/agents/{id}/override`, `/history`, `/rollback`, `/test` |
| **Personas** | `/personas`, `/personas/{slug}`, `/personas/{slug}/reset` |
| **Skills** | `/skills`, `/skills/search`, `/skills/{name}` |
| **Evals** | `/evals/scenarios`, `/evals/runs`, `/evals/runs/{id}/cancel` |
| **Architecture** | `/architecture/sections`, `/architecture/sections/{id}` |
| **Guide** | `/guide/sections`, `/guide/sections/{id}` |
| **Fixtures** | `/fixtures`, `/fixtures/{name}/load`, `/unload`, `/snapshot`, `/reset`, `/generate` |
| **Health** | `/health`, `/health/honcho` |
| **Webhooks** | `/webhook/telegram`, `/webhook/google-chat` — **deferred** |

Read `api/routes/<group>.py` for each. Port the *behaviour*, including the guards: roster
gating, authority scopes, principal protection, and the outbound anti-spam guard.

### 6.3 The tenth specialist — `triage`

Nine of ten are ported. `triage` (Chief of Staff) is deliberately absent from the council
because it does not answer questions — it **classifies inbound events for significance and
decides alerting**. Its prompt is `prompts/triage_prompt.py`; its agent is
`agents/triage.py`. Port it with the alerting/inbound work, not into the council.

### 6.4 The dashboard — 32,844 lines

`packages/web/` — **254 files, 38 routes, 187 components, 3 remote functions.**

This is the largest single remaining item. Port it as the same SvelteKit app, with one
architectural change: **the dashboard talks to the Durbar server over HTTP** for chat and
workflow runs, because those are LLM calls and SSE streams that a Netlify function cannot
perform. It does *not* read the database directly.

Use SvelteKit **remote functions** (`query` / `form` / `command` from `$app/server`) as the
dashboard's own boundary — types, SSR, Valibot validation — with each one calling the server
underneath. That is the intended layering, not a compromise.

### 6.5 The MCP server — 3,171 lines

`packages/mcp/` — 14 files, **8 resource tools** exposing ~100 actions:
`artifacts`, `company`, `departments`, `knowledge`, `operations`, `people`, `talent`,
`watchlist`. Built on TMCP. Port into `durbar/packages/mcp/`.

This is the path that makes the chat integrations unnecessary, so it is higher value than
it looks.

### 6.6 Supporting features, by size

| Feature | Reference | Notes |
| --- | --- | --- |
| **Talent** | `talent/` 1,659 lines | Candidates, engagements, offers, interview coordination, reference checks. 6 workflows depend on it. |
| **Monitoring / watchlist** | `monitoring/` 8,431 lines | External signals, page watch, watchlist policy. The second-largest module. |
| **Alerts** | `alerts/` 2,992 lines | Store, review queue, dispatcher, **nudge engine** (667 lines). |
| **Briefing** | `briefing/` 1,597 lines | Narrative synthesis + `brief_state` (the watermark `morning_brief` already uses). |
| **Clients** | `clients/` 1,817 lines | Practice clients, cockpit, generation. |
| **Onboarding** | `onboarding/` 1,482 lines + `staff_onboarding/` 1,365 | Two distinct things: company onboarding (interview → profile) and staff onboarding (templates, plans, tasks). |
| **Committee review** | `orchestrator/committee_reviewers.py` | Three reviewers plus a revision pass on high-stakes answers. A real differentiator. |
| **Evals harness** | `evals/` 1,112 lines | LLM-judge regression testing. 42 scenarios. |
| **Audit** | `audit/` 1,005 lines | Every action logged. Several features read it. |
| **Architecture docs** | `architecture/` 1,149 lines | Static hand-authored JSON per section. **Nothing on that path calls an LLM.** |
| **Fixtures** | `fixtures/` 1,032 lines | Demo companies for testing. |
| **Guide** | `guide/` 197 lines | The `/guide` page. |
| **CLI** | `cli/` 1,591 lines | Command-line entry. |
| **Personas** | `personas/builtin/` | **10 Markdown files — pure data, port as-is.** |

### 6.7 Data assets still to copy

- **Personas:** `personas/builtin/` — 10 files (`andy-jassy`, `brian-chesky`, `dario-amodei`,
  `default`, `jensen-huang`, `mark-zuckerberg`, `patrick-collison`, `satya-nadella`,
  `sundar-pichai`, `tim-cook`).
- **Fixtures:** `fixtures/companies/` — three demo companies (halcyon_motors,
  meridian_petroleum, tandem_robotics).
- ✅ **Knowledge:** already copied (96 files, including 17 failures and 15 skills).

---

## 7. Recommended sequencing

The order matters: the first two items are what make the thing *usable by hand*. Without
them nothing can be configured and nothing can be seen.

| Phase | What | Why here |
| --- | --- | --- |
| **1** | **State API** — company, departments, goals, people, alerts, memories, artifacts, sessions | Today you cannot add a goal without SQL. Nothing else can be exercised until this exists. |
| **2** | **Dashboard** — port `packages/web` against that API | Nothing can be seen. Also the largest item, so it wants to start early. |
| **3** | **Scheduled workflows** — `end_of_day_digest`, `executive_reflection`, `executive_research` | These are the three the owner actually uses. `executive_research` also exercises the council end-to-end. |
| **4** | **MCP server** — port `packages/mcp` | Makes the whole state reachable from an agent, and removes the need for chat integrations. |
| **5** | **Remaining 27 workflows** | Long tail. Each is prompt + context assembly. Batch them. |
| **6** | **Supporting features** — talent, watchlist, alerts/nudges, briefing, clients, onboarding, committee review, evals, fixtures, personas | Port with the workflows that depend on them, not before. |

**Do not start with `ma_evaluation` or `annual_plan`.** They are the largest workflows and
depend on state that does not exist yet.

---

## 8. Conventions — must match

Violating these produces code that works but does not belong.

**TypeScript**
- `bun` and `bunx` only. Never hand-edit `package.json`; use `bun add`.
- `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`,
  `noUnusedParameters` are all on. Code must pass `bun check` (`tsc --noEmit`).
- **No DOM lib.** `lib: ["ESNext"]`, `types: ["bun"]`. So `HeadersInit`, `Response`, and
  friends are not ambient — use `Record<string, string>` for header bags. (This caught a
  real error: `Cannot find name 'HeadersInit'`.)
- File extensions in imports: `./db.ts`, not `./db`.
- Every exported function gets a doc comment **explaining why it exists**, not what it does.
  Look at the existing files — the comments carry the reasoning, including what was
  deliberately *not* done.

**Testing**
- `bun test`. Tests live beside the code as `<name>.test.ts`.
- **A test must verify what its name claims.** A test named "is quiet" that asserts
  `suppressed === false` is worse than no test — that happened and had to be fixed.
- Test the **failure modes**, not the happy path: routing returning garbage, a specialist
  throwing, a malformed FTS query, a crashed scheduler row, a deferral.
- Use a `scriptedProvider` / `fakeProvider` so no test touches the network.

**Schema**
- One file (`src/schema.ts`), append-only migrations with ascending ids.
- Every statement idempotent (`IF NOT EXISTS`).
- Record **where each table came from** in a comment.

---

## 9. Gotchas — learned the hard way, do not rediscover

**FTS5**
- **`and`, `or`, `not`, `near` are FTS5 operators AND long enough to survive a length
  filter.** Filter them **by name**. Leaking one produced `... OR and`, matching 74 rows.
- A malformed `MATCH` **throws**; it does not return empty. Catch it — a bad query must
  never fail a turn.
- An **empty query string is a syntax error**, not "no results". Return `""`.
- `UNINDEXED` columns still support `WHERE domain = ?` alongside `MATCH`.
- **`RETURNING` does not preserve the subquery's `ORDER BY`.** Sort in code if order matters.
- Split sections on `##` but **track fenced code blocks** — the strategy docs contain `#`
  inside ``` fences.

**Scheduler**
- `attempts` is incremented **at claim time**, not on failure. That is what makes the
  backoff map keys line up.
- **A deferral must undo that increment** (`MAX(0, attempts - 1)`). Without it, three
  deferrals exhaust the budget and the action fails permanently on its first real run.
- Only `pending` rows are ever claimed, so a row stranded in `running` by a crash is stuck
  forever — sweep it at startup.
- Recurrence is **chaining**, not cron. A delivery enqueues its own next occurrence.

**Briefings**
- The window is *"since the last brief I actually delivered"* (from
  `briefing_narrative.generated_at`), **not** "the last 24 hours". Cold store falls back to 24h.
- Monitoring and watchlist findings are **excluded** from proposals — they are not decisions.
- When the context is empty the brief **suppresses to one line and never calls the model**.
  Any test asserting on a provider failure must first give it something to report.

**Docker / build** (parent repo)
- The API image installs **only `git`** — a `curl`-based healthcheck can never pass.
- `sentence-transformers` → `torch` → 15 `nvidia-*` packages = 3.8 GB. It is **gone**; do
  not reintroduce it for the convenience of `SentenceTransformer(...)`.

**Verification hygiene**
- Editor/lint diagnostics can be **stale mid-edit**. `bun check` and `bun test` are
  authoritative; trust them over an inline error.
- A `grep` filter can hide the very lines you are looking for. That produced a false
  "the tree is mangled" conclusion. Read the file.

---

## 10. Environment

```bash
cd durbar
bun install          # one time, ~21 MB (typescript + @types/bun)
bun test             # 105 pass at baseline
bun check            # tsc --noEmit, clean at baseline
bun run db:init      # create the database
bun run start        # serve on :8787
```

**Runtime needs zero installs** — `bun:sqlite`, `bun test`, and `fetch` are built in.
`bun install` is only needed for typechecking.

**The owner is often on metered mobile data.** State the download size before running
anything that fetches — installs, builds, model pulls. Keep the footprint small; treat
every hundred MB as significant. Prefer measuring locally (`du`, `docker images`, lockfile
parsing) over downloading to find out.

Env vars (see `.env.example`): `DURBAR_PROVIDER`, `DEEPSEEK_API_KEY` /
`OPENROUTER_API_KEY` / `DURBAR_BASE_URL`+`DURBAR_API_KEY`, `DURBAR_PORT`, `DURBAR_DB_PATH`,
`DURBAR_PUBLIC_URL`, `DURBAR_ALLOWED_ORIGINS`, `PRINCIPAL_BRIEF_MORNING_TIME`.

### Deployment tiers — one build serves all four

| Tier | Shape | Config |
| --- | --- | --- |
| 1. Local *(default)* | Everything in one container | nothing |
| 2. Hosted all-in-one | All of it on Fly/Render | nothing |
| 3. Split | Bun backend on Fly/Render, frontend on Vercel/Netlify | `DURBAR_PUBLIC_URL` + `DURBAR_ALLOWED_ORIGINS` |
| 4. MCP only | Publish the MCP to npm, run it locally | npm |

The dashboard must **never assume it is same-origin with the server.** `DURBAR_PUBLIC_URL`
defaulting to same-origin is the only difference between tiers 1 and 3.

---

## 11. Explicitly out of scope

Do not build these. They are deferred by decision, not forgotten, and are listed in
`README.md` under *"Not built yet — ask and it gets built"*:

Slack · Telegram · Discord · email · Google Chat · web search · Honcho per-person memory.

If someone asks for one, add it — but do not add it speculatively.

---

## 12. Definition of done

A phase is done when **all** of these hold:

- [ ] `bun test` passes, including new tests for the new behaviour
- [ ] `bun check` is clean
- [ ] The behaviour was compared against the reference implementation, not invented
- [ ] Edge cases from the reference's tests were ported for the behaviour kept
- [ ] Verified by running it, not by reading it — a route returns the right status, a
      workflow produces an artifact, a scheduler tick does the right thing
- [ ] `README.md` updated if the user-visible surface changed
- [ ] Committed as a coherent unit, with a message explaining **why**, not what

**Do not report a phase complete on the strength of a passing test alone.** Run the thing.

---

## 13. Working agreements

- **Never present unverified code.** Run it first.
- **Say when you are wrong.** Two assumptions in this project's history were confidently
  wrong and cost time: that a `curl` healthcheck worked (it could never pass), and that a
  file was mangled when a `grep` filter was hiding the lines. Correcting quickly beats
  defending.
- **Push back once, then execute.** If a request looks wrong, say so with the evidence.
  If the owner decides anyway, build it — it is their call, and relitigating wastes the
  decision.
- **Commit as you go**, in logical groups, so progress is never stranded in a working tree.
- **Report what you did not do.** If a step was skipped or a claim is untested, say so
  plainly. An honest gap is recoverable; a silent one is not.

# Durbar

**A self-hostable AI executive team.** Specialists, briefings and company memory
that run on your own machine, in one process, backed by one SQLite file.

> _durbar (Persian/Urdu via Hindi — the court of a ruler, where counsel is given
> and business is conducted)_

> **Based on the idea and design of [OpenExecutive](https://github.com/SenteLabsAI/OpenExecutive)**
> (Apache-2.0, by SenteLabsAI). Durbar is an independent, from-scratch
> reimplementation — a port of its behaviour, not a fork of its code. See
> [Relationship to OpenExecutive](#relationship-to-openexecutive).

---

## Why this exists

OpenExecutive is a genuinely good design: one coherent executive voice, a
council of specialists behind it, and company context in every answer. Running
it, though, meant ~88k lines of Python, a 10 GB image, and a dependency on
several hosted services.

The 10 GB came almost entirely from one thing: a local ONNX embedding stack
reached via `sentence-transformers`, which dragged in `torch` and 15 `nvidia-*`
CUDA packages — **3.8 GB to do retrieval over a few dozen Markdown files**, on
machines with no GPU. Durbar replaces that with SQLite's FTS5, which lives in the
same file as everything else.

The goal is the same product, at a size you can actually self-host.

## Deployment

Durbar is designed so **the same build serves all four of these** — the only
difference is configuration, never a code branch.

|                              | Shape                                                    | Notes                                      |
| ---------------------------- | -------------------------------------------------------- | ------------------------------------------ |
| **1. Local** _(the default)_ | Everything in one container: server, database, dashboard | Nothing external. No third-party accounts. |
| **2. Hosted, all-in-one**    | The whole thing on one service (Fly.io, Render)          | One deploy, one volume for the SQLite file |
| **3. Split**                 | Bun backend on Fly/Render, frontend on Vercel/Netlify    | Set `DURBAR_PUBLIC_URL` on the frontend    |
| **4. MCP only**              | Run the MCP server locally against your own database     | No dashboard at all                        |

The dashboard never assumes it is same-origin with the server. `DURBAR_PUBLIC_URL`
defaults to same-origin (tier 1) and is the only thing that changes for tiers 2–3.

## Quick start

Requires [Bun](https://bun.sh). No other dependencies — `bun:sqlite`, `bun test`
and `fetch` are built in.

```bash
cp .env.example .env      # then set your provider key
bun run db:init           # create the database
bun test                  # run the suite
bun run start             # serve on :8787
```

## Model providers

Multi-provider from the start — `DURBAR_PROVIDER` selects one:

| Value                  | Endpoint                       | Key                                  |
| ---------------------- | ------------------------------ | ------------------------------------ |
| `deepseek` _(default)_ | `api.deepseek.com`             | `DEEPSEEK_API_KEY`                   |
| `openrouter`           | `openrouter.ai/api/v1`         | `OPENROUTER_API_KEY`                 |
| `compat`               | Any OpenAI-compatible endpoint | `DURBAR_BASE_URL` + `DURBAR_API_KEY` |

All three share one implementation, because they speak the same wire protocol.

> **Note on caching.** There is deliberately no prompt-cache configuration.
> `cache_control` is Anthropic-proprietary syntax; DeepSeek and OpenRouter cache
> server-side unprompted. If you add a provider that needs explicit cache
> breakpoints, add it as its own provider rather than threading the concept
> through everything.

## Knowledge

The corpus is **96 curated Markdown files (13,526 lines)** across ten domains —
`board`, `finance`, `hr`, `legal`, `marketing`, `operations`, `product`,
`strategy`, plus a **failure library** (17 real post-mortems: Quibi, FTX,
Theranos, New Coke…) and a **skill library** (15 templates: board deck, layoff
comms, role scorecard…). It is ported as pure data.

Three document shapes live in it, and each is parsed for what it actually
carries:

| Shape | Frontmatter | What is indexed |
| --- | --- | --- |
| `domain/<name>.md` | none | title + first paragraph as summary |
| `failures/<domain>/<n>.md` | `company`, `year`, `topic`, `failure_type[]` | company/year/topic, so cases are searchable *by situation* |
| `skills/<domain>/<n>.md` | `description`, `when_to_use` | both, because `when_to_use` says when the skill applies |

**Retrieval is SQLite FTS5, not embeddings.** That trade is deliberate and worth
being honest about: FTS5 matches *terms*, not *meaning*, so a question phrased in
different vocabulary than the documents will miss. It is acceptable here because
the corpus is curated and uses its domain's own vocabulary — and the alternative
was **3.8 GB of torch/CUDA** to embed it on machines with no GPU.

Three details make term matching work well enough:

- **Section-level chunks** (817 of them). A whole 140-line document as one hit
  floods the prompt and buries the passage that mattered.
- **Frontmatter summaries are indexed**, which is what lets *"I'm preparing for a
  board meeting"* find `board-prep-deck` — a body-text match would never connect
  those words.
- **Queries are sanitised before they reach `MATCH`.** FTS5 has its own syntax,
  and a user's question is not written in it: `and`/`or`/`not`/`near` are real
  operators, and an unbalanced quote is a hard error. Terms are reduced to
  alphanumeric tokens, operator keywords dropped, and joined with `OR` — which
  also raises recall, since FTS5's implicit `AND` would demand every term match.

Retrieved text is **data, not instructions**. It is fenced and labelled as
background in the prompt, and failure cases are emitted inside a
`<failure_cases>` block — a contract the specialist prompts already read.

Rebuilding the index takes **~106 ms** for all 96 documents, so it happens on
every boot and can never drift from the corpus on disk.

## The scheduler

This is what makes Durbar proactive rather than a question-answering box. A
`scheduled_actions` row comes due on its own and runs.

**Recurrence is chaining, not cron.** A daily brief delivers, then enqueues its
own next occurrence. There is no cron expression anywhere — the schedule is
data, and a missed day cannot drift the series. Seeding at startup is deduped,
so a restart never stacks a second brief for the same morning.

Four semantics carry the weight, and each is a silent failure if wrong:

| Behaviour | Why it matters |
| --- | --- |
| **Claim is atomic and increments `attempts`** | `UPDATE … RETURNING` flips rows to `running` in one statement, so a second tick cannot re-claim and double-send. The increment happens *at claim*, which is what makes the backoff keys line up. |
| **A deferral is not a failure** | If an action cannot run yet — no principal configured, say — it is rescheduled and the claim's increment is *undone*. Without that, three deferrals would exhaust the attempt budget and the action would fail permanently on its first real run. |
| **Failure backs off, then gives up** | 30s, then 5m, then `failed`. A permanently broken action must not retry forever. |
| **A crashed `running` row is swept back to `pending`** | Only `pending` rows are ever claimed, so a process killed mid-dispatch would otherwise strand the action forever. |

Handler errors are contained: one broken action does not stop the batch, and an
unknown `kind` fails loudly rather than vanishing. A tick that outlives its
interval does not overlap the next one.

## Not built yet — ask and it gets built

These are **deliberately deferred**, not forgotten. The reference implementation
has all of them; they are being left out until there is real demand, because each
one is a permanent maintenance surface.

If you want any of these, **open an issue saying so.** Demand is the whole
tiebreaker.

| Deferred                   | What it would give you                                                |
| -------------------------- | --------------------------------------------------------------------- |
| **Slack**                  | Talk to your executive from Slack; receive briefs and proposals there |
| **Telegram**               | Direct-message conversations, approvals, and proactive nudges         |
| **Discord**                | Gateway bot with per-thread sessions and auto-titling                 |
| **Email**                  | IMAP polling for inbound mail, and outbound mail delivery             |
| **Google Chat**            | Webhook integration with service-account auth                         |
| **Web search**             | Live lookups layered onto your own documents                          |
| **Committee review**       | Three reviewers plus a revision pass on high-stakes answers           |
| **Evals harness**          | LLM-judge regression testing for prompt changes                       |
| **Talent pipeline**        | Candidates, engagements, offers, interview coordination               |
| **Watchlist / monitoring** | Track external entities and surface signals                           |

Everything else — the specialist council, the workflows, the knowledge base,
briefings, memory, the scheduler, the dashboard — is in scope.

## Status

> **Continuing this work?** Read [`AGENTS.md`](./AGENTS.md) (how to work here) and
> [`PORT-PLAN.md`](./PORT-PLAN.md) — the complete remaining scope: 31 workflows,
> the 153-path API surface, the dashboard, the MCP server, sequencing, and every
> decision already made.

Ported and verified so far:

- [x] Consolidated schema (13 tables) with idempotent migrations
- [x] Multi-provider model access
- [x] `morning_brief` — context gathering, synthesis, watermarking, persistence
- [x] **Council** — nine specialists, routing, parallel consultation, one-voice synthesis
- [x] **Knowledge** — 96 documents, FTS5 retrieval, failure cases wired to the prompts
- [x] **Scheduler** — atomic claiming, deferral vs failure, daily chaining
- [x] Test suite for the above (**105 tests**)

Next: `executive_research` and the scheduler (the proactive half).

## Architecture

```
src/
├── index.ts                 HTTP server
├── config.ts                Environment + provider selection
├── db.ts                    bun:sqlite client + migrations
├── schema.ts                The whole database, in one file
├── providers.ts             One OpenAI-compatible client
└── features/                One directory per feature
    ├── briefings/
    │   └── morning-brief.ts
    ├── council/
    │   ├── specialists.ts   the nine domain prompts (ported verbatim)
    │   └── council.ts       select -> consult -> synthesize
    ├── knowledge/
    │   ├── documents.ts     parses the three corpus shapes
    │   └── knowledge.ts     FTS5 index, search, prompt rendering
    └── scheduler/
        └── scheduler.ts     claim, retry, defer, chain
```

Two conventions worth knowing:

- **`src/features/<feature>/`** — each feature owns its own directory. Features
  talk to the database through `db.ts` and to models through `providers.ts`,
  never to each other's internals.
- **The schema is centralised.** The reference implementation creates ~40 tables
  ad-hoc across 18 modules, so the shape of the database can only be learned by
  reading all of them. Here it is one file, and each table records where it came
  from.

## Relationship to OpenExecutive

Durbar is a **port**, in the same sense as translating a program between
languages: it aims to reproduce behaviour, not to track the original's code.

- **What carries over:** the design, the workflow catalogue, the specialist
  roster, the knowledge base and personas (ported as data), and the behaviours
  encoded in its test suite.
- **What does not:** the Python implementation, the ChromaDB/ONNX embedding
  stack, the Anthropic-specific prompt-caching architecture, and the hosted
  service dependencies.
- **Upstream is a reference, not a source of truth.** New upstream features are
  cherry-picked deliberately when they matter, never merged wholesale.

## Licence

Apache-2.0, matching the original project.

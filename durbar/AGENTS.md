# Durbar — agent guide

**A lean, self-hostable reimplementation of OpenExecutive**: same behaviour, a fraction of
the code and image size, one container, one SQLite file, no third-party accounts required.

> **Before writing code, read [`PORT-PLAN.md`](./PORT-PLAN.md).** It is the complete,
> self-contained scope: the 31 workflows, the 153-path API surface, the dashboard, the MCP
> server, the sequencing, and every decision already made. This file is only how to *work*
> here; that file is *what to build*.

---

## Baseline — verify this first

```bash
cd durbar
bun install        # one time, ~21 MB
bun test           # expect: 105 pass, 0 fail
bun check          # expect: clean
```

If either is red, you have a broken starting point. Fix that before porting anything.

## Commands

```bash
bun test                    # suite (no network)
bun check                   # tsc --noEmit
bun run db:init             # create/migrate the database
bun run start               # serve on :8787
bun run dev                 # same, with --watch
```

**Runtime needs zero installs** — `bun:sqlite`, `bun test` and `fetch` are built in.
`bun install` exists only for typechecking.

## Hard rules

1. **The reference is read-only.** `packages/core/` in the parent repo is the spec. Read it,
   port the intent, **never add features to it**.
2. **The tests are the specification.** `packages/core/tests/unit/` (236 files) and
   `openexecutive/evals/` (42 yaml) encode the edge cases that vanish silently in a port.
   Read the test for any behaviour you port.
3. **`bun check` must stay clean.** `strict`, `exactOptionalPropertyTypes`,
   `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters` are all on. There is
   **no DOM lib** (`lib: ["ESNext"]`, `types: ["bun"]`), so `HeadersInit` and friends are not
   ambient — use `Record<string, string>`.
4. **Never present unverified code.** Run it. A passing test is not the same as running the
   thing: start the server, call the route, run the tick, read the output.
5. **State download sizes before fetching anything.** The owner is often on metered mobile
   data. Measure locally (`du`, lockfile parsing) rather than downloading to find out.
6. **Commit as you go**, in logical groups, with messages explaining *why*.
7. **Do not build the deferred features.** Slack, Telegram, Discord, email, Google Chat,
   web search, and Honcho memory are out of scope by decision. See `README.md`.

## Conventions

- `src/features/<feature>/` — one directory per feature. Features reach the database through
  `db.ts` and models through `providers.ts`, never into each other's internals.
- Import with extensions: `./db.ts`, not `./db`.
- Doc comments explain **why a thing exists**, including what was deliberately *not* done.
  The existing files set the bar; match them.
- Tests live beside the code as `<name>.test.ts`, use an injected fake provider so nothing
  touches the network, and **verify what their name claims**.
- Schema is one file, append-only migrations with ascending ids, every statement idempotent,
  each table recording where it came from.

## Layout

```
src/
├── index.ts        Bun.serve — the HTTP surface
├── config.ts       env + provider selection
├── db.ts           bun:sqlite + migrations
├── schema.ts       the whole database, in one file
├── providers.ts    one OpenAI-compatible client
└── features/       briefings · council · knowledge · scheduler
knowledge/builtin/  96 curated documents (data, ported as-is)
```

## Where things are

| Need | Location |
| --- | --- |
| Full scope, sequencing, decisions | `PORT-PLAN.md` |
| What is deferred, and why | `README.md` |
| Conventions in detail | `PORT-PLAN.md` §8 |
| Traps already hit (FTS5, scheduler, briefings, Docker) | `PORT-PLAN.md` §9 |
| The Python reference | `../packages/core/openexecutive/` |
| The frontend to port | `../packages/web/` (32,844 lines) |
| The MCP server to port | `../packages/mcp/` (3,171 lines) |

## Two habits worth keeping

**Push back once, then execute.** If a request looks wrong, say so with the evidence. If the
owner decides anyway, build it — it is their call, and relitigating wastes the decision.

**Report what you did not do.** If a step was skipped or a claim is untested, say so plainly.
An honest gap is recoverable; a silent one is not.

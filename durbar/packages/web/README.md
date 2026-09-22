# @durbar/web — SvelteKit dashboard

SvelteKit 5 + SvelteKit remote functions + Tailwind v4. Calls the Durbar Bun server over HTTP for chat and workflow runs (SSE streams).

## Why this exists

`packages/web/` in the upstream repo is 32,844 lines, 254 files, 38 routes. A full 1:1 port is not feasible in one turn. This package scaffolds a working SvelteKit app that demonstrates the pattern and is extensible to the full port.

## How it calls Durbar

The dashboard never assumes same-origin. `DURBAR_PUBLIC_URL` is the only difference between "everything in one container" and "frontend on Netlify, backend on Fly" — the same build serves both. See `src/lib/server/durbar.ts`.

- `query` for reads (`GET /health`, `GET /today`, etc.)
- `form` for mutations via native HTML `<form>` + Valibot (company profile PATCH)
- `command` for button-triggered mutations (create department/person, start workflow run)
- SSE streams (`POST /chat → text/event-stream`, workflow runs) are fetched directly from Durbar on the client — remote functions are not streaming primitives.

## Routes

38 routes mirroring `packages/web/src/routes/` in the upstream: dashboard home, today, company-profile, departments, people, jobs (workflows), knowledge, artifacts, audit, clients, council, guide, architecture, memories, onboard, review, skills, staff-onboarding, talent, watchlist, settings, signin, demo. Key routes (home, company, departments, people, workflows) are fully wired to Durbar; the rest are extensible stubs.

## Remote functions

`src/lib/remote/*.remote.ts`, re-exported from `src/lib/remote/index.ts`:

- `health.remote.ts` — `getHealth`, `getToday`, `getActivity` (query)
- `company.remote.ts` — `getCompanyProfile` (query), `updateCompanyProfile` (form + Valibot)
- `departments.remote.ts` — `listDepartments`, `getDepartment` (query), `createDepartment`, `deleteDepartment` (command + Valibot)
- `people.remote.ts` — `listPeople`, `getPerson` (query), `createPerson` (command + Valibot)
- `workflows.remote.ts` — `listWorkflows`, `getWorkflow`, `listWorkflowRuns`, `getWorkflowRun` (query), `startWorkflowRun` (command + Valibot)
- `chat.remote.ts` — `getSuggestedPrompts`, `listSessions`, `getSessionMessages` (query)

## Commands

```bash
bun install        # ~100-200MB download (SvelteKit + Vite + Tailwind + Valibot + TanStack)
bun run check      # svelte-check — must stay clean
bun run build      # vite build
bun run dev        # vite dev --port 5173
```

## Deferred

Slack, Telegram, Discord, email, Google Chat, web search, Honcho — per global constraints. Full fidelity for all 38 routes (filters, pagination, TanStack tables, etc.) is incremental work on top of this scaffold.

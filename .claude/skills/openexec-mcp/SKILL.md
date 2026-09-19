---
name: openexec-mcp
description: Drive the Open Executive company through MCP tools — read or update the profile, people, departments, knowledge, artifacts, talent pipeline, watchlist, review queue, audit log and workflows. Use when asked to change company state ("add a person", "retire that department", "upload this doc", "approve the pending items", "what's waiting on me", "run the annual plan", "ask the Executive"). Mirrors the FastAPI backend over HTTP; writes are audited exactly like the web UI.
---

# openexec-mcp

The MCP tools are the **write** path to the company; the `openexec-api` skill (curl) is
the escape hatch for routes the tools do not cover. Prefer the tools — they carry the
schemas and the safety annotations.

Server: `packages/mcp` (TMCP, TypeScript). Design + full route mapping: `docs/mcp.md`.

## Shape of the surface

**8 tools, one per domain resource, each multiplexing an `action` enum.** Never look
for a tool named after the operation — pick the resource, then the action.

| Tool             | Use it for                                                                                                        |
| ---------------- | ----------------------------------------------------------------------------------------------------------------- |
| `oe_company`     | Profile (`get_profile`/`patch_profile`), onboarding interview, briefing (`get_today`), episodic memory, and `ask` |
| `oe_people`      | The roster — who exists, what they can authorise, where to reach them                                             |
| `oe_departments` | Departments, charters, authority levels, goals                                                                    |
| `oe_knowledge`   | Built-in knowledge, failure library, external sources, company documents, `search`                                |
| `oe_artifacts`   | Stored outputs (alert drafts, workflow artifacts)                                                                 |
| `oe_talent`      | Hiring: engagements, candidates, offers                                                                           |
| `oe_watchlist`   | Monitored entities, signals, approve/decline queue                                                                |
| `oe_operations`  | Review queue, audit log, usage/cost, workflows                                                                    |

Every tool's `description` lists its actions with one line each — read it before
guessing an action name, and expect a schema error (not a silent no-op) for a wrong one.

## Safety tiers

- **Green — run freely.** Everything without a ⚠️ marker in its action description.
- **Yellow — confirm once per session.** Reversible writes: `oe_people update`,
  `oe_departments update`, `oe_artifacts archive`, `oe_watchlist update`,
  `oe_operations update_review`, `oe_talent update_offer`, profile patches.
- **Red — one explicit "go" per call, never chained.** `oe_company onboard_commit` and
  `delete_memory`; `oe_people archive`; `oe_departments delete` / `delete_goal`;
  `oe_knowledge delete_builtin` / `delete_failure` / `delete_document`;
  `oe_artifacts delete`; `oe_talent archive_*`; `oe_watchlist delete` / `decline`;
  `oe_operations bulk_approve` / `delete_annotation` / `delete_run`.

`docs/mcp.md` has this table with the reasoning; the short rule is **if the action's
description starts with ⚠️, ask first.**

## Rules that keep you out of trouble

1. **Read before you write.** List the resource first (`oe_people list`,
   `oe_departments list`) so you reuse existing slugs and ids instead of inventing
   near-duplicates. Every write returns the full updated record — check it.
2. **`oe_company ask` is a billed LLM turn.** It routes to specialists, retrieves
   knowledge and writes episodic memory. For a factual question about the company, use
   `get_today`, `search`, `list_audit` or `get_profile` — they cost nothing.
3. **Never estimate spend.** `oe_operations audit_usage` is the real token/cost report,
   with per-day and per-model breakdowns. Do not reason from memory about cost.
4. **Paths are per-kind.** Built-in knowledge and the failure library both take
   `/domain/filename`; the filename must match `^[A-Za-z0-9_-]+\.md$` and the domain
   must be one of `strategy | finance | hr | legal | operations | marketing | board |
product`. `replace_*` needs the file to exist; `create_*` 409s if it does.
5. **`upload_document` reads a path on the MCP server's machine.** Fine locally,
   impossible for a hosted server — say so instead of retrying.
6. **Workflow runs can pause.** `run_workflow` returns `paused_on_human_gate` when a run
   stops at an approval gate. It does **not** auto-resume; a human resolves it. Call
   `get_workflow` first to see the required `inputs`.
7. **Onboarding.** If `get_profile` 404s the company has not been onboarded: run
   `onboard_start` (empty description returns the opening question), then
   `onboard_message` until a draft appears, review it, and only then `onboard_commit`.

## Recipes

```text
Who is waiting on what?     oe_operations list_review {status:"pending"}  ·  review_stats
What happened yesterday?    oe_operations list_audit {since:"<ISO>", limit:200}
Why did it answer that?     oe_knowledge search {query:"…"}  → specialists_that_would_see_this
Who can approve spend?      oe_people list_by_scope {token:"spend_lt_10k"}
What is it monitoring?      oe_watchlist list {enabled_only:true}  ·  signals {slug}
What did the plan produce?  oe_operations list_runs  →  get_run {run_id}
What does the Executive think?  oe_company ask {message:"…"}
```

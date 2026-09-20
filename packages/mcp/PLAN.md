# MCP Expansion Plan — Making Every Route AI-Editable

> **Status: COMPLETE.** Every phase below is implemented and verified against a live
> backend — but **not** as one tool per route. The routes listed here are reachable as
> **actions inside 8 resource-oriented tools** (one per domain, `action` enum); see
> `docs/mcp.md` for the design, the tool table and the safety tiers. This file is kept
> as the route → action inventory and the record of why the work was ordered this way.
>
> **Divergences from the plan as written:**
>
> - Tools are `oe_company`, `oe_people`, `oe_departments`, `oe_knowledge`,
>   `oe_artifacts`, `oe_talent`, `oe_watchlist`, `oe_operations` — 101 actions total.
> - Domains the plan did not name were folded into the nearest tool rather than
>   dropped: episodic memory + today/activity + `POST /chat` into `oe_company`; offers
>   into `oe_talent`; review annotations and audit sessions/usage into `oe_operations`.
> - Phase F's `oe://` resources were **not** mirrored as MCP resources. Their reads are
>   actions (`oe_company get_profile`/`get_today`/`list_memories`, `oe_people list`,
>   `oe_departments list`) — MCP resource support is uneven across clients and two ways
>   to read the same data is one too many.
> - Deployment is done: `docker/Dockerfile.mcp`, a `mcp` compose service, `fly.toml`,
>   and the cost/scale-to-zero notes in `docs/deployment.md`.
> - The only item still open is §7 — retiring the Python server.

## 1. What exists today

| Layer                                                                                       | State                                                                                                                                            |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/mcp`                                                                              | TMCP server (TS, Valibot, STDIO + HTTP via `srvx`). `src/index.ts` is the single entrypoint for both transports.                                 |
| `src/server.ts`                                                                             | `createServer()` — shared server instance. Both transports import it so they never drift.                                                        |
| `src/backend.ts`                                                                            | Thin HTTP client for the FastAPI backend (`x-api-key` auth, same as the UI proxy).                                                               |
| `src/tools/registry.ts`                                                                     | `ActionSpec` table → one Valibot discriminated-union schema + one generic handler. Adding an endpoint is a table row, not a new tool definition. |
| `src/tools/{company,people,departments,knowledge,artifacts,talent,watchlist,operations}.ts` | The 8 domain tools — 101 actions multiplexed behind `action` enums.                                                                               |
| `packages/core/openexecutive/mcp_server/server.py`                                          | Legacy Python MCP server (FastMCP, read-only). Kept for now; will be superseded by `packages/mcp` once parity is reached.                        |

Every MCP tool goes through the **HTTP API**, never direct SQLite/YAML — so validation, auth, and audit stay identical.

## 2. Design principles for the remaining tools

1. **One tool file per domain** — `src/tools/people.ts`, `src/tools/departments.ts`, etc. Each file exports `registerXxxTools(server)`, called from `src/server.ts`.
2. **Read before write** — every write tool's description tells the agent to read the relevant resource first.
3. **Annotations** — `readOnlyHint: true` for reads, `destructiveHint: true` + `openWorldHint: true` for writes. Clients use these to gate confirmations.
4. **Full-state returns** — every write returns the updated entity so the agent can verify.
5. **No new backend routes** — wrap what already exists. If a route is missing, add it to `packages/core/openexecutive/api/routes/*` first, then expose it.

## 3. Action inventory (by backend route)

> Executed as **actions** inside the 8 domain tools rather than as one tool per route.
> Every row below is reachable from MCP today; `docs/mcp.md` maps each row to its tool.

### Phase A — Company state (highest leverage, smallest surface)

| Tool                     | Backend route                              | Notes   |
| ------------------------ | ------------------------------------------ | ------- |
| `get_company_profile`    | `GET /company-profile`                     | ✅ done |
| `patch_company_profile`  | `PATCH /company-profile`                   | ✅ done |
| `get_onboarding_session` | `GET /onboard/interview/{id}`              | ✅ done |
| `onboard_start`          | `POST /onboard/interview/start` (FormData) | ✅ done |
| `onboard_message`        | `POST /onboard/interview/message`          | ✅ done |
| `onboard_draft`          | `POST /onboard/interview/draft`            | ✅ done |
| `onboard_commit`         | `POST /onboard/interview/commit`           | ✅ done |

### Phase B — People & Departments

| Tool                | Backend route                           | Notes                                                   |
| ------------------- | --------------------------------------- | ------------------------------------------------------- |
| `list_people`       | `GET /people`                           | Read                                                    |
| `get_person`        | `GET /people/{id}`                      | Read                                                    |
| `create_person`     | `POST /people`                          | Write                                                   |
| `update_person`     | `PATCH /people/{id}`                    | Write                                                   |
| `archive_person`    | `POST /people/{id}/archive`             | Write (soft-delete, reversible)                         |
| `list_departments`  | `GET /departments`                      | Read                                                    |
| `get_department`    | `GET /departments/{slug}`               | Read                                                    |
| `create_department` | `POST /departments`                     | Write                                                   |
| `update_department` | `PATCH /departments/{slug}`             | Write                                                   |
| `delete_department` | `DELETE /departments/{slug}`            | Write (destructive — annotate, require explicit intent) |
| `create_goal`       | `POST /departments/{slug}/goals`        | Write                                                   |
| `update_goal`       | `PATCH /departments/{slug}/goals/{id}`  | Write                                                   |
| `delete_goal`       | `DELETE /departments/{slug}/goals/{id}` | Write                                                   |

### Phase C — Knowledge & Artifacts

| Tool               | Backend route                           | Notes                                              |
| ------------------ | --------------------------------------- | -------------------------------------------------- |
| `list_knowledge`   | `GET /knowledge/documents`              | Read                                               |
| `search_knowledge` | `POST /knowledge/search`                | Read (already exists as Python MCP tool — port it) |
| `upload_document`  | `POST /knowledge/documents` (multipart) | Write                                              |
| `delete_document`  | `DELETE /knowledge/documents/{id}`      | Write                                              |
| `list_artifacts`   | `GET /artifacts`                        | Read                                               |
| `get_artifact`     | `GET /artifacts/{id}`                   | Read                                               |
| `archive_artifact` | `POST /artifacts/{id}/archive`          | Write                                              |
| `restore_artifact` | `POST /artifacts/{id}/restore`          | Write                                              |

### Phase D — Talent & Watchlist

| Tool                    | Backend route                        | Notes                                              |
| ----------------------- | ------------------------------------ | -------------------------------------------------- |
| `list_engagements`      | `GET /talent/engagements`            | Read                                               |
| `get_engagement`        | `GET /talent/engagements/{id}`       | Read                                               |
| `create_engagement`     | `POST /talent/engagements`           | Write                                              |
| `update_engagement`     | `PATCH /talent/engagements/{id}`     | Write                                              |
| `list_candidates`       | `GET /talent/candidates`             | Read (already exists as Python MCP tool — port it) |
| `get_candidate`         | `GET /talent/candidates/{id}`        | Read (already exists — port it)                    |
| `create_candidate`      | `POST /talent/candidates`            | Write                                              |
| `update_candidate`      | `PATCH /talent/candidates/{id}`      | Write                                              |
| `advance_candidate`     | `POST /talent/candidates/{id}/stage` | Write                                              |
| `list_watchlist`        | `GET /watchlist`                     | Read                                               |
| `create_watchlist_item` | `POST /watchlist`                    | Write                                              |
| `update_watchlist_item` | `PATCH /watchlist/{slug}`            | Write                                              |
| `delete_watchlist_item` | `DELETE /watchlist/{slug}`           | Write                                              |

### Phase E — Review, Audit, Workflows

| Tool                  | Backend route                | Notes                                                             |
| --------------------- | ---------------------------- | ----------------------------------------------------------------- |
| `list_review_items`   | `GET /review/items`          | Read                                                              |
| `update_review_item`  | `PATCH /review/items/{id}`   | Write                                                             |
| `bulk_approve_review` | `POST /review/bulk-approve`  | Write                                                             |
| `list_audit_logs`     | `GET /audit/logs`            | Read                                                              |
| `get_audit_log`       | `GET /audit/logs/{id}`       | Read                                                              |
| `list_workflows`      | `GET /workflows`             | Read (already exists as Python MCP tool — port it)                |
| `run_workflow`        | `POST /workflows/{name}/run` | Write (long-running — return run_id, poll via `get_workflow_run`) |
| `get_workflow_run`    | `GET /workflows/runs/{id}`   | Read                                                              |

### Phase F — Resources (read-only snapshots for grounding)

Mirror every `oe://` resource from the Python server as TMCP resources:

- `oe://company/profile` → `get_company_profile` (already a tool, add as resource too)
- `oe://people/roster`, `oe://departments/state`, `oe://today/briefing`, `oe://today/activity`
- `oe://memory/decisions`, `oe://memory/initiatives`, `oe://memory/advice`
- `oe://talent/engagements`

Resources are cheaper than tools for grounding — the agent reads them without a tool call.

## 4. Implementation order

1. **Phase B** (people + departments) — most frequently updated after onboarding.
2. **Phase C** (knowledge + artifacts) — second most common.
3. **Phase D** (talent + watchlist) — heavier, but the Python MCP already has read tools to port.
4. **Phase E** (review + audit + workflows) — lowest urgency; review/audit are mostly reads.
5. **Phase F** (resources) — can be interleaved; each is ~10 lines.

Each phase: add `src/tools/<domain>.ts` → register in `src/server.ts` → `bunx tsc --noEmit` → `uv run pytest tests/unit/test_mcp_server.py` (once ported, add TMCP-side tests).

## 5. Auth & deployment

- **Local (STDIO):** `bun run src/index.ts` — no auth needed, runs as the local user.
- **Remote (HTTP):** `srvx` on any Node/Bun host. Docker: `docker/Dockerfile.mcp`;
  Fly.io: `fly.toml` (cost model: `docs/deployment.md`).
  **The transport authenticates nothing** — it _forwards_ `x-api-key:
$BACKEND_SHARED_SECRET` to the backend, so anything that can reach `/mcp` can act on
  the company. Both compose and `fly.toml` bind it to loopback / the private network for
  that reason; put an authenticating proxy in front if it has to be public. The only
  open path is `/health`, which returns no configuration.
- **No new secrets** — reuse `BACKEND_SHARED_SECRET` and `BACKEND_BASE_URL` from the existing `.env`.

## 6. Testing

- **Python side:** extend `tests/unit/test_mcp_server.py` (or add `tests/unit/test_mcp_onboarding.py`) — mock `backend` calls, assert tool registration and serialization.
- **TMCP side:** `bunx tsc --noEmit` is the type gate. For integration, hit the live backend with `BACKEND_SHARED_SECRET` set and assert round-trips (create → read → update → archive).

## 7. Migration from the Python MCP server (still open)

> **Remaining work.** `packages/mcp` now covers more than the Python server does, with
> one exception: in-process specialist consultation (`consult_specialist`), which has no
> HTTP route to wrap. Nothing below has been started.

Once `packages/mcp` reaches parity on reads, the Python server at `packages/core/openexecutive/mcp_server/server.py` can be retired:

1. Point `api/main.py`'s lifespan to the TMCP HTTP transport instead of `mcp_server.mount`.
2. Remove the `mcp` Python dependency.
3. Keep the Python server's tests as a reference for the TMCP port.

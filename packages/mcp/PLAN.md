# MCP Expansion Plan — Making Every Route AI-Editable

> **Status:** `packages/mcp` scaffolded via `bun create tmcp` (Valibot + STDIO + HTTP, TS).
> Onboarding tools are implemented. This plan covers the rest.

## 1. What exists today

| Layer                                              | State                                                                                                                                                     |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/mcp`                                     | TMCP server (TS, Valibot, STDIO + HTTP via `srvx`). `src/index.ts` is the single entrypoint for both transports.                                          |
| `src/server.ts`                                    | `createServer()` — shared server instance. Both transports import it so they never drift.                                                                 |
| `src/backend.ts`                                   | Thin HTTP client for the FastAPI backend (`x-api-key` auth, same as the UI proxy).                                                                        |
| `src/tools/onboarding.ts`                          | 7 tools: `get_company_profile`, `get_onboarding_session`, `onboard_start`, `onboard_message`, `onboard_draft`, `onboard_commit`, `patch_company_profile`. |
| `packages/core/openexecutive/mcp_server/server.py` | Legacy Python MCP server (FastMCP, read-only). Kept for now; will be superseded by `packages/mcp` once parity is reached.                                 |

Every MCP tool goes through the **HTTP API**, never direct SQLite/YAML — so validation, auth, and audit stay identical.

## 2. Design principles for the remaining tools

1. **One tool file per domain** — `src/tools/people.ts`, `src/tools/departments.ts`, etc. Each file exports `registerXxxTools(server)`, called from `src/server.ts`.
2. **Read before write** — every write tool's description tells the agent to read the relevant resource first.
3. **Annotations** — `readOnlyHint: true` for reads, `destructiveHint: true` + `openWorldHint: true` for writes. Clients use these to gate confirmations.
4. **Full-state returns** — every write returns the updated entity so the agent can verify.
5. **No new backend routes** — wrap what already exists. If a route is missing, add it to `packages/core/openexecutive/api/routes/*` first, then expose it.

## 3. Tool inventory (by route)

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
- **Remote (HTTP):** `srvx` on any Node/Bun host. Gate with `x-api-key: $BACKEND_SHARED_SECRET` (same as the UI proxy). The Python server's `_UNAUTHENTICATED_PATHS` pattern applies — `/health` stays open, everything else requires the secret.
- **No new secrets** — reuse `BACKEND_SHARED_SECRET` and `BACKEND_BASE_URL` from the existing `.env`.

## 6. Testing

- **Python side:** extend `tests/unit/test_mcp_server.py` (or add `tests/unit/test_mcp_onboarding.py`) — mock `backend` calls, assert tool registration and serialization.
- **TMCP side:** `bunx tsc --noEmit` is the type gate. For integration, hit the live backend with `BACKEND_SHARED_SECRET` set and assert round-trips (create → read → update → archive).

## 7. Migration from the Python MCP server

Once `packages/mcp` reaches parity on reads, the Python server at `packages/core/openexecutive/mcp_server/server.py` can be retired:

1. Point `api/main.py`'s lifespan to the TMCP HTTP transport instead of `mcp_server.mount`.
2. Remove the `mcp` Python dependency.
3. Keep the Python server's tests as a reference for the TMCP port.

# The Open Executive MCP server

`packages/mcp` — a TMCP server (TypeScript, Valibot, STDIO + HTTP) that lets any MCP
client read and update the whole company. It never touches SQLite or YAML directly:
every action goes through the FastAPI backend over HTTP with the same
`x-api-key` auth, validation and audit path the web UI uses, so a change made by an
agent is indistinguishable in the audit log from one made in the browser.

## 8 tools, not 90

The backend exposes ~90 routes worth calling. Wrapping one tool per route produces a
tool list that is expensive, hard to navigate, and worse at tool selection: the model
compares 90 near-identical CRUD descriptions instead of a handful of distinct ones.

This server uses **one tool per domain resource with an `action` enum** —
resource-oriented multiplexing, the approach the Tomoshibi MCP server takes (3 tools
for 17 operations). Fewer, richer tools beat many thin ones: the list is cheaper to
advertise, and tool selection is more accurate when the model compares distinct
resources instead of dozens of near-identical CRUD entries. **101 actions collapsed
into 8 tools:**

| Tool             | Actions | Covers                                                                                                                                                                                                                                              |
| ---------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `oe_company`     | 16      | Profile, onboarding interview (`onboard_start` → `onboard_message` → `onboard_draft` → `onboard_commit`), today's briefing/activity, episodic memory (decisions / initiatives / advice, one update action each), `ask` (a real Executive chat turn) |
| `oe_people`      | 6       | Roster: authority scope, channels, availability, reporting lines, archive                                                                                                                                                                           |
| `oe_departments` | 8       | Departments: charter, authority level, cadences, budget, watched entities, goals                                                                                                                                                                    |
| `oe_knowledge`   | 17      | Built-in knowledge, failure library, external sources, company documents, cross-store `search`                                                                                                                                                      |
| `oe_artifacts`   | 5       | Stored outputs: list/get/archive/restore/delete                                                                                                                                                                                                     |
| `oe_talent`      | 21      | Hiring funnel: engagements, candidates, offers, matching, reindex                                                                                                                                                                                   |
| `oe_watchlist`   | 8       | Monitored entities, their signals, and the approve/decline queue                                                                                                                                                                                    |
| `oe_operations`  | 20      | Review queue + annotations, audit trail + usage, workflow catalog + runs                                                                                                                                                                            |

Actions are declared as a table in `src/tools/<domain>.ts`; `src/tools/registry.ts`
turns each table into one Valibot discriminated-union schema and one generic handler,
so a newly exposed endpoint is a table row, not a new tool definition. Two kinds of
action need a `custom` handler: multipart (`onboard_start`, `upload_document`) and
SSE (`ask`, `run_workflow`).

## Safety

**MCP annotations are per-tool, not per-action.** A domain tool that mixes reads and
writes cannot truthfully advertise `readOnlyHint`, so these tools declare
`readOnlyHint: false` and **`destructiveHint: true`** — the conservative default, since
every tool does carry at least one delete, archive or bulk-approve action. Declaring
`false` would assert "additive updates only", which a client that gates on annotations
would read as _safe to auto-approve_. The per-action signal lives in two places: a
`⚠️ destructive` prefix on the action's description (which the model reads) and this
table.

Actions that delete or bulk-mutate durable state — **confirm with the user before
calling one, and never chain two in a turn**:

| Tool             | Destructive actions                                                                  |
| ---------------- | ------------------------------------------------------------------------------------ |
| `oe_company`     | `onboard_commit` (creates the profile and seeds people/departments), `delete_memory` |
| `oe_people`      | `archive`                                                                            |
| `oe_departments` | `delete`, `delete_goal`                                                              |
| `oe_knowledge`   | `delete_builtin`, `delete_failure`, `delete_document`                                |
| `oe_artifacts`   | `delete` (prefer `archive`)                                                          |
| `oe_talent`      | `archive_engagement`, `archive_candidate`, `archive_offer`                           |
| `oe_watchlist`   | `delete`, `decline` (removes the suggestion and may blacklist an entity)             |
| `oe_operations`  | `bulk_approve`, `delete_annotation`, `delete_run`                                    |

Everything else is either a read or a reversible single-record update.

### The server has no authentication of its own

The HTTP transport authenticates **nothing** — it proxies to the backend using
`BACKEND_SHARED_SECRET`, so anything that can reach `/mcp` can act on the company.
Three things keep that from being a hole:

- It binds **`127.0.0.1`** by default (`MCP_HOST`). A container sets `MCP_HOST=0.0.0.0`
  because its port is published from outside the network namespace, and compose still
  publishes it on loopback (`127.0.0.1:8787:8787`).
- Any request carrying an `Origin` header is **refused with 403** (`src/http.ts`). No MCP
  client is a browser, so nothing legitimate is affected. This is the load-bearing
  half of the rebinding defence: the transport's own `allowedOrigins` allowlist returns
  early when the request's `Origin` matches its own origin, which is exactly the
  rebinding case.
- Optionally set **`MCP_AUTH_TOKEN`**, and every `/mcp` request must carry
  `Authorization: Bearer <token>` (constant-time compared). That is what makes a
  *public* deployment safe; without it the server's safety rests on network isolation
  alone.
- `fly.toml` assumes **no public IP** is allocated — its header gives the release step
  to run after `fly launch`.

If you must expose it publicly, put an authenticating proxy in front of it.

## Configuration

| Variable                 | Default                 | Purpose                                                                |
| ------------------------ | ----------------------- | ---------------------------------------------------------------------- |
| `BACKEND_BASE_URL`       | `http://localhost:8000` | The FastAPI backend to proxy to                                        |
| `BACKEND_SHARED_SECRET`  | _(unset)_               | Sent as `x-api-key`; **required** whenever the backend's gate is armed |
| `MCP_PORT`               | `8787`                  | HTTP port (local override)                                             |
| `PORT`                   | —                       | Read as a fallback on hosts that inject it (Fly.io)                    |
| `MCP_HOST`               | `127.0.0.1`             | Interface to bind. Only a container should widen this.                 |
| `MCP_DOCUMENT_ROOT`      | working directory       | The only tree `upload_document` may read from                          |
| `MCP_MAX_UPLOAD_BYTES`   | `52428800` (50 MB)      | Upload size cap, matching the backend's                                |
| `MCP_REQUEST_TIMEOUT_MS` | `30000`                 | Deadline for a normal JSON call                                        |
| `MCP_UPLOAD_TIMEOUT_MS`  | `120000`                | Deadline for a multipart upload                                        |
| `MCP_STREAM_TIMEOUT_MS`  | `600000`                | Deadline for a whole SSE turn                                          |
| `MCP_STREAM_MAX_BYTES`   | `67108864` (64 MB)      | Abort a stream that exceeds this                                       |
| `MCP_AUTH_TOKEN`         | _(unset)_               | Require `Authorization: Bearer <token>` on `/mcp`                      |

The container deliberately receives **only the backend secrets** — no `env_file` — so
it never holds the Anthropic key, bot tokens or IMAP credentials.

## Running it

```bash
# STDIO — the local default; the client spawns it per session
cd packages/mcp && bun run src/index.ts

# HTTP — `make dev` starts this on :8787 alongside the API and web
cd packages/mcp && bun run src/http.ts
```

`.vscode/mcp.json` wires both transports. `/health` is an unauthenticated liveness
probe returning `{"status":"ok","server":"open-executive-mcp"}` — constants only, no
configuration and no secret.

### Docker

```bash
# From the repo root (the build context must include packages/mcp)
docker build -f docker/Dockerfile.mcp -t openexecutive-mcp .
docker run --rm -p 127.0.0.1:8787:8787 \
  -e BACKEND_BASE_URL=http://host.docker.internal:8000 \
  -e BACKEND_SHARED_SECRET="$BACKEND_SHARED_SECRET" \
  openexecutive-mcp

# Or the whole stack (api + mcp + ui)
make docker
```

The image is 40.8 MB (Bun alpine + 13 production packages) and runs as the unprivileged
`bun` user. Bun executes the TypeScript directly, so there is no build step.

### Fly.io

`fly.toml` at the repo root deploys the HTTP transport with scale-to-zero. Read
`docs/fly-io-costs.md` first — the short version is that the MCP server should not run
continuously, and a stopped Machine costs about $0.01–0.03/month.

```bash
fly launch --no-deploy --copy-config --name <your-app>   # first time only
fly secrets set BACKEND_SHARED_SECRET=… BACKEND_BASE_URL=https://<your-api>
fly deploy

# Verify the app is NOT publicly reachable (launch often allocates an IP for a
# config with an [http_service]) — then reach it over the private network.
fly ips list -a <your-app>
fly ips release <address> -a <your-app>
fly proxy 8787:8787 -a <your-app>      # client → http://localhost:8787/mcp
```

## Relationship to the Python MCP server

`packages/core/openexecutive/mcp_server/server.py` is the legacy FastMCP server
mounted inside the API. It still works and is untouched. This one supersedes it —
it is the only surface that can _write_. Two deliberate differences:

- **No `oe://` resources.** Python's read-only resources (company profile, roster,
  department state, today briefing, episodic memory, active searches) are all reachable
  through read actions instead (`oe_company get_profile` / `get_today` / `list_memories`,
  `oe_people list`, `oe_departments list`). MCP resource support is uneven across
  clients, and two ways to read the same data is one too many.
- **No `consult_specialist`.** The Python tool calls the orchestrator in-process;
  there is no HTTP route for it. `oe_company ask` already routes to specialists, and
  the reply reports which actions were taken.

`upload_document` takes a **path on the MCP server's filesystem**, so it works for a
local deployment and cannot work for a remote one — use the web UI there.

## Verification

`bun test` runs `src/tools/registry.test.ts` — 12 hermetic tests that replace `fetch`
with a recorder and drive the real `HttpTransport`, so they assert the method, path and
body the generic handler actually produced. They pin the tool names and action counts
(the numbers `README.md`, `PLAN.md` and this file all repeat), and guard the specific
bugs this surface has already had: `patch_profile` sending a wrapped body the backend
ignores, `null` being dropped so a field could not be cleared, a 204 serialising to a
text block with no `text`, a redirect replaying the API key, `..` escaping a path
segment, and a tool failure not being marked `isError`.

Beyond that, the surface was verified with throwaway probes that speak real
MCP-over-HTTP: one against a stub backend emitting SSE (chat + workflow runs, including
a mid-stream `error` frame), one against the running API (live workflow catalog, roster,
knowledge search, audit log), one over STDIO, and one against the built container.
Those probes are not committed — the recipes are in the PR description.

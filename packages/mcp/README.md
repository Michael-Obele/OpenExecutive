# Open Executive MCP server

Lets any MCP client read and update the whole company: profile, people, departments,
knowledge, artifacts, hiring, watchlist, review queue, audit trail and workflows.

**8 tools, one per domain resource, each multiplexing an `action` enum** — 101 actions
in total. Full reference, safety table and deployment notes: **`docs/mcp.md`**.

## Quick start

```bash
# STDIO — the local default; the MCP client spawns it per session
bun run src/index.ts

# HTTP — `make dev` runs this on :8787 with the API and web
bun run src/http.ts
```

```jsonc
// .vscode/mcp.json
{
  "servers": {
    "openexecutive": {
      "type": "stdio",
      "command": "bun",
      "args": ["run", "packages/mcp/src/index.ts"],
      "env": { "BACKEND_SHARED_SECRET": "${env:BACKEND_SHARED_SECRET}" },
    },
  },
}
```

## Environment

| Variable                | Default                 | Purpose                                                        |
| ----------------------- | ----------------------- | -------------------------------------------------------------- |
| `BACKEND_BASE_URL`      | `http://localhost:8000` | FastAPI backend to proxy to                                    |
| `BACKEND_SHARED_SECRET` | _(unset)_               | Sent as `x-api-key`; required when the backend's gate is armed |
| `MCP_PORT` / `PORT`     | `8787`                  | HTTP port (`PORT` is the host-injected fallback)               |
| `MCP_HOST`              | `127.0.0.1`             | Interface to bind; a container sets `0.0.0.0`                  |
| `MCP_DOCUMENT_ROOT`     | working directory       | The only tree `upload_document` may read from                  |

Timeouts, the upload cap and the stream cap are also configurable — see `docs/mcp.md`.

## Tests

```bash
bun test        # hermetic: `fetch` is replaced with a recorder
bun run typecheck
```

The suite pins the tool names and action counts (repeated in three docs) and guards the
regressions this surface has already had — see `src/tools/registry.test.ts`.

## Layout

```
src/backend.ts        HTTP client: JSON, multipart, and SSE streams
src/tools/registry.ts the ActionSpec table → Valibot schema + generic handler
src/tools/<domain>.ts one file per tool: the action table and its descriptions
src/server.ts         createServer(): registers the 8 tools + server instructions
src/index.ts          STDIO entrypoint
src/http.ts           HTTP entrypoint (+ unauthenticated /health)
```

Adding an endpoint is a table row in the relevant `src/tools/<domain>.ts`. Actions the
generic path model cannot express (multipart uploads, SSE streams) supply a `custom`
handler.

## Docker / Fly.io

```bash
docker build -f ../docker/Dockerfile.mcp -t openexecutive-mcp ..   # context = repo root
```

`fly.toml` (repo root) deploys the HTTP transport with scale-to-zero. The MCP server
should not run continuously: a stopped Machine is billed for its rootfs only, a small
fraction of a running one. See "Cost and scale-to-zero" in `docs/deployment.md`.

> The HTTP transport has **no authentication of its own** — it proxies with
> `BACKEND_SHARED_SECRET`, so anything that can reach `/mcp` can act on the company.
> Keep it on loopback or the private network.

Built on [TMCP](https://github.com/paoloricciuti/tmcp) (Valibot + STDIO/HTTP transports).

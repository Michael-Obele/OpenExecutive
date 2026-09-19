# Running Open Executive on Fly.io — cost analysis

**Rates scraped from https://fly.io/docs/about/pricing on 2026-09-19.** Fly changes
prices; re-scrape before committing money. Every number below is either that page
(quoted) or a measurement taken on this machine (labelled as such).

## TL;DR

1. **The MCP server does not need to run continuously.** Locally it is a stdio
   process that the client spawns on demand — that costs **$0** and is the right
   answer unless you specifically need the company reachable from another device.
2. If you do host it: with `auto_stop_machines = "stop"` it scales to zero and
   costs **≈$0.01–0.03/month** (rootfs only). Always-on in the smallest preset it
   is **$1.94/month**.
3. **The MCP server is never the expensive part.** It is an HTTP proxy with no
   state and no model calls of its own. The Python API — and, if you enable it,
   the Honcho stack — dominate both RAM and money.

## Fly.io rates (shared CPU, from the pricing page)

| Preset                 | Price/second | Price/hour | Price/month |
| ---------------------- | ------------ | ---------- | ----------- |
| shared-cpu-1x / 256 MB | $0.00000075  | $0.0027    | **$1.94**   |
| shared-cpu-1x / 512 MB | $0.00000123  | $0.0044    | $3.19       |
| shared-cpu-1x / 1 GB   | $0.00000220  | $0.0079    | $5.70       |
| shared-cpu-1x / 2 GB   | $0.00000413  | $0.0149    | $10.70      |
| shared-cpu-2x / 2 GB   | $0.00000440  | $0.0158    | $11.39      |
| shared-cpu-2x / 4 GB   | $0.00000826  | $0.0297    | $21.40      |
| performance-1x / 2 GB  | $0.00001196  | $0.0431    | $31.00      |

Everything else that appears on an invoice:

| Item                       | Rate                                                                    |
| -------------------------- | ----------------------------------------------------------------------- |
| **Stopped** Machine        | rootfs only — **$0.15 per GB per 30 days**                              |
| Suspended Machine          | starts faster than stopped; same "excess capacity" trigger, see caveats |
| Volumes                    | $0.15/GB/month (billed even while the Machine is stopped)               |
| Volume snapshots           | $0.08/GB/month, first 10 GB free                                        |
| Egress to the internet     | $0.02/GB (NA/EU) · $0.04 (APAC/Oceania/SA) · $0.12 (Africa/India)       |
| Private cross-region       | $0.006/GB (granular pricing; **inbound is always free**)                |
| Shared IPv4 + anycast IPv6 | free                                                                    |
| Dedicated IPv4             | $2/month                                                                |
| TLS certificate            | $0.10/month per hostname, first 10 free                                 |

## Scenario table — MCP server only

| Scenario                               | Config                                                                  | Monthly         |
| -------------------------------------- | ----------------------------------------------------------------------- | --------------- |
| **A. Local (recommended)**             | stdio, spawned by the MCP client                                        | **$0.00**       |
| **B. Fly, scale-to-zero, private**     | `auto_stop_machines = "stop"`, `min_machines_running = 0`, no public IP | **≈$0.01–0.03** |
| C. Fly, always-on, private             | `min_machines_running = 1`, 256 MB                                      | **$1.94**       |
| D. Fly, always-on, public + auth proxy | C + a reverse proxy Machine                                             | **$3.88+**      |

Scenario B is the measured image: `docker build -f docker/Dockerfile.mcp` produces a
**40.8 MB** image (Bun alpine + 13 production packages, no build step because Bun
runs the TypeScript directly). Stopped, that rootfs is 0.041 GB → **$0.0061/month**,
plus containerd overhead — hence the $0.01–0.03 range. Egress is effectively zero
because you reach it over the private network, and inbound is free.

### The reservation trap

Fly sells compute reservation blocks at 40% off — **shared $36/year for $5/month of
credit**. The credit does **not** roll over and applies only to CPU/RAM. At the
$1.94/month single-Machine size you would pay $36/year ($3/month) for $5/month of
credit you cannot fully spend — **worse than paying cash**. Only buy a block once
monthly shared compute passes roughly **$5/month**, i.e. once you are running the
API and MCP together.

## Full stack (if you host more than the MCP server)

The MCP server is only useful if a backend is reachable, so a real remote deployment
means the Python API too. Sized from measurements on this machine:

| Component                                                 | Evidence                                                                                                                                               | Suggested                                        | Monthly                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------- |
| MCP server                                                | 40.8 MB image, no state                                                                                                                                | shared-cpu-1x / 256 MB, auto-stop                | ≈$0.02                     |
| **Python API**                                            | **measured 206 MB RSS** for the whole process group (`uv`, reloader, worker) idle, in `--reload` dev mode, after a `/knowledge/search` had already run | shared-cpu-1x / 1 GB (headroom for RAG + ingest) | **$5.70**                  |
| Data volume                                               | `chroma_db` **7.5 MB**, `episodic_memory.db` **588 KB** locally                                                                                        | 1 GB volume                                      | $0.15                      |
| SvelteKit web                                             | Bun SSR, small                                                                                                                                         | shared-cpu-1x / 256 MB                           | $1.94                      |
| Managed Postgres (web DB)                                 | not quoted here — see `fly.io/docs/mpg#pricing`                                                                                                        | smallest plan                                    | plan-dependent             |
| **Honcho** (optional, `HONCHO_ENABLED` is off by default) | separate Honcho API + deriver + `fastembed` embed sidecar, plus its own Postgres and Redis                                                             | 2 × shared-cpu-1x / 512 MB **+** extensions      | **$6.40 + Postgres/Redis** |

So: **MCP alone ≈ $0.02/month; a real deployment ≈ $8–10/month** without Honcho, and
**≈$15–20/month** with it — plus whatever Managed Postgres costs. Honcho is the
single biggest lever, and it is off by default.

## Do we need to run this continuously?

**No — and you should not, by default.** Three cases:

| Your situation                                              | Run continuously?                       | Why                                                                                                                                                    |
| ----------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Only your own editor/laptop uses it                         | **No.** Use the stdio entrypoint.       | The client spawns the process per session; $0, no cold start, no network exposure.                                                                     |
| You want it from another device, occasionally               | **No.** HTTP on Fly with scale-to-zero. | First call after idle pays a 1–3s cold start; everything else is a fraction of a cent.                                                                 |
| Something else calls it on a schedule (cron, CI, a webhook) | **Yes.** `min_machines_running = 1`.    | A scheduled caller cannot absorb a cold start, and Fly cannot wake a Machine that has never heard a request you control. $1.94/month buys determinism. |

Note what does _not_ need the MCP server running: the backend's own scheduler,
alerts, monitoring and inbox polling all live in the Python API. The MCP server is a
**control surface for agents**, not a worker. If you switch it off, nothing in the
company stops working.

## Two things to verify before trusting these numbers

1. **Does a request to a `.flycast` address wake a stopped Machine?** Autostart is
   documented as proxy-driven, and flycast traffic goes through the proxy — but this
   has not been verified on a live app here. Check with
   `fly logs -a <app>` after the first idle-then-call cycle. If it does not wake,
   either set `min_machines_running = 1` (+$1.94) or run a tiny uptime pinger.
2. **Rootfs billed size.** Fly bills the OCI image "plus a few containerd tweaks", so
   the real figure is a little above 42.7 MB. `fly machine list` shows the Machine
   size; the invoice line is the ground truth after one billing cycle.

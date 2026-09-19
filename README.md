# Open Executive

[![CI](https://github.com/SenteLabsAI/OpenExecutive/actions/workflows/ci.yml/badge.svg)](https://github.com/SenteLabsAI/OpenExecutive/actions/workflows/ci.yml)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![Python 3.11+](https://img.shields.io/badge/python-3.11+-blue.svg)](https://www.python.org/downloads/)
[![SvelteKit 2](https://img.shields.io/badge/SvelteKit-2-FF3E00.svg)](https://kit.svelte.dev/)
[![MCP](https://img.shields.io/badge/MCP-TMCP-6B7280.svg)](packages/mcp/)

### Your company deserves an executive team — even before you can afford one.

**Open Executive is an open-source AI executive that knows your business, remembers every decision, and gives you the same advice a senior leadership team would — on demand, in every tool you already use.**

One coherent voice. Eight specialists behind it. Your company context in every answer. And now, fully editable by any AI agent via API or MCP.

<p>

**[Get Started in 5 Minutes](#quick-start)** · **[Watch Demo](https://youtu.be/O_g97xxVTMk)** · **[How It Works](#how-it-works)** · **[MCP for AI Agents](#mcp--ai-editable-company-state)**

</p>

---

## Demo

[![Open Executive demo video](https://img.youtube.com/vi/O_g97xxVTMk/maxresdefault.jpg)](https://youtu.be/O_g97xxVTMk)

A walkthrough of Open Executive in action — [watch on YouTube](https://youtu.be/O_g97xxVTMk).

---

## The Problem

Early-stage companies make executive-level decisions every week — fundraising, hiring, positioning, operations — without an executive team to pressure-test them. Generic AI gives generic answers. Hiring advisors is slow and expensive. Context gets lost between tools.

## The Solution

Open Executive gives you a **virtual executive team that already knows your company**. Describe your business once, and every future answer is grounded in your actual profile, documents, and past decisions — not a generic template.

- **Knows your business** — company profile, uploaded docs, and goals shape every response.
- **Remembers what it told you** — episodic memory of decisions, initiatives, and advice across sessions.
- **Speaks with one voice** — eight specialists debate internally; you hear a single, coherent executive.
- **Works where you work** — web, Slack, email, Telegram, Google Chat, Discord, CLI, and now any AI agent via MCP.
- **Stays current** — any AI can update your company state as things change, via API or MCP.

---

## What It Does

Eight specialist agents, one executive voice. The internal architecture is never exposed to the user.

| Specialist                        | What They Cover                                            |
| --------------------------------- | ---------------------------------------------------------- |
| **Chief Strategy Officer**        | Competitive analysis, M&A, market positioning, OKRs        |
| **Chief Financial Officer**       | Financial modeling, fundraising, unit economics, cash flow |
| **Chief HR / People Officer**     | Hiring, compensation, performance, culture                 |
| **General Counsel**               | Contracts, IP, employment law basics, compliance           |
| **Chief Operating Officer**       | Process design, vendor management, operational scaling     |
| **Chief Marketing Officer**       | GTM strategy, brand, communications, PR                    |
| **Chief Product Officer**         | Roadmap, prioritization, product strategy                  |
| **Board Communications Director** | Board decks, investor relations, governance                |

Beyond Q&A, the system maintains **episodic memory** of past decisions and initiatives, and a built-in **scheduler** proactively surfaces follow-ups and time-sensitive actions.

---

## How It Works

### 1. Describe your business

Onboarding takes a few minutes — via a guided interview or a step-by-step form. Add your pitch deck, financial model, or strategy docs. Any AI agent can also do this for you via MCP.

### 2. Ask anything

Chat from the web, Slack, email, or any MCP-connected AI. The Executive routes your question to the right specialists in parallel, each retrieving relevant context from your knowledge base.

### 3. Get a grounded answer

Specialists return domain-expert analysis. The Executive synthesizes it into one coherent response — specific to your company, with memory of what it recommended last month.

```
You → Executive Orchestrator → parallel specialist calls (CSO / CFO / CHRO / GC / COO / CMO / CPO / Board)
                                    ↓ each retrieves from ChromaDB
                              Built-in MBA knowledge + Your company documents
                                    ↓
                         Synthesized executive response
```

**Knowledge** — Two retrieval layers per specialist: (1) built-in MBA-level Markdown (`knowledge/builtin/`, git-tracked) and (2) your uploaded company documents in a separate `company_docs` collection. RAG context is injected into the user turn, never the cached system prompt.

**Episodic memory** — After every response, a background `claude-haiku-4-5` pass extracts decisions, initiatives, and advice into SQLite. The next session opens with a `<past_decisions>` block.

**Scheduler** — Claims due actions via `UPDATE … RETURNING` to prevent double-firing. Single-instance API only.

**Prompt caching** — Persona, company profile, and knowledge index are cached separately (up to 85% hit rate after the first few turns).

See [docs/architecture.md](docs/architecture.md) for the full design.

---

## MCP — AI-Editable Company State

Open Executive is now **editable by any AI agent** — not just through the browser.

Any AI connected via **MCP (Model Context Protocol)** can read and update your company state as things happen: new hires, pivots, funding rounds, department changes. No manual form-filling.

| Capability                | How                                                                          |
| ------------------------- | ---------------------------------------------------------------------------- |
| **Onboarding**            | Any free-text description → interview → draft → commit. Works for any input. |
| **Company profile**       | Read and patch any field at any time.                                        |
| **People & departments**  | Full CRUD via API; MCP tools wrap the same routes.                           |
| **Knowledge & artifacts** | Upload, search, and manage documents.                                        |
| **Talent & watchlist**    | Manage searches, candidates, and watchlist items.                            |

**Two transports, one server** — `packages/mcp` (TMCP + Valibot) exposes every tool over both **STDIO** (local: Claude Code, Cursor) and **HTTP** (remote: `http://localhost:8787/mcp`). Both go through the same HTTP API, so validation and audit stay identical.

See [`packages/mcp/PLAN.md`](packages/mcp/PLAN.md) for the full tool inventory and expansion phases.

---

## Tech Stack

| Layer           | Choice                                                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| LLM backbone    | **DeepSeek** (OpenAI-compatible) — swappable to Anthropic Claude, OpenRouter, or any local model                                |
| Default model   | `deepseek-flash` · Deep reasoning: `deepseek-v4-pro` · Routing: `deepseek-flash`                                                |
| Backend         | Python 3.11 + FastAPI · `uv`                                                                                                    |
| Web UI          | **SvelteKit 2 + Svelte 5 (Bun)** — migrating from Next.js 15 · Tailwind v4 + shadcn-svelte · Better Auth · Drizzle + PostgreSQL |
| MCP Server      | **TMCP (TypeScript) + Valibot** · STDIO + Streamable HTTP (`srvx`) · `packages/mcp`                                             |
| Vector store    | ChromaDB (local, embedded)                                                                                                      |
| Episodic memory | SQLite + Honcho (optional per-person memory)                                                                                    |
| License         | Apache 2.0                                                                                                                      |

## Repo Layout

```
openexecutive/
├── packages/
│   ├── core/                  # Python backend — all agent, API, and workflow logic
│   │   └── openexecutive/
│   │       ├── orchestrator/  # Executive persona + routing loop
│   │       ├── agents/        # 8 specialist agents
│   │       ├── knowledge/     # ChromaDB store + RAG pipeline
│   │       ├── memory/        # Company profile + episodic memory
│   │       ├── onboarding/    # Interview + wizard + profile builder
│   │       ├── prompts/       # Persona + domain prompts + cache manager
│   │       ├── api/           # FastAPI app + routes
│   │       ├── mcp_server/    # Legacy Python MCP server (read-only, being superseded)
│   │       ├── integrations/  # Slack, Email, Telegram, Google Chat, Discord
│   │       ├── scheduler/     # Background job runner (single-instance)
│   │       ├── alerts/        # Proactive alert system
│   │       └── workflows/     # Multi-step workflow definitions
│   ├── web/                   # SvelteKit 2 + Svelte 5 web UI (Bun)
│   ├── mcp/                   # TMCP MCP server — AI-editable company state (Bun, Valibot)
│   └── ui/                    # Legacy Next.js 15 UI (frozen, reference only)
├── evals/                     # Eval scenarios + LLM-as-judge runner
├── fixtures/                  # Demo company fixtures
├── docker/                    # Dockerfile(s) + docker-compose.yml
└── docs/                      # Architecture + deployment docs
```

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/SenteLabsAI/OpenExecutive.git
cd OpenExecutive

# Set your DeepSeek API key (or any provider — see Configuration)
cp .env.example .env
# Edit .env — for DeepSeek (default):
#   LOCAL_MODELS_ENABLED=true
#   LOCAL_BASE_URL=https://api.deepseek.com
#   LOCAL_API_KEY=sk-... (from https://platform.deepseek.com/api_keys)
#   LOCAL_MODELS=deepseek-flash,deepseek-v4-pro
# For the web UI sign-in, also fill in the AUTH_* block (see docs/auth.md).

# Start everything — API + web + MCP
make dev
```

All configuration lives in the repo-root `.env` — `make dev` loads it for the API, web, and MCP server. `make stop` kills all three.

| Service    | URL                       | Port |
| ---------- | ------------------------- | ---- |
| Web UI     | http://localhost:5173     | 5173 |
| API        | http://localhost:8000     | 8000 |
| MCP (HTTP) | http://localhost:8787/mcp | 8787 |

> **First run:** requires Python 3.11+ and Bun. The initial `uv sync` pulls heavy ML dependencies (ChromaDB + sentence-transformers/PyTorch), and the first boot downloads a small embedding model (~90 MB) — so the first `make dev` takes a few minutes. Subsequent starts are fast.

**For contributors not using `make`:**

```bash
# API
cd packages/core && uv sync && source .venv/bin/activate
uvicorn openexecutive.api.main:app --reload --port 8000

# Web
cd packages/web && bun install && bun run dev

# MCP (STDIO for local agents, or HTTP for remote)
cd packages/mcp && bun install && bun run src/index.ts   # STDIO
cd packages/mcp && bun run src/http.ts                    # HTTP on 8787
```

**VS Code / Cursor MCP config** — `.vscode/mcp.json` is already set up for both transports:

```json
{
  "servers": {
    "open-executive": {
      "command": "bun",
      "args": ["run", "${workspaceFolder}/packages/mcp/src/index.ts"],
      "type": "stdio"
    },
    "open-executive-http": {
      "url": "http://localhost:8787/mcp",
      "type": "http"
    }
  }
}
```

`BACKEND_SHARED_SECRET` is optional for local dev (gate off). Set it on any public deployment.

---

## Run the Discord Bot

1. Create a Discord application at https://discord.com/developers/applications
2. Enable the **Message Content** privileged intent
3. Invite the bot with `bot` + `applications.commands` scopes
4. Set env vars in `.env`: `DISCORD_BOT_TOKEN`, `DISCORD_APP_ID`, `DISCORD_GUILD_IDS`
5. Run the API normally — the bot starts as part of the FastAPI lifespan when `DISCORD_BOT_TOKEN` is set:

```bash
make dev
```

The bot shares the same SQLite and ChromaDB store. `make discord` runs it standalone for iteration without restarting the API.

Users can DM the bot, `@mention` it in a channel, or use `/ask` and `/today` slash commands.

---

## Onboarding Your Company

The first time you visit the app, you'll be guided through setup:

- Company basics (name, industry, stage, team size)
- Business model and revenue
- Competitive landscape
- Strategic priorities
- Culture and values
- Optional: financial position, document upload

Or let **any AI agent do it for you** — describe your business in free text via MCP (`onboard_start` → `onboard_message` → `onboard_commit`), and the interview handles the rest.

After onboarding, the Executive references your specific company context in every response — and any AI can keep it current as things change.

---

## Interfaces

| Interface        | How to Use                                                 |
| ---------------- | ---------------------------------------------------------- |
| **Web UI**       | http://localhost:5173                                      |
| **MCP (any AI)** | STDIO or `http://localhost:8787/mcp` — see `packages/mcp/` |
| **Slack**        | Mention `@OpenExecutive` or DM the app                     |
| **Email**        | CC or email the configured address (IMAP/SMTP poller)      |
| **Telegram**     | Message the configured bot                                 |
| **Google Chat**  | Mention the app in a space                                 |
| **Discord**      | DM, `@mention`, or `/ask` / `/today` slash commands        |
| **CLI**          | `openexecutive chat`                                       |

---

## Document Upload

Upload your pitch deck, financial model, or strategy docs via the web UI, API, or MCP. The Executive will reference them when relevant.

```bash
# Via CLI
openexecutive upload deck.pdf model.xlsx strategy.md

# Via API
curl -X POST http://localhost:8000/documents \
  -F "file=@deck.pdf" \
  -F "domain=strategy"

# Via MCP (any AI agent)
# → upload_document tool in packages/mcp (Phase C)
```

---

## Deployment

Two containers — the FastAPI backend and the SvelteKit web UI — plus one persistent volume at `/data`. [docker/docker-compose.yml](docker/docker-compose.yml) is the reference topology and also what `make docker` runs locally.

> **⚠️ Single-instance only**: the scheduler claims rows via `UPDATE … RETURNING`. Pin the API to one instance. The web UI is stateless.

Set `ANTHROPIC_API_KEY`, `BACKEND_SHARED_SECRET`, `BACKEND_ALLOWED_ORIGINS` and `OE_PUBLIC_DEPLOYMENT=1` on any internet-reachable instance. See [docs/deployment.md](docs/deployment.md) for the full guide.

### Access control

Google sign-in with an email allow-list (Better Auth) + shared-secret header between the UI proxy and the FastAPI backend. See [docs/auth.md](docs/auth.md).

---

## Configuration

All settings via environment variables. Minimum required: one provider — DeepSeek (`LOCAL_*`), Anthropic (`ANTHROPIC_API_KEY`), or OpenRouter (`OPENROUTER_*`). See [Running on Local Models](#running-on-local-models). At least one provider must be set.

| Variable                     | Required | Default                  | Description                                                   |
| ---------------------------- | -------- | ------------------------ | ------------------------------------------------------------- |
| `ANTHROPIC_API_KEY`          | Yes¹     | —                        | Anthropic API key (when using Claude)                         |
| `LOCAL_API_KEY`              | Yes¹     | —                        | DeepSeek / gateway API key (when `LOCAL_MODELS_ENABLED=true`) |
| `DEFAULT_MODEL`              | No       | `deepseek-flash`         | Executive + most specialists                                  |
| `DEEP_REASONING_MODEL`       | No       | `deepseek-v4-pro`        | CSO, CFO, GC, Board                                           |
| `VECTOR_STORE_PATH`          | No       | `./chroma_db`            | ChromaDB directory                                            |
| `EPISODIC_DB_PATH`           | No       | `./episodic_memory.db`   | SQLite for episodic memory                                    |
| `COMPANY_PROFILE_PATH`       | No       | `./company/profile.yaml` | Company profile                                               |
| `ENABLE_CACHING`             | No       | `true`                   | Anthropic prompt caching                                      |
| `ROUTING_MODEL`              | No       | `deepseek-flash`         | Model for intent routing                                      |
| `SLACK_BOT_TOKEN`            | No       | —                        | Slack bot OAuth token                                         |
| `SLACK_APP_TOKEN`            | No       | —                        | Slack socket mode token                                       |
| `EXEC_EMAIL_ADDRESS`         | No       | —                        | Executive Gmail address                                       |
| `TELEGRAM_BOT_TOKEN`         | No       | —                        | Telegram bot token                                            |
| `DISCORD_BOT_TOKEN`          | No       | —                        | Discord bot token                                             |
| `GOOGLE_CHAT_PROJECT_NUMBER` | No       | —                        | GCP project number                                            |
| `GOOGLE_OAUTH_CLIENT_ID`     | No       | —                        | Google OAuth client ID                                        |
| `OPENROUTER_ENABLED`         | No       | `false`                  | Route Claude calls through OpenRouter                         |
| `LOCAL_MODELS_ENABLED`       | No       | `false`                  | Route to a local OpenAI-compatible server                     |
| `LOCAL_BASE_URL`             | No       | —                        | Local server URL, e.g. `http://localhost:11434/v1`            |
| `HONCHO_ENABLED`             | No       | `false`                  | Per-person memory layer ([honcho.dev](https://honcho.dev))    |
| `ENABLE_WEB_SEARCH`          | No       | `true`²                  | Live web results alongside your docs                          |
| `MCP_PORT`                   | No       | `8787`                   | MCP HTTP server port                                          |

See [.env.example](.env.example) for the full list.

> ¹ One provider is required: DeepSeek via `LOCAL_API_KEY` + `LOCAL_MODELS_ENABLED`, Anthropic via `ANTHROPIC_API_KEY`, or OpenRouter via `OPENROUTER_API_KEY`. DeepSeek is the default (`deepseek-flash` / `deepseek-v4-pro` via `https://api.deepseek.com`).

> ² Ships as `ENABLE_WEB_SEARCH=false` in `.env.example` so a fresh setup incurs no per-search charges. Flip to `true` and restart to enable.

---

## Running on DeepSeek (Default) and Other Models

Open Executive ships configured for **DeepSeek** (`deepseek-flash` / `deepseek-v4-pro` via `https://api.deepseek.com`) — just add your API key. Swap to any other provider without code changes.

### DeepSeek (default)

```bash
# In .env — already the default LOCAL_* values
LOCAL_MODELS_ENABLED=true
LOCAL_BASE_URL=https://api.deepseek.com
LOCAL_API_KEY=sk-...  # from https://platform.deepseek.com/api_keys
LOCAL_MODELS=deepseek-flash,deepseek-v4-pro
```

### Other providers

Any **OpenAI-compatible** server works — Ollama, LM Studio, vLLM, llama.cpp, or a hosted gateway. Anthropic Claude and OpenRouter are also supported directly.

#### Local models (Ollama example)

```bash
# 1. Pull a capable model
ollama pull llama3.3

# 2. In .env
LOCAL_MODELS_ENABLED=true
LOCAL_BASE_URL=http://localhost:11434/v1
LOCAL_MODELS=llama3.3

# 3. (Optional) run with NO Anthropic key
DEFAULT_MODEL=llama3.3
DEEP_REASONING_MODEL=llama3.3
ROUTING_MODEL=llama3.3
```

The listed slugs appear in the **Council UI** dropdown — run a hybrid setup with the Executive on Claude and individual specialists on a local model.

**Caveats.** Web search and prompt caching have no local equivalent and are disabled for local models. Pick a model strong at tool use (Llama 3.3 70B, Qwen2.5).

### Using a hosted OpenAI-compatible gateway

```bash
LOCAL_MODELS_ENABLED=true
LOCAL_BASE_URL=https://gateway.example.com/v1
LOCAL_API_KEY=your-gateway-key
LOCAL_MODELS=vendor/model-a,vendor/model-b
```

Everything the Executive processes is sent to whichever endpoint you configure — point these settings only at a provider you trust.

---

## Adding a New Specialist Agent

1. Create `packages/core/openexecutive/agents/your_agent.py` extending `BaseAgent`
2. Add a system prompt constant in `packages/core/openexecutive/prompts/domain_prompts.py`
3. Register in `packages/core/openexecutive/orchestrator/router.py`
4. Add domain alias to `DOMAIN_ALIASES` in `packages/core/openexecutive/knowledge/retriever.py`
5. Add knowledge docs to `knowledge/builtin/your_domain/`
6. Add at least 2 eval scenarios to `evals/scenarios/`
7. Submit a PR — CI requires all of the above

---

## Development

```bash
make dev          # Start API (8000) + web (5173) + MCP (8787)
make stop         # Stop all three
make test         # Run Python tests
make eval         # Run eval suite
make lint         # Run ruff + mypy
make docker       # Build and run Docker stack
```

---

## Evaluation System

`evals/` contains 29 scenarios covering all 8 domains, scored by `claude-opus-4-7` as an LLM-as-judge. Five scoring dimensions (persona coherence, domain accuracy, company context utilization, routing quality, actionability) rated 1–5. CI gate: ≥ 3.5/5 average; any dimension dropping > 10% vs `main` fails the PR.

---

## Privacy

Everything in `company/` is gitignored — profile YAML, uploaded documents, and ChromaDB store. None leaves your local machine (except as part of prompts sent to the Anthropic API). Anthropic does not train on API data.

---

## Contributing

See [.github/CONTRIBUTING.md](.github/CONTRIBUTING.md). All PRs must include working implementation, tests, and eval scenarios for new agents or prompt changes.

---

## License

Apache 2.0 — free to use commercially, requires attribution.

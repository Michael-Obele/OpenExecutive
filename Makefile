.PHONY: dev stop test lint eval docker clean install discord

install:
	cd packages/core && uv sync
	cd packages/web && bun install

# Both dev recipe lines source the repo-root .env into the process env:
# - the web needs it because SvelteKit only auto-loads packages/web/.env*, so
#   Better Auth never saw BETTER_AUTH_SECRET etc.;
# - the API needs it because BACKEND_SHARED_SECRET / BACKEND_ALLOWED_ORIGINS
#   are read from os.environ, not pydantic Settings — dotenv alone doesn't
#   surface them, silently leaving the API gate open.
# Note: exported values win over packages/web/.env.local for duplicate keys.
# .env values must be shell-safe: quote anything containing spaces or `$`.
dev:
	@echo "Starting Open Executive..."
	@if [ -f .env ]; then set -a; . ./.env; set +a; fi; cd packages/core && uv run uvicorn openexecutive.api.main:app --reload --port 8000 &
	@if [ -f .env ]; then set -a; . ./.env; set +a; fi; cd packages/web && bun run dev &
	@if [ -f .env ]; then set -a; . ./.env; set +a; fi; cd packages/mcp && MCP_PORT=8787 bun run src/http.ts

stop:
	@lsof -ti :8000 -ti :5173 -ti :8787 2>/dev/null | xargs kill -9 2>/dev/null || true
	@echo "Stopped."

test:
	cd packages/core && uv run pytest tests/ -v --tb=short

lint:
	cd packages/core && uv run ruff check openexecutive/ && uv run mypy openexecutive/

eval:
	cd packages/core && uv run python ../../evals/run_evals.py \
		--scenarios ../../evals/scenarios/ \
		--output ../../evals/results/

# --env-file makes ${VAR} interpolation in docker-compose.yml read the
# repo-root .env (compose only auto-reads docker/.env otherwise). The
# containers additionally load the full .env via each service's env_file.
COMPOSE_ENV_FILE := $(if $(wildcard .env),--env-file .env,)

docker:
	docker compose $(COMPOSE_ENV_FILE) -f docker/docker-compose.yml up --build

docker-down:
	docker compose $(COMPOSE_ENV_FILE) -f docker/docker-compose.yml down

clean:
	find . -type d -name __pycache__ -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete 2>/dev/null || true
	rm -rf packages/core/.venv packages/core/.mypy_cache packages/core/.ruff_cache
	rm -rf packages/web/node_modules packages/web/.svelte-kit packages/web/build

discord:
	cd packages/core && uv run python -m openexecutive.integrations.discord_bot

seed-knowledge:
	cd packages/core && uv run python -c "from openexecutive.knowledge.loader import seed_builtin_knowledge; import asyncio; asyncio.run(seed_builtin_knowledge())"

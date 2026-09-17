"""Invariants of the async Bolt conversion (#131).

`slack_bot.py` used to be a synchronous Bolt app whose listeners ran on a
10-worker thread pool and drove async code with `asyncio.run()` once per
message. It is now an `AsyncApp` whose listeners await on the application
event loop, because the lifespan starts it in-process and the MCP gateway,
the shared Anthropic client and the SSE queues are all bound to that loop.

That conversion has three failure modes these tests pin down:
  1. a call that became a coroutine but is not awaited — the bot silently
     stops replying;
  2. blocking SQLite/ChromaDB work left inline — it now stalls the whole API,
     not just one Bolt worker;
  3. unbounded concurrency — the async client fans out every envelope.
"""

from __future__ import annotations

import asyncio
import threading
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager, suppress
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from openexecutive.integrations import slack_bot

MENTION_EVENT = {
    "text": "<@UBOT> where are we on hiring?",
    "user": "U123",
    "channel": "C1",
    "ts": "1700000000.0",
}


@pytest.fixture(autouse=True)
def slack_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Tokens for the factory's guard, and no network for its auth_test().

    `create_slack_app()` resolves the bot's own user_id via `auth_test()` at
    construction; stub it so these tests never touch slack.com.
    """
    from openexecutive.config import get_settings

    stub = get_settings().model_copy(
        update={"slack_bot_token": "xoxb-test", "slack_app_token": "xapp-test"}
    )
    monkeypatch.setattr("openexecutive.config.get_settings", lambda: stub)
    monkeypatch.setattr(
        "slack_sdk.web.async_client.AsyncWebClient.auth_test",
        AsyncMock(return_value={"user_id": "UBOT"}),
    )
    # create_slack_app() assigns the module global; restore it so these tests
    # cannot leak a resolved id into any other Slack test.
    monkeypatch.setattr(slack_bot, "_bot_user_id", None)


def _person() -> MagicMock:
    p = MagicMock()
    p.id = 7
    p.display_name = "Alex"
    return p


class _Harness:
    """Patches every out-of-process dependency of the Slack handler."""

    def __init__(self) -> None:
        self.say = AsyncMock()
        self.client = MagicMock()
        self.client.conversations_replies = AsyncMock(return_value={"messages": []})
        self.retrieve_threads: list[str] = []
        self.chat = AsyncMock(return_value="the reply")

    def _record_retrieve(self, *_: Any, **kwargs: Any) -> str:
        self.retrieve_threads.append(threading.current_thread().name)
        self.store_arg = kwargs.get("store")
        return "ctx"

    def __enter__(self) -> _Harness:
        exec_patch = patch("openexecutive.orchestrator.executive.Executive")
        self._patches = [
            patch.object(slack_bot, "_bot_user_id", "UBOT"),
            patch("openexecutive.people.store.find_person_by_slack_id",
                  return_value=_person()),
            patch("openexecutive.audit.log_event"),
            patch("openexecutive.knowledge.retriever.retrieve",
                  side_effect=self._record_retrieve),
            patch("openexecutive.memory.episodic.format_for_prompt",
                  return_value="epi"),
            patch("openexecutive.onboarding.profile_builder.load_or_create_profile"),
            patch("openexecutive.alerts.pipeline.schedule_evaluation"),
            patch("openexecutive.mcp_server.server.get_store",
                  return_value="WARM_STORE"),
            patch("openexecutive.workflows.inbound_resolver.resolve_inbound_message",
                  new=AsyncMock(return_value=None)),
            exec_patch,
        ]
        for p in self._patches:
            started = p.start()
            if p is exec_patch:
                started.return_value.chat = self.chat
        return self

    def __exit__(self, *_: Any) -> None:
        for p in reversed(self._patches):
            p.stop()


@asynccontextmanager
async def _listeners() -> AsyncIterator[dict[str, Any]]:
    """Build the real async Bolt app and hand back its event listeners.

    Closes the socket-mode client on the way out so the suite does not leak
    an aiohttp session per test.
    """
    app, handler = await slack_bot.create_slack_app()
    try:
        yield {
            listener.ack_function.__name__: listener.ack_function
            for listener in app._async_listeners
        }
    finally:
        with suppress(Exception):
            await handler.close_async()
        session = getattr(app.client, "session", None)
        if session is not None and not session.closed:
            await session.close()


@pytest.mark.asyncio
async def test_mention_replies_with_no_unawaited_coroutine() -> None:
    """The whole handler path runs and replies exactly once.

    The real guard against the classic sync->async miss is `AsyncMock`, which
    distinguishes *called* from *awaited*: a coroutine that is created but
    never awaited leaves `assert_awaited_once()` failing. (Promoting
    RuntimeWarning to an error does NOT catch it — "coroutine was never
    awaited" is raised from `__del__` during GC, where Python prints
    "Exception ignored in" rather than failing the test.)

    These tests call the listener directly, so Bolt's middleware and kwarg
    injection are not exercised; `test_slack_lifespan.py` covers the wiring.
    """
    async with _listeners() as listeners:
        with _Harness() as h:
            await listeners["handle_mention"](
                event=dict(MENTION_EVENT), say=h.say, client=h.client
            )

            h.chat.assert_awaited_once()
            assert h.say.await_count == 1
            assert h.say.await_args.kwargs["text"] == "the reply"


@pytest.mark.asyncio
async def test_blocking_retrieval_runs_off_the_event_loop() -> None:
    """ChromaDB retrieval must not run inline on the application loop.

    `retrieve()` embeds the query on CPU and can take seconds; inline it would
    stall every other request in the process (`/chat`, `/health`, the
    scheduler, the Discord bot). api/routes/chat.py offloads the same call.
    """
    main_thread = threading.current_thread().name
    async with _listeners() as listeners:
        with _Harness() as h:
            await listeners["handle_mention"](
                event=dict(MENTION_EVENT), say=h.say, client=h.client
            )

    assert h.retrieve_threads, "retrieve() was never called"
    assert main_thread not in h.retrieve_threads, (
        "retrieve() ran on the event-loop thread — it must be offloaded "
        f"(threads seen: {h.retrieve_threads})"
    )


@pytest.mark.asyncio
async def test_retrieval_reuses_the_warm_store() -> None:
    """Passing the lifespan's store avoids building a ChromaDB client per message."""
    async with _listeners() as listeners:
        with _Harness() as h:
            await listeners["handle_mention"](
                event=dict(MENTION_EVENT), say=h.say, client=h.client
            )

    assert h.store_arg == "WARM_STORE"


@pytest.mark.asyncio
async def test_inbound_handling_is_concurrency_bounded() -> None:
    """The async client caps nothing; the adapter must cap itself.

    The sync adapter was bounded by Bolt's listener_executor
    (ThreadPoolExecutor(max_workers=5)), so a burst of Slack traffic could
    never fan out into more than 5 concurrent `executive.chat()` calls. The
    async client caps nothing, so the adapter has to cap itself.
    """
    peak = 0
    current = 0

    async def _slow_chat(**_: Any) -> str:
        nonlocal peak, current
        current += 1
        peak = max(peak, current)
        await asyncio.sleep(0.05)
        current -= 1
        return "the reply"

    async with _listeners() as listeners:
        with _Harness() as h:
            h.chat.side_effect = _slow_chat
            await asyncio.gather(*(
                listeners["handle_mention"](
                    event=dict(MENTION_EVENT), say=h.say, client=h.client
                )
                for _ in range(25)
            ))

    assert h.say.await_count == 25, "some messages were dropped"
    assert peak <= slack_bot._MAX_CONCURRENT_HANDLERS, (
        f"{peak} handlers ran concurrently, bound is "
        f"{slack_bot._MAX_CONCURRENT_HANDLERS}"
    )

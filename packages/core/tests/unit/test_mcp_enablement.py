"""MCP enablement and gateway-startup degradation (#122).

`_resolve_mcp` had no coverage at all, which is how the config file's presence
came to silently override an explicit `MCP_ENABLED=false` — and, because the
API lifespan started the gateway with no try/except, crash-loop a container
whose only symptom was a healthcheck that never passed.
"""
from __future__ import annotations

import asyncio
import json
import logging
from collections.abc import Iterator
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest

from openexecutive.api.main import _start_mcp_gateway
from openexecutive.config import Settings
from openexecutive.orchestrator.mcp_gateway import configured_server_names


@pytest.fixture
def oe_logs() -> Iterator[list[str]]:
    """Rendered messages from the ``openexecutive`` logger.

    ``caplog`` listens on the root logger and would miss these: the app's
    logging config (``main._configure_logging``, exercised by other tests in
    the suite) sets ``propagate = False`` on the ``openexecutive`` tree so
    uvicorn's dictConfig cannot clobber it. Attach to that logger directly.
    """
    messages: list[str] = []

    class _Collect(logging.Handler):
        def emit(self, record: logging.LogRecord) -> None:
            messages.append(record.getMessage())

    logger = logging.getLogger("openexecutive")
    handler = _Collect(level=logging.DEBUG)
    prior_level = logger.level
    logger.addHandler(handler)
    logger.setLevel(logging.DEBUG)
    try:
        yield messages
    finally:
        logger.removeHandler(handler)
        logger.setLevel(prior_level)


# ---------------------------------------------------------------------------
# Settings._resolve_mcp — explicit beats inferred
# ---------------------------------------------------------------------------


def _settings(monkeypatch: pytest.MonkeyPatch, **env: str) -> Settings:
    """Build Settings with MCP env controlled, ignoring the developer's .env.

    `Settings` reads `.env` as well as the process env, so a real
    `MCP_ENABLED` in the repo root would decide these tests. Point the
    env_file at a path that does not exist.
    """
    monkeypatch.delenv("MCP_ENABLED", raising=False)
    monkeypatch.delenv("MCP_SERVERS_CONFIG_PATH", raising=False)
    for key, value in env.items():
        monkeypatch.setenv(key, value)
    return Settings(_env_file=None)  # type: ignore[call-arg]


def test_explicit_false_survives_an_existing_config_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The regression this issue was filed for.

    `mcp_servers.json` is the natural thing to ship alongside `profile.yaml`
    and `docs/deployment.md` lists it under persistent state, so the file
    being present is not consent to run MCP.
    """
    config = tmp_path / "mcp_servers.json"
    config.write_text(json.dumps({"mcpServers": {"gw": {"command": "x"}}}))

    settings = _settings(
        monkeypatch, MCP_ENABLED="false", MCP_SERVERS_CONFIG_PATH=str(config)
    )

    assert settings.mcp_enabled is False


def test_unset_is_inferred_from_the_config_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The convenience path is kept for people who never touch the var."""
    config = tmp_path / "mcp_servers.json"
    config.write_text(json.dumps({"mcpServers": {"gw": {"command": "x"}}}))

    settings = _settings(monkeypatch, MCP_SERVERS_CONFIG_PATH=str(config))

    assert settings.mcp_enabled is True


def test_unset_with_no_config_file_stays_off(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(
        monkeypatch, MCP_SERVERS_CONFIG_PATH=str(tmp_path / "absent.json")
    )

    assert settings.mcp_enabled is False


def test_explicit_true_survives_a_missing_config_file(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Explicit wins in both directions — the lifespan reports the miss."""
    settings = _settings(
        monkeypatch,
        MCP_ENABLED="true",
        MCP_SERVERS_CONFIG_PATH=str(tmp_path / "absent.json"),
    )

    assert settings.mcp_enabled is True


def test_relative_config_path_is_resolved_against_cwd(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    settings = _settings(monkeypatch, MCP_SERVERS_CONFIG_PATH="company/mcp.json")

    assert settings.mcp_servers_config_path.is_absolute()
    assert settings.mcp_servers_config_path == Path.cwd() / "company/mcp.json"


# ---------------------------------------------------------------------------
# configured_server_names — "nothing to do" is knowable before we spawn
# ---------------------------------------------------------------------------


def test_server_names_are_returned_sorted(tmp_path: Path) -> None:
    config = tmp_path / "mcp.json"
    config.write_text(
        json.dumps({"mcpServers": {"zulu": {}, "alpha": {}}, "filters": {}})
    )

    assert configured_server_names(config) == ["alpha", "zulu"]


@pytest.mark.parametrize(
    "body",
    [
        pytest.param(json.dumps({"mcpServers": {}}), id="empty-mcpservers"),
        pytest.param(json.dumps({"filters": {}}), id="no-mcpservers-key"),
        pytest.param(json.dumps({"mcpServers": []}), id="mcpservers-not-an-object"),
        pytest.param(json.dumps(["gw"]), id="root-not-an-object"),
        pytest.param("{not json", id="malformed-json"),
        pytest.param("", id="empty-file"),
    ],
)
def test_configs_with_nothing_to_start_read_as_no_servers(
    tmp_path: Path, body: str
) -> None:
    """The reporter's case is `empty-mcpservers`: extensible-mcp raises
    ValueError on it and exits, and all that reaches us is an anyio
    cancel-scope error naming nothing about configuration."""
    config = tmp_path / "mcp.json"
    config.write_text(body)

    assert configured_server_names(config) == []


def test_missing_config_file_reads_as_no_servers(tmp_path: Path) -> None:
    assert configured_server_names(tmp_path / "absent.json") == []


def test_unreadable_config_file_reads_as_no_servers(tmp_path: Path) -> None:
    """A directory at the config path raises OSError rather than a JSON error."""
    config = tmp_path / "mcp.json"
    config.mkdir()

    assert configured_server_names(config) == []


# ---------------------------------------------------------------------------
# _start_mcp_gateway — a gateway failure must not take the container down
# ---------------------------------------------------------------------------


class _FakeApp:
    def __init__(self) -> None:
        self.state = MagicMock()


def _stub_gateway(
    monkeypatch: pytest.MonkeyPatch, start: Any
) -> tuple[MagicMock, MagicMock]:
    """Swap MCPGateway for a stub whose `start` does `start`, and capture the
    active-gateway singleton and email-poller calls."""
    gateway = MagicMock()
    gateway.start = AsyncMock(side_effect=start)
    gateway.close = AsyncMock()
    set_active = MagicMock()

    monkeypatch.setattr(
        "openexecutive.orchestrator.mcp_gateway.MCPGateway",
        MagicMock(return_value=gateway),
    )
    monkeypatch.setattr(
        "openexecutive.orchestrator.mcp_gateway.set_active_gateway", set_active
    )

    async def _never_ending_poller(_gateway: Any) -> None:
        await asyncio.Event().wait()

    monkeypatch.setattr(
        "openexecutive.integrations.email_poller.run_email_poller",
        _never_ending_poller,
    )
    return gateway, set_active


def _mcp_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, body: str) -> Settings:
    config = tmp_path / "mcp_servers.json"
    config.write_text(body)
    return _settings(
        monkeypatch, MCP_ENABLED="true", MCP_SERVERS_CONFIG_PATH=str(config)
    )


def test_gateway_failure_leaves_the_app_bootable(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, oe_logs: list[str]
) -> None:
    """The crash loop: this exception used to propagate out of the lifespan and
    kill the container. It must be logged and swallowed instead."""
    gateway, set_active = _stub_gateway(
        monkeypatch,
        RuntimeError("Attempted to exit cancel scope in a different task"),
    )
    settings = _mcp_settings(
        tmp_path, monkeypatch, json.dumps({"mcpServers": {"google_workspace": {}}})
    )
    app = _FakeApp()

    task = asyncio.run(_start_mcp_gateway(app, settings))  # type: ignore[arg-type]

    assert task is None, "no email poller should ride on a gateway that is down"
    assert app.state.mcp_gateway is None
    set_active.assert_not_called()
    # The half-started subprocess and stdio context have to be reaped.
    gateway.close.assert_awaited_once()
    # The log has to carry what the anyio traceback did not: the config path
    # and the servers it named.
    logged = "\n".join(oe_logs)
    assert str(settings.mcp_servers_config_path) in logged
    assert "google_workspace" in logged


def test_gateway_is_not_started_when_no_servers_are_configured(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, oe_logs: list[str]
) -> None:
    gateway, set_active = _stub_gateway(monkeypatch, None)
    settings = _mcp_settings(tmp_path, monkeypatch, json.dumps({"mcpServers": {}}))

    task = asyncio.run(_start_mcp_gateway(_FakeApp(), settings))  # type: ignore[arg-type]

    assert task is None
    gateway.start.assert_not_awaited()
    set_active.assert_not_called()
    assert "no servers" in "\n".join(oe_logs)


def test_warning_names_the_config_file_as_the_cause_when_auto_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, oe_logs: list[str]
) -> None:
    """An operator who never set MCP_ENABLED needs to be told that the file is
    what turned MCP on — that is the whole diagnosis the reporter had to read
    config.py to reach."""
    _stub_gateway(monkeypatch, None)
    config = tmp_path / "mcp_servers.json"
    config.write_text(json.dumps({"mcpServers": {}}))
    settings = _settings(monkeypatch, MCP_SERVERS_CONFIG_PATH=str(config))
    assert settings.mcp_auto_enabled is True

    asyncio.run(_start_mcp_gateway(_FakeApp(), settings))  # type: ignore[arg-type]

    logged = "\n".join(oe_logs)
    assert "auto-enabled by the presence of the config file" in logged
    assert "MCP_ENABLED=false" in logged, "tell them how to turn it off"


def test_explicitly_enabled_is_not_reported_as_auto_enabled(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, oe_logs: list[str]
) -> None:
    """The mirror of the test above, and the one that catches the trap: the
    validator's own `self.mcp_enabled = True` lands in `model_fields_set`, so
    reading that set downstream reports every auto-enable as explicit."""
    _stub_gateway(monkeypatch, None)
    settings = _mcp_settings(tmp_path, monkeypatch, json.dumps({"mcpServers": {}}))
    assert settings.mcp_auto_enabled is False

    asyncio.run(_start_mcp_gateway(_FakeApp(), settings))  # type: ignore[arg-type]

    logged = "\n".join(oe_logs)
    assert "MCP_ENABLED was set explicitly" in logged
    assert "auto-enabled" not in logged


def test_successful_start_wires_the_gateway_and_the_email_poller(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    gateway, set_active = _stub_gateway(monkeypatch, None)
    settings = _mcp_settings(
        tmp_path, monkeypatch, json.dumps({"mcpServers": {"google_workspace": {}}})
    )
    app = _FakeApp()

    async def _run() -> asyncio.Task[None] | None:
        task = await _start_mcp_gateway(app, settings)  # type: ignore[arg-type]
        if task is not None:
            task.cancel()
        return task

    task = asyncio.run(_run())

    assert task is not None
    assert app.state.mcp_gateway is gateway
    set_active.assert_called_once_with(gateway)
    gateway.start.assert_awaited_once_with(settings.mcp_servers_config_path)


def test_mcp_disabled_starts_nothing(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    gateway, _ = _stub_gateway(monkeypatch, None)
    config = tmp_path / "mcp_servers.json"
    config.write_text(json.dumps({"mcpServers": {"google_workspace": {}}}))
    settings = _settings(
        monkeypatch, MCP_ENABLED="false", MCP_SERVERS_CONFIG_PATH=str(config)
    )
    app = _FakeApp()

    task = asyncio.run(_start_mcp_gateway(app, settings))  # type: ignore[arg-type]

    assert task is None
    assert app.state.mcp_gateway is None
    gateway.start.assert_not_awaited()

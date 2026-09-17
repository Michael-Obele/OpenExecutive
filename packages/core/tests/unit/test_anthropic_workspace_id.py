"""Organisation-scoped Anthropic keys need a workspace header (#128).

A key issued inside a workspace carries its own scope. A key issued at the
organisation level does not, and Anthropic rejects every call made with one
unless the request sends `anthropic-workspace-id`. Before this setting existed
the failure surfaced as a generic "internal error" in the UI, because the 400
happens after the SSE stream has already returned 200.

The header is set on the client rather than per request: `create` and `stream`
both need it, and every Claude call in the app resolves through this one
provider.
"""
from __future__ import annotations

import os
from typing import Any

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-test-not-used")

import pytest  # noqa: E402

from openexecutive.providers import registry as registry_mod  # noqa: E402
from openexecutive.providers.anthropic_provider import AnthropicProvider  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_singleton() -> Any:
    registry_mod._reset_for_tests()
    yield
    registry_mod._reset_for_tests()


def _headers(provider: AnthropicProvider) -> dict[str, str]:
    """The default headers the SDK client will send on every request."""
    return dict(provider._client.default_headers)


def test_workspace_id_is_sent_as_a_default_header() -> None:
    provider = AnthropicProvider(api_key="sk-test", workspace_id="wrkspc_123")

    assert _headers(provider)["anthropic-workspace-id"] == "wrkspc_123"


def test_no_workspace_id_sends_no_header() -> None:
    """A workspace-scoped key must keep working untouched — sending an empty
    or absent workspace id is not the same as sending none."""
    provider = AnthropicProvider(api_key="sk-test")

    assert "anthropic-workspace-id" not in _headers(provider)


def test_empty_workspace_id_sends_no_header() -> None:
    """`ANTHROPIC_WORKSPACE_ID=` in a .env file arrives as an empty string, not
    None. Forwarding that would turn a working install into a 400."""
    provider = AnthropicProvider(api_key="sk-test", workspace_id="")

    assert "anthropic-workspace-id" not in _headers(provider)


def test_the_header_is_purely_additive() -> None:
    """`default_headers` must not displace what the SDK sets for itself.

    Auth and the API version ride in the same mapping, so a construction that
    replaced it rather than adding to it would break every call — and would
    look identical to a working one from the workspace assertions above.
    """
    plain = AnthropicProvider(api_key="sk-test")
    with_ws = AnthropicProvider(api_key="sk-test", workspace_id="wrkspc_123")

    added = set(_headers(with_ws)) - set(_headers(plain))

    assert added == {"anthropic-workspace-id"}
    assert with_ws._client.auth_headers == plain._client.auth_headers


def test_workspace_id_survives_alongside_a_timeout() -> None:
    provider = AnthropicProvider(api_key="sk-test", timeout=30.0, workspace_id="wrkspc_123")

    assert _headers(provider)["anthropic-workspace-id"] == "wrkspc_123"
    assert provider._client.timeout == 30.0


def test_registry_passes_the_configured_workspace_id(monkeypatch: pytest.MonkeyPatch) -> None:
    """Guards the wiring end to end, not just the constructor.

    `get_settings()` builds a fresh `Settings` on every call, so this goes
    through the environment exactly as a real `.env` does — patching the
    settings object would prove nothing about a deployment.
    """
    monkeypatch.setenv("ANTHROPIC_WORKSPACE_ID", "wrkspc_from_env")
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    provider = registry_mod._anthropic()

    assert _headers(provider)["anthropic-workspace-id"] == "wrkspc_from_env"


def test_registry_sends_no_header_when_the_var_is_unset(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("ANTHROPIC_WORKSPACE_ID", raising=False)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-test")

    provider = registry_mod._anthropic()

    assert "anthropic-workspace-id" not in _headers(provider)


def test_settings_reads_the_var_from_the_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    """The alias has to match what operators put in `.env`."""
    from openexecutive.config import get_settings

    monkeypatch.setenv("ANTHROPIC_WORKSPACE_ID", "wrkspc_alias_check")

    assert get_settings().anthropic_workspace_id == "wrkspc_alias_check"


def test_settings_default_is_none(monkeypatch: pytest.MonkeyPatch) -> None:
    from openexecutive.config import get_settings

    monkeypatch.delenv("ANTHROPIC_WORKSPACE_ID", raising=False)

    assert get_settings().anthropic_workspace_id is None

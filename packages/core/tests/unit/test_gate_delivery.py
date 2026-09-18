"""A wait-for-human gate must record where its answer will come from.

Before this module existed, `dynamic.py` built the gate with empty `channel`,
`channel_ref` and `outbound_message_id`, both checkpoint sites wrote that empty
state straight to `workflow_runs.state_json`, and nobody was ever actually
asked. The run sat at `awaiting_human` until it timed out, and the inbound
resolver's channel filter could never match a reply (#136).

Two modes and three ways delivery can fail to happen are pinned here. The
failure modes matter as much as the happy path: a suppressed or undeliverable
question must NOT leave routing fields behind that imply someone was asked.
"""
from __future__ import annotations

import asyncio
import json
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest

from openexecutive.orchestrator.schedule_tools import current_session
from openexecutive.orchestrator.session import Session
from openexecutive.workflows.gate_delivery import deliver_gate_question
from openexecutive.workflows.wait_for_human import WaitForHumanEvent


def _gate(person_id: int = 7) -> WaitForHumanEvent:
    return WaitForHumanEvent(
        person_id=person_id,
        question="Approve the vendor renegotiation?",
        context_summary="Contract renews in 10 days.",
    )


def _deliver(event: WaitForHumanEvent) -> tuple[WaitForHumanEvent, str]:
    return asyncio.run(
        deliver_gate_question(event, run_id="run-1", workflow_title="Vendor Review")
    )


@pytest.fixture(autouse=True)
def _clear_session() -> Any:
    """`current_session` is a module-level ContextVar — reset it between tests
    so one test's session can't leak into the next."""
    token = current_session.set(None)
    yield
    current_session.reset(token)


# --------------------------------------------------------------------- #
# Mode 1: the approver is already in this conversation
# --------------------------------------------------------------------- #


def test_self_approval_sends_nothing_and_scopes_to_the_session() -> None:
    """The Executive is about to put the question in its own reply. DMing the
    person a second copy would be absurd."""
    current_session.set(
        Session(
            session_id="slack:dm:U123",
            origin_channel="slack",
            origin_channel_ref="U123",
            caller_person_id=7,
        )
    )
    send = AsyncMock()

    with patch(
        "openexecutive.orchestrator.schedule_tools.handle_message_person", send
    ):
        routed, delivery = _deliver(_gate(person_id=7))

    send.assert_not_awaited()
    assert delivery == "self"
    assert routed.channel == "slack"
    assert routed.channel_ref == "U123"
    assert routed.origin_session_id == "slack:dm:U123"
    # No outbound message exists to reference — tier 2 does the matching.
    assert routed.outbound_message_id == ""


def test_gate_for_someone_else_is_actually_sent_to_them() -> None:
    """Same chat session, but the approver is a different person."""
    current_session.set(
        Session(
            session_id="slack:dm:U123",
            origin_channel="slack",
            origin_channel_ref="U123",
            caller_person_id=7,
        )
    )
    send = AsyncMock(
        return_value=json.dumps(
            {
                "status": "sent",
                "channel": "telegram",
                "channel_ref": "556677",
                "message_id": "tg-9",
            }
        )
    )

    with patch(
        "openexecutive.orchestrator.schedule_tools.handle_message_person", send
    ):
        routed, delivery = _deliver(_gate(person_id=99))

    send.assert_awaited_once()
    assert delivery == "sent"
    assert routed.channel == "telegram"
    assert routed.outbound_message_id == "tg-9"
    # Not scoped to the launcher's conversation — the approver answers wherever
    # they were reached.
    assert routed.origin_session_id == ""


# --------------------------------------------------------------------- #
# Mode 2: out of band
# --------------------------------------------------------------------- #


def test_web_originated_gate_is_delivered_and_routed() -> None:
    """No chat session at all (a /jobs run)."""
    send = AsyncMock(
        return_value=json.dumps(
            {
                "status": "sent",
                "channel": "slack_dm",  # outbound vocabulary
                "channel_ref": "U500",
                "message_id": "1700000000.5",
            }
        )
    )

    with patch(
        "openexecutive.orchestrator.schedule_tools.handle_message_person", send
    ):
        routed, delivery = _deliver(_gate())

    assert delivery == "sent"
    # Canonicalised to the inbound vocabulary the resolver matches on.
    assert routed.channel == "slack"
    assert routed.channel_ref == "U500"
    assert routed.outbound_message_id == "1700000000.5"

    # The question the approver receives carries enough to act on.
    sent_text = send.await_args.args[0]["text"]
    assert "Approve the vendor renegotiation?" in sent_text
    assert "Vendor Review" in sent_text
    assert "Contract renews in 10 days." in sent_text


@pytest.mark.parametrize(
    ("payload", "expected"),
    [
        ({"status": "suppressed", "reason": "quiet_hours"}, "suppressed"),
        ({"status": "alerted", "reason": "dm_undeliverable"}, "alerted"),
        ({"error": "no such person"}, "failed"),
    ],
)
def test_undelivered_question_leaves_no_routing_fields(
    payload: dict[str, Any], expected: str
) -> None:
    """The anti-spam guard can suppress the send, and an unreachable person
    falls back to a briefing alert. In both cases the question is NOT sitting
    somewhere they can reply to, so advertising a channel would make the
    resolver match a reply against a question that was never asked."""
    send = AsyncMock(return_value=json.dumps(payload))

    with patch(
        "openexecutive.orchestrator.schedule_tools.handle_message_person", send
    ):
        routed, delivery = _deliver(_gate())

    assert delivery == expected
    assert routed.channel == ""
    assert routed.channel_ref == ""
    assert routed.outbound_message_id == ""


def test_delivery_never_raises() -> None:
    """A delivery problem must not fail the run that is trying to pause."""
    send = AsyncMock(side_effect=RuntimeError("slack is down"))

    with patch(
        "openexecutive.orchestrator.schedule_tools.handle_message_person", send
    ):
        routed, delivery = _deliver(_gate())

    assert delivery == "failed"
    assert routed.channel == ""


def test_the_original_event_is_never_mutated() -> None:
    send = AsyncMock(
        return_value=json.dumps(
            {
                "status": "sent",
                "channel": "slack",
                "channel_ref": "U500",
                "message_id": "m-1",
            }
        )
    )
    original = _gate()

    with patch(
        "openexecutive.orchestrator.schedule_tools.handle_message_person", send
    ):
        routed, _ = _deliver(original)

    assert original.channel == ""
    assert routed.channel == "slack"

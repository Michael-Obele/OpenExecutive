"""WaitForHuman workflow primitive — pause/resume across async human replies.

A workflow yields a ``WaitForHumanEvent`` to pause itself at an approval
gate. The caller (scheduler cadence runner or workflow HTTP runner) calls
``save_checkpoint`` and exits; the run sits in ``status='awaiting_human'``.

The ``run_resumer`` background loop watches for timeouts.  The inbound
resolver (Slack / Telegram / email hooks) calls ``apply_resolution`` when
a human replies, which stores the ``WaitForHumanResolution`` and advances
the run to ``status='resolved'``.

Phase 6 note: full generator resume (deserialising the execution frame) is
deferred to Phase 7.  This module ships the data model and ``parse_decision``
— the pieces needed for timeout handling and resolution recording.
"""
from __future__ import annotations

import logging
from typing import Any, Literal

from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

_CONFIDENCE_THRESHOLD = 0.85


class WaitForHumanEvent(BaseModel):
    """Yielded by a workflow step that requires human approval or input.

    The workflow runner serialises this to ``state_json`` in ``workflow_runs``
    and sets ``status='awaiting_human'``.
    """

    person_id: int
    question: str
    timeout_hours: int = 48
    on_timeout: Literal["escalate", "auto_proceed", "fail"] = "escalate"
    context_summary: str = ""
    expected_reply_shape: Literal[
        "approve_reject", "free_text", "numeric", "document"
    ] = "approve_reject"
    # Optional: department slug for escalation routing.
    department: str = ""
    # The outbound message id sent to the person — used by the inbound resolver
    # to match replies via explicit reference (tier 1).
    outbound_message_id: str = ""
    # Channel the question was sent on (e.g. "slack", "email", "telegram").
    channel: str = ""
    # Channel-specific address used (Slack user id, email address, chat_id str).
    channel_ref: str = ""
    # How the question actually reached the approver, set by
    # `gate_delivery.deliver_gate_question`: self / sent / suppressed /
    # alerted / failed. Its PRESENCE also dates the checkpoint — a row
    # written before gate delivery existed has no `delivery` key at all,
    # which is how the resolver tells a legacy row (safe to match loosely)
    # from one whose delivery genuinely failed (must not be).
    delivery: str = ""
    # Chat session the gate was raised from, when a person launched the
    # workflow conversationally and is themselves the approver. The inbound
    # resolver matches such a gate ONLY against replies in that same session,
    # so an open gate in one Slack DM cannot swallow an unrelated message in
    # another thread. Empty for web/scheduler-originated runs, which fall back
    # to channel matching.
    origin_session_id: str = ""


# Outbound channel vocabulary (`slack_dm`, `discord_dm`) differs from the
# inbound vocabulary the adapters use when resolving a reply (`slack`,
# `discord`). Canonicalise on WRITE so `state_json` only ever holds inbound
# keys — normalising at read time instead would leave two conventions in the
# database.
_CHANNEL_ALIASES = {
    "slack_dm": "slack",
    "discord_dm": "discord",
}


def normalize_channel(channel: str) -> str:
    """Map an outbound channel key onto its inbound equivalent."""
    key = (channel or "").strip().lower()
    return _CHANNEL_ALIASES.get(key, key)


class WaitForHumanResolution(BaseModel):
    """Recorded when a human successfully replies to a WaitForHumanEvent."""

    run_id: str = ""
    reply_text: str
    source_channel: str
    source_message_id: str = ""
    parsed_decision: dict[str, Any] = Field(default_factory=dict)
    person_id: int
    resolved_at: str = ""


# ---------------------------------------------------------------------------
# Decision parser
# ---------------------------------------------------------------------------

_SYSTEM_PROMPT = (
    "You are a structured reply parser. "
    "Extract the human's decision from their message and return JSON only. "
    "No markdown, no explanation — pure JSON object on a single line."
)

_SHAPE_PROMPTS: dict[str, str] = {
    "approve_reject": (
        'Return: {"decision": "approve|reject|defer|unrelated", '
        '"note": "<brief reason, max 100 chars>"}\n'
        "Rules: approve = yes/ok/agreed/sounds good/LGTM; reject = no/denied/decline; "
        "defer = maybe later/need more info/not now. "
        "unrelated = the message is not a response to this question at all "
        "(a new request, a different topic, small talk) — use it whenever the "
        "message does not read as an answer to THIS question, even loosely. "
        "When the message IS an answer but its verdict is ambiguous, choose defer."
    ),
    "free_text": (
        'Return: {"text": "<exact reply text, max 500 chars>"}'
    ),
    "numeric": (
        'Return: {"value": <number or null>, "unit": "<unit string or empty>"}\n'
        "Extract the primary numeric value. Null if no number is present."
    ),
    "document": (
        'Return: {"received": true, "text_preview": "<first 200 chars of content>"}'
    ),
}

# Marks a parse_decision result as the fallback rather than a real verdict.
# The previous sentinel was `note == "parse_error"`, which the model itself
# can emit — a human replying "no, your parser threw a parse_error" could
# produce it, and a genuine rejection would then be silently discarded.
# A dunder-ish key under our own namespace is not something the shape prompts
# ask for, so the model has no reason to produce it.
PARSE_FAILED_KEY = "__oe_parse_failed__"

_FALLBACKS: dict[str, dict[str, Any]] = {
    "approve_reject": {"decision": "defer", "note": "parse_error"},
    "free_text": {"text": ""},
    "numeric": {"value": None, "unit": ""},
    "document": {"received": False, "text_preview": ""},
}


async def parse_decision(
    text: str, expected_shape: str, question: str = ""
) -> dict[str, Any]:
    """Parse a human reply into a structured decision dict.

    ``question`` is the gate's own question. Without it the parser sees only
    the reply, so a bare "yes" — which may have been answering the Executive
    about something else entirely — can never be judged ``unrelated``.

    Uses the Council-configurable ``utility_fast`` model (default
    ``settings.routing_model``) for low-latency parsing. Returns a safe
    fallback dict on API errors so callers never see None.
    """
    import json as _json

    from openexecutive.agents.utility_fast import get_fast_model

    shape_prompt = _SHAPE_PROMPTS.get(expected_shape, _SHAPE_PROMPTS["free_text"])
    fallback = _FALLBACKS.get(expected_shape, {"text": ""})

    try:
        from openexecutive.config import get_settings
        from openexecutive.providers import get_provider

        settings = get_settings()
        model = get_fast_model()
        response = await get_provider(model).messages_create(
            model=model,
            max_tokens=256,
            timeout=settings.utility_fast_timeout_s,
            system=_SYSTEM_PROMPT,
            messages=[
                {
                    "role": "user",
                    "content": (
                        f"Parse this reply (expected shape: {expected_shape}):\n\n"
                        f"{shape_prompt}\n\n"
                        + (
                            f"The question it should be answering:\n"
                            f"{question[:500]}\n\n"
                            if question
                            else ""
                        )
                        + f"Reply to parse:\n{text[:1000]}"
                    ),
                }
            ],
        )
        # The SDK only emits text blocks for this prompt (no tools, no
        # thinking). The union-attr complaint mypy raises here is a false
        # positive at runtime; suppress rather than narrowing because the
        # existing tests rely on duck-typed block stubs that wouldn't pass
        # an isinstance(TextBlock) check.
        raw = response.content[0].text.strip() if response.content else ""  # type: ignore[union-attr]
        # Strip any accidental markdown fences.
        if raw.startswith("```"):
            raw = raw.split("```")[1].lstrip("json").strip()
        return _json.loads(raw)
    except Exception:
        logger.exception("parse_decision: failed for shape=%r text=%r", expected_shape, text[:80])
        return {**fallback, PARSE_FAILED_KEY: True}

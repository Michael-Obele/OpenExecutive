"""The one place an approval gate is turned into a persisted pause.

Three runners can receive a ``WaitForHumanEvent``: the HTTP/SSE route, the
chat tool, and — once a run can be resumed — the resumer itself when a
workflow hits a *second* gate. Each needs the identical sequence (deliver the
question, checkpoint the run, report what happened), and before this module
each carried its own copy. The copies had already started to differ, and the
sequence is not forgiving: get the order wrong and the run is either
advertised as awaiting a reply nobody was asked for, or checkpointed without
the routing fields the inbound resolver matches against.

``ensure_workflow_event`` is the other half. Nine more sites iterate a
workflow's event stream and cannot pause. None can reach a dynamic workflow
today, so none can see a gate — but that is a property of today's registry,
not of their code, and the failure mode if it ever changes is a run that
silently drops every step after the gate (or an opaque ``AttributeError`` on
``event.type``). The guard makes that a loud, named failure instead.
"""
from __future__ import annotations

import logging
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

from pydantic import BaseModel

import openexecutive.workflows.gate_delivery as _gate_delivery
from openexecutive.workflows.base import WorkflowEvent
from openexecutive.workflows.gate_delivery import DeliveryStatus
from openexecutive.workflows.persistence import save_checkpoint
from openexecutive.workflows.wait_for_human import WaitForHumanEvent

logger = logging.getLogger(__name__)


class UnsupportedGateError(RuntimeError):
    """A workflow raised an approval gate at a runner that cannot pause."""


class GatePause(BaseModel):
    """What a caller needs to report a pause. Plain data, no engine state."""

    run_id: str
    person_id: int
    question: str
    awaiting_until: datetime
    expected_reply_shape: str
    # How the question reached the approver: self / sent / suppressed /
    # alerted / failed. Anything but `sent` or `self` means nobody was
    # actually asked, and the caller must not imply otherwise.
    delivery: DeliveryStatus
    # True when the engine supplied a resume payload, so the run will continue
    # on its own once answered. False means pause-only: the decision is
    # recorded and the run stops there.
    resumable: bool


async def checkpoint_gate(
    *,
    run_id: str,
    event: WaitForHumanEvent,
    workflow_title: str = "",
    now: datetime | None = None,
    db_path: Path | None = None,
) -> GatePause:
    """Deliver an approval gate's question and persist the pause.

    Order matters and is not incidental: delivery runs FIRST so the routing
    fields it discovers (channel, channel_ref, outbound_message_id) are part
    of the `state_json` we write. Checkpointing first and delivering after
    would leave a window where a reply could arrive against a checkpoint that
    cannot match it.

    Raises if the checkpoint cannot be written — a caller must NOT report
    `awaiting_human` when this raises, because a run that was never
    checkpointed is invisible to the resumer and the inbound resolver, and
    would sit in `running` forever. Delivery failures do not raise (see
    `gate_delivery`); they come back as `delivery` for the caller to relay.
    """
    until = (now or datetime.now(UTC)) + timedelta(hours=event.timeout_hours)
    # Module-qualified, not a from-import: tests patch
    # `gate_delivery.deliver_gate_question` at its source, and a name bound
    # here at import time would silently ignore that.
    gate, delivery = await _gate_delivery.deliver_gate_question(
        event, run_id=run_id, workflow_title=workflow_title
    )
    # `deliver_gate_question` returns a model_copy, which preserves fields it
    # does not update — `resume_state` among them. Read the payload off the
    # RETURNED gate, not the original, so a future delivery path that rebuilt
    # the event would surface here rather than silently dropping resume.
    resume_state_json = (
        gate.resume_state.model_dump_json() if gate.resume_state is not None else None
    )
    save_checkpoint(
        run_id=run_id,
        # `resume_state` is excluded at the field level, so this is exactly the
        # checkpoint shape the inbound resolver reads.
        state_json=gate.model_dump_json(),
        awaiting_person_id=gate.person_id,
        awaiting_until=until,
        db_path=db_path,
        resume_state_json=resume_state_json,
    )
    logger.info(
        "gate: run %s paused for person %s (delivery=%s, resumable=%s)",
        run_id, gate.person_id, delivery, resume_state_json is not None,
    )
    return GatePause(
        run_id=run_id,
        person_id=gate.person_id,
        question=gate.question,
        awaiting_until=until,
        expected_reply_shape=gate.expected_reply_shape,
        delivery=delivery,
        resumable=resume_state_json is not None,
    )


def ensure_workflow_event(event: object, *, site: str) -> WorkflowEvent:
    """Pass a WorkflowEvent through; raise on an approval gate.

    For the runners that have no human to ask and no way to pause. Raising is
    the point: these sites all treat an exception as a run failure, so a gate
    that reaches one becomes a failed run naming the site, instead of a run
    that reports success having quietly skipped everything after the gate.
    """
    if isinstance(event, WaitForHumanEvent):
        raise UnsupportedGateError(
            f"{site}: workflow yielded an approval gate, but this runner "
            "cannot pause for a human — every step after the gate would be "
            "dropped. Run this workflow from the /jobs page or the chat tool."
        )
    return cast(WorkflowEvent, event)


__all__ = [
    "GatePause",
    "UnsupportedGateError",
    "checkpoint_gate",
    "ensure_workflow_event",
]

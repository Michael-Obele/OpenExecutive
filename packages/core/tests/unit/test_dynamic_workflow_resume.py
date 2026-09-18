"""DynamicWorkflow.resume — continuing a run past an answered approval gate.

The engine half of resume. `test_resumer.py` covers the background executor
that calls into this; here the question is only whether the step loop picks up
at the right place, with the right state, and refuses when it cannot.
"""
from __future__ import annotations

import os
from typing import Any
from unittest.mock import MagicMock

import pytest

os.environ.setdefault("ANTHROPIC_API_KEY", "sk-test-not-used")

from openexecutive.workflows import dynamic as dyn  # noqa: E402
from openexecutive.workflows.dynamic import DynamicWorkflow  # noqa: E402
from openexecutive.workflows.dynamic_models import DynamicWorkflowDef  # noqa: E402
from openexecutive.workflows.wait_for_human import (  # noqa: E402
    WaitForHumanEvent,
    WaitForHumanResolution,
    WorkflowResumeState,
)


@pytest.fixture(autouse=True)
def _stub_context(monkeypatch: pytest.MonkeyPatch) -> None:
    """No real profile / RAG / specialist calls."""
    fake_profile = MagicMock()
    fake_profile.name = "Acme"
    fake_profile.is_empty.return_value = True
    monkeypatch.setattr(dyn, "load_or_create_profile", lambda: fake_profile)
    monkeypatch.setattr(dyn, "retrieve", lambda **kw: "")


def _def(steps: list[dict[str, Any]] | None = None, **overrides: Any) -> DynamicWorkflowDef:
    base: dict[str, Any] = {
        "name": "weekly_watch",
        "title": "Weekly Watch",
        "input_fields": [{"name": "topic", "label": "Topic", "required": True}],
        "steps": steps
        or [
            {"kind": "specialist", "id": "research", "title": "Research",
             "specialist": "cso", "goal": "Analyze {topic}."},
            {"kind": "approval_gate", "id": "gate", "title": "Approve",
             "person_id": 7, "question": "OK to proceed on {topic}?"},
            {"kind": "specialist", "id": "plan", "title": "Plan",
             "specialist": "coo", "goal": "Plan for {topic}."},
            {"kind": "synthesis", "id": "assemble", "title": "Assemble"},
        ],
    }
    base.update(overrides)
    return DynamicWorkflowDef.model_validate(base)


def _route(calls: list[dict[str, Any]], monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_route(**kwargs: Any) -> str:
        calls.append(kwargs)
        return f"output for {kwargs.get('specialist_name')}"

    monkeypatch.setattr(dyn, "route_to_specialist", fake_route)


def _state(**overrides: Any) -> WorkflowResumeState:
    base: dict[str, Any] = {
        "workflow_name": "weekly_watch",
        "gate_step_id": "gate",
        "gate_step_index": 1,
        "next_step_index": 2,
        "outputs": {"research": ("Research", "the research output")},
    }
    base.update(overrides)
    return WorkflowResumeState.model_validate(base)


def _resolution(decision: str = "approve", **overrides: Any) -> WaitForHumanResolution:
    base: dict[str, Any] = {
        "run_id": "r1",
        "reply_text": "yes go ahead",
        "source_channel": "slack",
        "parsed_decision": {"decision": decision, "note": "looks good"},
        "person_id": 7,
        "resolved_at": "2026-09-18T10:00:00+00:00",
    }
    base.update(overrides)
    return WaitForHumanResolution.model_validate(base)


async def _resume(wf: DynamicWorkflow, state: WorkflowResumeState,
                  resolution: WaitForHumanResolution) -> list[Any]:
    inputs = wf.input_model()(topic="pricing")
    return [
        e
        async for e in wf.resume(
            inputs=inputs, state=state, resolution=resolution, store=MagicMock()
        )
    ]


def _artifact(events: list[Any]) -> str:
    for e in events:
        if getattr(e, "type", None) == "artifact":
            return e.content or ""
    return ""


def _errors(events: list[Any]) -> list[str]:
    return [e.message or "" for e in events if getattr(e, "type", None) == "error"]


# ---------------------------------------------------------------------------
# The happy path
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resume_runs_the_steps_after_the_gate(monkeypatch: pytest.MonkeyPatch) -> None:
    """The whole point: the step after the gate executes and an artifact
    appears. Before resume existed, both were silently dropped."""
    calls: list[dict[str, Any]] = []
    _route(calls, monkeypatch)

    events = await _resume(DynamicWorkflow(_def()), _state(), _resolution())

    # Only the post-gate specialist runs — the pre-gate one is NOT re-paid for.
    assert [c["specialist_name"] for c in calls] == ["coo"]
    artifact = _artifact(events)
    assert artifact, "resume must produce the artifact the paused run never reached"
    assert "the research output" in artifact, "pre-gate work must survive the pause"
    assert "output for coo" in artifact


@pytest.mark.asyncio
async def test_resume_records_the_decision_in_the_artifact(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The gate is a step, so it gets an output like any other — which is how
    the decision reaches the artifact instead of only a database column."""
    _route([], monkeypatch)
    artifact = _artifact(await _resume(DynamicWorkflow(_def()), _state(), _resolution()))
    assert "Approved" in artifact
    assert "looks good" in artifact
    assert "person 7" in artifact and "slack" in artifact


@pytest.mark.asyncio
async def test_resume_closes_the_gate_step_for_the_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The original run emitted `step_start` for the gate and never closed it;
    a re-attached client would show it running forever."""
    _route([], monkeypatch)
    events = await _resume(DynamicWorkflow(_def()), _state(), _resolution())
    done = [e.step_id for e in events if getattr(e, "type", None) == "step_done"]
    assert "gate" in done
    assert done[0] == "context", "resume reloads context first, like a fresh run"


@pytest.mark.asyncio
async def test_synthesis_sees_the_decision(monkeypatch: pytest.MonkeyPatch) -> None:
    """A synthesis step with instructions consults a specialist over the
    drafts; the human's answer must be among them, or the artifact can
    contradict the sign-off it was gated on."""
    calls: list[dict[str, Any]] = []
    _route(calls, monkeypatch)
    defn = _def(steps=[
        {"kind": "specialist", "id": "research", "title": "Research",
         "specialist": "cso", "goal": "Analyze {topic}."},
        {"kind": "approval_gate", "id": "gate", "title": "Approve",
         "person_id": 7, "question": "OK?"},
        {"kind": "synthesis", "id": "assemble", "title": "Assemble",
         "instructions": "Write it up.", "specialist": "cso"},
    ])
    await _resume(DynamicWorkflow(defn), _state(next_step_index=2), _resolution())
    assert any("Approved" in str(c.get("query", "")) for c in calls)


@pytest.mark.asyncio
async def test_auto_proceed_is_labelled_as_unanswered(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A timeout auto-approval must not read as a human saying yes."""
    _route([], monkeypatch)
    resolution = _resolution(
        "auto_proceed",
        source_channel="system",
        parsed_decision={"decision": "auto_proceed", "note": "timeout"},
    )
    artifact = _artifact(await _resume(DynamicWorkflow(_def()), _state(), resolution))
    assert "No human reply" in artifact


# ---------------------------------------------------------------------------
# Declining
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("decision", ["reject", "defer"])
@pytest.mark.asyncio
async def test_a_decline_stops_the_run(
    decision: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Everything after a sign-off exists to act on a yes. Producing the
    deliverable anyway would hand back the thing they just declined."""
    calls: list[dict[str, Any]] = []
    _route(calls, monkeypatch)

    events = await _resume(
        DynamicWorkflow(_def()),
        _state(),
        _resolution(decision, parsed_decision={"decision": decision, "note": "too risky"}),
    )

    assert calls == [], "no further specialist may be paid for after a decline"
    assert _artifact(events) == ""
    assert _errors(events), "the run must fail, not end silently"
    assert "too risky" in _errors(events)[0]


# ---------------------------------------------------------------------------
# Refusing to resume
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_resume_refuses_when_the_gate_moved(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`upsert_definition` overwrites by name, so a definition edited during
    the pause can re-point the stored index at a different step. Resuming
    anyway would skip or repeat work and produce a plausible wrong artifact."""
    calls: list[dict[str, Any]] = []
    _route(calls, monkeypatch)
    # A step inserted before the gate shifts it from index 1 to index 2.
    edited = _def(steps=[
        {"kind": "specialist", "id": "research", "title": "Research",
         "specialist": "cso", "goal": "Analyze {topic}."},
        {"kind": "specialist", "id": "inserted", "title": "Inserted",
         "specialist": "cfo", "goal": "Cost {topic}."},
        {"kind": "approval_gate", "id": "gate", "title": "Approve",
         "person_id": 7, "question": "OK?"},
        {"kind": "synthesis", "id": "assemble", "title": "Assemble"},
    ])

    events = await _resume(DynamicWorkflow(edited), _state(), _resolution())

    assert calls == []
    assert _artifact(events) == ""
    assert "definition changed" in _errors(events)[0]


@pytest.mark.asyncio
async def test_resume_refuses_an_index_pointing_at_a_non_gate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The index can still be in range and still be wrong."""
    _route([], monkeypatch)
    events = await _resume(
        DynamicWorkflow(_def()), _state(gate_step_index=0, gate_step_id="research"),
        _resolution(),
    )
    assert "definition changed" in _errors(events)[0]


@pytest.mark.asyncio
async def test_resume_refuses_an_out_of_range_index(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _route([], monkeypatch)
    events = await _resume(DynamicWorkflow(_def()), _state(gate_step_index=99), _resolution())
    assert "definition changed" in _errors(events)[0]


@pytest.mark.asyncio
async def test_resume_refuses_a_payload_for_another_workflow(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _route([], monkeypatch)
    events = await _resume(
        DynamicWorkflow(_def()), _state(workflow_name="something_else"), _resolution()
    )
    assert "definition changed" in _errors(events)[0]


@pytest.mark.asyncio
async def test_resume_refuses_a_payload_from_another_engine(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`engine` exists so a future non-dynamic payload is rejected rather than
    interpreted as step indices into a definition it never described."""
    _route([], monkeypatch)
    events = await _resume(DynamicWorkflow(_def()), _state(engine="something_new"), _resolution())
    assert "definition changed" in _errors(events)[0]


@pytest.mark.asyncio
async def test_resume_reruns_the_stale_specialist_preflight(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A specialist can be removed while the run sits at the gate. Finishing
    with 'Unknown specialist: …' as a section is worse than failing."""
    calls: list[dict[str, Any]] = []
    _route(calls, monkeypatch)
    monkeypatch.setattr(dyn, "SPECIALIST_REGISTRY", {"cso": object()})

    events = await _resume(DynamicWorkflow(_def()), _state(), _resolution())

    assert calls == []
    assert "no longer exists" in _errors(events)[0]


# ---------------------------------------------------------------------------
# Two gates
# ---------------------------------------------------------------------------

@pytest.mark.asyncio
async def test_a_second_gate_pauses_again_with_a_fresh_payload(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """`run()` and `resume()` share one step loop, so a later gate needs no
    special handling — it raises an identical pause, carrying everything
    accumulated across BOTH legs of the run."""
    _route([], monkeypatch)
    defn = _def(steps=[
        {"kind": "specialist", "id": "research", "title": "Research",
         "specialist": "cso", "goal": "Analyze {topic}."},
        {"kind": "approval_gate", "id": "gate", "title": "Approve",
         "person_id": 7, "question": "OK?"},
        {"kind": "specialist", "id": "plan", "title": "Plan",
         "specialist": "coo", "goal": "Plan {topic}."},
        {"kind": "approval_gate", "id": "gate2", "title": "Final sign-off",
         "person_id": 7, "question": "Ship it?"},
        {"kind": "synthesis", "id": "assemble", "title": "Assemble"},
    ])

    events = await _resume(DynamicWorkflow(defn), _state(), _resolution())

    gates = [e for e in events if isinstance(e, WaitForHumanEvent)]
    assert len(gates) == 1
    assert gates[0].question == "Ship it?"
    second = gates[0].resume_state
    assert second is not None
    assert second.gate_step_id == "gate2"
    assert second.gate_step_index == 3
    assert second.next_step_index == 4
    # Everything so far: the pre-gate step, the recorded decision, and the
    # step the resumed leg just ran.
    assert set(second.outputs) == {"research", "gate", "plan"}
    assert _artifact(events) == ""


# ---------------------------------------------------------------------------
# state_json shape
# ---------------------------------------------------------------------------

def test_resume_state_never_reaches_state_json() -> None:
    """`state_json` is what the inbound resolver reads, and it branches on
    which keys are PRESENT. The payload is excluded at the field level so no
    serialization site can leak it by forgetting to."""
    bare = WaitForHumanEvent(person_id=1, question="q")
    loaded = WaitForHumanEvent(person_id=1, question="q", resume_state=_state())
    assert loaded.model_dump_json() == bare.model_dump_json()
    assert "resume_state" not in loaded.model_dump()

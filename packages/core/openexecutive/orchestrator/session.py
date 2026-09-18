from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from openexecutive.memory.company_profile import CompanyProfile


@dataclass
class Session:
    session_id: str = field(default_factory=lambda: str(uuid.uuid4()))
    company_profile: CompanyProfile | None = None
    conversation_history: list[dict[str, Any]] = field(default_factory=list)
    created_at: datetime = field(default_factory=datetime.utcnow)
    # (channel, channel_ref) pairs the Executive has seen during this session.
    # Used by schedule_followup to refuse scheduling sends to refs the user
    # never actually used — anti-spam guard.
    seen_channel_refs: set[tuple[str, str]] = field(default_factory=set)
    # Which inbound chat channel this session arrived on ("slack", "discord",
    # "telegram", "google_chat"), and the address on it. Empty for web/CLI
    # turns. Used when a workflow raises an approval gate mid-conversation:
    # the gate records where to look for the answer, so a reply on this
    # channel can resolve it. Inbound vocabulary — see `normalize_channel`.
    origin_channel: str = ""
    origin_channel_ref: str = ""
    # The rostered Person behind this conversation, when one is resolved. The
    # adapters already pass this to `Executive.chat(person_id=...)`; holding it
    # on the session too lets tool handlers running mid-turn tell "the approver
    # is the person I'm already talking to" from "the approver is someone else".
    caller_person_id: int | None = None

    def add_user_message(self, content: str) -> None:
        self.conversation_history.append({"role": "user", "content": content})

    def add_assistant_message(self, content: str | list[dict[str, Any]]) -> None:
        self.conversation_history.append({"role": "assistant", "content": content})

    def get_recent_history(self, max_turns: int = 20) -> list[dict[str, Any]]:
        history = self.conversation_history[-(max_turns * 2):]
        # Anthropic requires messages to start with a user turn.
        # Drop a leading assistant message if history length is odd (can happen on error recovery).
        if history and history[0]["role"] != "user":
            history = history[1:]
        return history

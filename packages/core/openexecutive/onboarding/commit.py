"""Persisting a reviewed onboarding draft.

Everything here runs AFTER the user has read and edited the draft, and after
``profile.save_to_yaml`` has already succeeded. Each step is best-effort: a
failure to seed people or reconcile departments must never leave the user
without the profile they just saved.

The department step is deliberately **additive**, and that is the one place
this module must not copy ``cli/fixture_loader._seed_departments``. That
seeder DELETEs every department and goal before inserting, which is correct
when swapping in a demo company and destructive here: it would drop the eight
defaults seeded by ``departments.store.seed_default_departments`` along with
their ``specialist_key`` wiring, and ``create_department`` always writes
``specialist_key = NULL`` — so a wiped default can never be recreated
properly. We match drafted departments onto existing ones and create only
what is genuinely new.
"""
from __future__ import annotations

import logging
from typing import TYPE_CHECKING

from openexecutive.utils.slug import DEPARTMENT_SLUG_FALLBACK, slugify

if TYPE_CHECKING:  # pragma: no cover - typing only
    from openexecutive.memory.company_profile import CompanyProfile
    from openexecutive.onboarding.interview import DepartmentDraft, PersonDraft

logger = logging.getLogger(__name__)


def save_onboarding_people(drafts: list[PersonDraft]) -> dict[str, int]:
    """Upsert the drafted roster and return ``{full_name: person_id}``.

    Genuinely an upsert: drafts are matched to existing rows by
    case-insensitive ``full_name`` and UPDATEd in place. That matters because
    re-running setup is a supported flow — a plain insert would duplicate
    every person, and ``find_principal_person`` tie-breaks on ``ORDER BY id``,
    so the STALE principal would keep winning caller resolution, alert routing
    and the scheduler's brief (its own docstring warns about exactly this).

    Contact columns are carried across on update. ``upsert_person``'s UPDATE
    branch writes every column, so omitting them would silently wipe the
    Slack / email / Telegram handles the user added on the People page.

    Anyone who was principal and is not the drafted principal is demoted and
    loses WILDCARD (only WILDCARD — other scopes they were granted stay).

    Best-effort: returns ``{}`` on failure and logs the exception TYPE only,
    because the traceback would carry the roster's names into the log stream.
    """
    try:
        from openexecutive.people.models import AuthorityScope
        from openexecutive.people.store import (
            initialize_db as init_people_db,
        )
        from openexecutive.people.store import (
            list_people,
            set_authority_scope,
            upsert_person,
        )

        named = [d for d in drafts if d.full_name.strip()]
        if not named:
            return {}

        init_people_db()
        existing = {p.full_name.strip().lower(): p for p in list_people()}

        ids: dict[str, int] = {}
        for draft in named:
            name = draft.full_name.strip()
            prior = existing.get(name.lower())
            if prior is None:
                pid = upsert_person(
                    full_name=name,
                    role=draft.role.strip(),
                    is_principal=draft.is_principal,
                )
            else:
                pid = upsert_person(
                    person_id=prior.id,
                    full_name=name,
                    # An empty drafted role means "not mentioned", not "clear it".
                    role=draft.role.strip() or prior.role,
                    is_principal=draft.is_principal,
                    # Carried across so the UPDATE does not null them out.
                    department_slugs=prior.department_slugs,
                    email=prior.email,
                    slack_user_id=prior.slack_user_id,
                    telegram_chat_id=prior.telegram_chat_id,
                    discord_user_id=prior.discord_user_id,
                    preferred_channel=prior.preferred_channel,
                    response_sla_hours=prior.response_sla_hours,
                    on_leave_until=prior.on_leave_until,
                    reports_to_person_id=prior.reports_to_person_id,
                )
            ids[name] = pid
            if draft.is_principal:
                set_authority_scope(pid, [AuthorityScope.WILDCARD])

        _demote_stale_principals(set(ids.values()))
        return ids
    except Exception as exc:
        logger.warning(
            "save_onboarding_people failed (%s) — skipping people creation",
            type(exc).__name__,
        )
        return {}


def _demote_stale_principals(keep_ids: set[int]) -> None:
    """Strip is_principal + WILDCARD from anyone outside the new roster.

    Without this, re-running setup leaves the previous founder flagged as
    principal with blanket approval authority, and ``find_principal_person``
    (oldest id wins) keeps resolving to them.
    """
    from openexecutive.people.models import AuthorityScope
    from openexecutive.people.store import (
        list_people,
        set_authority_scope,
        upsert_person,
    )

    for person in list_people():
        if not person.is_principal or person.id is None or person.id in keep_ids:
            continue
        upsert_person(
            person_id=person.id,
            full_name=person.full_name,
            role=person.role,
            is_principal=False,
            department_slugs=person.department_slugs,
            email=person.email,
            slack_user_id=person.slack_user_id,
            telegram_chat_id=person.telegram_chat_id,
            discord_user_id=person.discord_user_id,
            preferred_channel=person.preferred_channel,
            response_sla_hours=person.response_sla_hours,
            on_leave_until=person.on_leave_until,
            reports_to_person_id=person.reports_to_person_id,
        )
        remaining: list[AuthorityScope] = [
            s for s in person.authority_scope if s != AuthorityScope.WILDCARD
        ]
        if remaining != person.authority_scope:
            set_authority_scope(person.id, remaining)


def reconcile_onboarding_departments(
    drafts: list[DepartmentDraft],
    person_ids: dict[str, int],
) -> dict[str, int]:
    """Additively apply the drafted departments. Returns ``{updated, created}``.

    A drafted department matches an existing one by slug or case-insensitive
    title; a match is UPDATED in place (preserving its ``specialist_key`` and
    goals), anything unmatched is CREATED. Nothing is ever deleted — a
    department the user did not mention is left exactly as it was.
    """
    counts = {"updated": 0, "created": 0}
    try:
        from openexecutive.departments.models import DepartmentCharter
        from openexecutive.departments.store import (
            create_department,
            list_departments,
            update_department,
        )
        from openexecutive.departments.store import (
            initialize_db as init_departments_db,
        )

        named = [d for d in drafts if d.title.strip()]
        if not named:
            return counts

        init_departments_db()
        existing = list_departments()
        by_slug = {d.config.slug: d.config for d in existing}
        by_title = {d.config.title.strip().lower(): d.config for d in existing}
        # Two drafted titles can collide with each other as well as with an
        # existing row ("Growth" and "growth"). Without this the second one
        # would either create a `growth-2` row or silently overwrite the first
        # one's mission while the counts claimed two updates.
        seen: set[str] = set()

        for draft in named:
            title = draft.title.strip()
            # Same fallback the store uses, so the slug we look up is the one
            # create_department would have assigned.
            drafted_slug = slugify(title, fallback=DEPARTMENT_SLUG_FALLBACK)
            if drafted_slug in seen:
                logger.info(
                    "onboarding: skipping a department title that collides with "
                    "an earlier one in the same draft"
                )
                continue
            seen.add(drafted_slug)

            match = by_slug.get(drafted_slug) or by_title.get(title.lower())
            head_id = person_ids.get(draft.head_person_name.strip()) if draft.head_person_name else None

            if match is None:
                created = create_department(title, mission=draft.mission.strip())
                counts["created"] += 1
                slug = created.config.slug
                # Register it so a later draft in this same batch matches the
                # row we just made instead of creating a `-2` duplicate.
                by_slug[slug] = created.config
                by_title[created.config.title.strip().lower()] = created.config
                seen.add(slug)
                # create_department fixes authority to propose_only and takes no
                # head, so apply the drafted values in a second call.
                update_department(slug, authority_level=draft.authority_level)
                if head_id is not None:
                    update_department(slug, head_person_id=head_id)
                continue

            # Keep the existing charter's scope/out_of_scope — the interview
            # never asks about them, so an empty draft must not erase them.
            charter = DepartmentCharter(
                mission=draft.mission.strip() or match.charter.mission,
                scope=list(match.charter.scope),
                out_of_scope=list(match.charter.out_of_scope),
            )
            update_department(
                match.slug,
                charter=charter,
                authority_level=draft.authority_level,
            )
            # Passed separately: update_department treats an explicit None as
            # "clear the head", and a draft with no named head must leave an
            # existing head alone.
            if head_id is not None:
                update_department(match.slug, head_person_id=head_id)
            counts["updated"] += 1

        return counts
    except Exception as exc:
        # Do NOT claim "unchanged": each department is its own transaction, so
        # a failure partway through leaves the earlier ones committed.
        logger.warning(
            "reconcile_onboarding_departments failed (%s) after %d update(s) "
            "and %d creation(s)",
            type(exc).__name__,
            counts["updated"],
            counts["created"],
        )
        return counts
    finally:
        # Must run even on the partial-failure path above, or the registry
        # serves a stale department list until its TTL lapses.
        if counts["updated"] or counts["created"]:
            try:
                from openexecutive.departments.registry import invalidate

                invalidate()
            except Exception:
                logger.warning("onboarding: department registry invalidate failed")


def derive_org_structure(
    profile: CompanyProfile,
    people: list[PersonDraft],
    departments: list[DepartmentDraft],
) -> CompanyProfile:
    """Fill ``profile.org_structure`` from the people and department drafts.

    The onboarding review screen hides the Org Structure section precisely so
    this stays a derived value — otherwise the user would have two places to
    edit the same list and they would silently diverge.
    """
    titles = [d.title.strip() for d in departments if d.title.strip()]
    leadership = [
        f"{p.full_name.strip()}, {p.role.strip()}" if p.role.strip() else p.full_name.strip()
        for p in people
        if p.full_name.strip()
    ]
    org = profile.org_structure.model_copy(
        update={"departments": titles, "leadership_team": leadership}
    )
    return profile.model_copy(update={"org_structure": org})

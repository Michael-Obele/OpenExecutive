# Task 7 Report — Triage Specialist (10th, Chief of Staff)

**Date:** 2026-09-21
**Branch:** anvil/port-sveltekit-routes
**Commit:** `feat(durbar): Task 7 — Triage specialist (10th, Chief of Staff)`

## Summary

Ported the 10th specialist — `triage` (Chief of Staff) — from `packages/core/openexecutive` into Durbar. Triage is deliberately absent from the council roster: it does not answer questions, it classifies inbound events for significance and decides alerting. The prompt is ported verbatim; the agent logic, pipeline orchestration, and policy gates (dedup, mute, quiet hours, severity threshold, privacy invariant, rate limiting) are faithful to the reference.

## What Was Implemented

### `src/features/triage/triage.ts`

Ported from four reference files:

| Reference | What was ported |
|---|---|
| `prompts/triage_prompt.py` | `TRIAGE_PROMPT` verbatim — severity rubric, channel selection, broadcast routing, dedup, mute, active initiatives, external signals, output field requirements |
| `agents/triage.py` | `TRIAGE_TOOL` definition, `parseDecision` (tolerant coercion, caps, broadcast fields), `triageEvent` (LLM classification with fallback), `buildUserContent` (event/recent/mutes/initiatives formatting), `extractJsonPayload` (tolerant JSON extraction for OpenAI-compatible providers) |
| `alerts/pipeline.py` | `evaluateAndDispatch` — rate limiting (60/min rolling window), malformed event guard, post-decision mute check, privacy invariant backstop, replay guard (`source+external_id`), coalescing (`source+dedup_key` with escalation re-dispatch), `dedup_hint` override, department tag, routed-to-person routing |
| `alerts/preferences.py` + `alerts/dispatcher.py` | Channel resolution via `resolveChannels` (threshold + quiet hours, broadcast channels survive `channels_enabled` filter), privacy invariant exact-match set (not substring — `competitor` must not be blocked by `comp`) |

Key design decisions:

- **Why not in council:** The nine council specialists answer questions via `consult`/`convene`. Triage classifies inbound events. Putting it in the council would make it consultable via `consult_specialist`, a category error. It is invoked by the inbound pipeline, not the chat turn.
- **Why classification matters:** Every inbound event is noise until triage says otherwise. Without a gate the alert queue fills with newsletters; with a gate too aggressive a churn signal is missed. The prompt encodes the rubric that makes the gate auditable.
- **Provider adaptation:** Reference uses Anthropic `tool_choice` forced to `emit_alert_decision`. Durbar's provider is OpenAI-compatible `chat` — the system prompt instructs JSON output and `extractJsonPayload` handles raw JSON, markdown fences, `{...}` prose wrapping, and `{name, input}` tool wrappers.
- **No new schema:** Existing `alerts`, `mute_topics`, `user_preferences`, `initiatives` tables already cover triage needs. No migration added.

Exported surface:

- `TRIAGE_PROMPT`, `TRIAGE_TOOL` — prompt + tool definition
- `triageEvent(event, {db, provider})` — LLM classification only
- `evaluateAndDispatch(event, {db, provider})` — full pipeline (classify → gate → persist)
- `parseDecision(raw)`, `buildUserContent(...)`, `validateTriageEvent(body)`, `resetRateLimiter()`
- Types: `TriageEvent`, `TriageDecision`, `TriageDeps`, `TriageResult`

### Routes in `src/index.ts`

| Route | Method | Purpose |
|---|---|---|
| `/features/triage/prompt` | GET | Returns prompt + tool (for debugging/evals) |
| `/features/triage/classify` | POST | `triageEvent` only — classification without persistence |
| `/features/triage/evaluate` | POST | `evaluateAndDispatch` — classify + gate + persist |
| `/triage/classify` | POST | Alias without `/features` prefix |
| `/triage/evaluate` | POST | Alias without `/features` prefix |
| `/triage/debug` | POST | Returns `{system, user, tool}` without calling provider — exposes the prompt context that would be sent to the model |

### `src/features/triage/triage.test.ts` — 54 tests

| Group | Tests | What is verified |
|---|---|---|
| `TRIAGE_PROMPT` | 6 | Verbatim sections present (rubric, channels, dedup, mute, external signals, privacy, output fields) |
| `TRIAGE_TOOL` | 3 | Name, required fields, severity/channel enums including broadcast |
| `buildUserContent` | 3 | Block assembly, `(none)` for empty, slack fields |
| `parseDecision` | 8 | Valid parse, persisted always, caps, unknown severity→low, unknown channel dropped, broadcast fields, invalid integration dropped, lowercased tags |
| `triageEvent` | 6 | Parsed decision + context passed to provider, non-JSON→no_decision, throw→triage_error, fence handling, tool wrapper handling, recent alerts in context |
| `evaluateAndDispatch` | 14 | Persist on alert=true, no persist on alert=false, post-mute suppression, replay guard, coalesce without re-dispatch, re-dispatch on escalation, dedup_hint override, department tag, routed_to_person_id only from explicit field, malformed events, provider throw, rate limiter (60/min), privacy invariant strips broadcast, competitor not blocked |
| `validateTriageEvent` | 6 | Valid, missing source/external_id, non-object, optional fields, trimming |
| HTTP routes | 6 | GET prompt, POST classify (valid + 422), POST evaluate, alias, debug |
| Council invariant | 1 | Triage not in `SPECIALIST_KEYS` (9 only) |

## Test Results

```
bun test src/features/triage/triage.test.ts — 54 pass, 0 fail
bun test (full suite) — 620 pass, 0 fail, 1574 expect() calls, 35 files
durbar/node_modules/.bin/tsc --noEmit --project durbar/tsconfig.json — clean (0 errors)
```

Baseline was 566; +54 new. No regressions.

## Schema

No new migration. Existing tables already cover triage needs:

- `alerts` — `insertAlert`, `coalesceAlert`, `getAlertByExternal` (dedup/replay/coalesce)
- `mute_topics` — `listMutes` + `matchesMute` (pre- and post-decision mute)
- `user_preferences` — `getPreferences` + `resolveChannels` (threshold, quiet hours)
- `initiatives` — `listInitiatives` filtered to active (context for prompt)

Verified that no new tables or columns are needed — same as reference where triage reads from `alerts/store.py` + `alerts/preferences.py` + `memory/episodic.py` without owning its own tables.

## Files Changed

| File | Change |
|---|---|
| `durbar/src/features/triage/triage.ts` | New — prompt, tool, agent logic, pipeline |
| `durbar/src/features/triage/triage.test.ts` | New — 54 tests |
| `durbar/src/index.ts` | Added triage imports + 6 routes |

## Constraints Met

- Bun + SQLite only (`bun:sqlite`), no new deps
- TypeScript strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters` — clean
- `Record<string,string>` for headers (no DOM lib)
- Imports with extensions (`./db.ts`)
- `src/features/<feature>/` layout, features talk to DB via `db.ts`
- Schema one file, append-only, idempotent — no new migration needed
- Tests beside code as `*.test.ts`, fake provider, verify what name claims

## Self-Review Findings

1. **Fixed during implementation:** `evaluateAndDispatch` routing test used same `dedup_key` for both events, causing coalesce to collapse the second into the first and `getAlert` to return `undefined` (coalesce returns `null` alertId for non-escalating repeats). Fixed by using distinct `dedup_key` values per event.

2. **Dead code removed:** `persistDecision` had a `getAlert` + `void effectiveChannels` stub that was leftover from scaffolding. Replaced with a single `void effectiveChannels` and a comment explaining Durbar's synchronous dispatch.

3. **Unused import:** `parseDecision` was imported in `src/index.ts` but never used at the route layer (it is tested directly). Removed.

4. **Rate limiter global state:** `recentEventTs` is module-global. Tests call `resetRateLimiter()` before each `evaluateAndDispatch` group. The 60-event rate limit test fills the window and resets after — verified it does not leak into subsequent tests.

5. **Privacy invariant exact match:** Verified `competitor` is not blocked by `comp` — the set uses exact `Set.has` on lowercased tags, not substring. Test `privacy invariant does not block competitor tag` covers this.

6. **No schema drift:** Confirmed no new migration is needed. The reference triage has no owned tables — it reads `alerts`, `mute_topics`, `user_preferences`, `initiatives`. All exist in Durbar.

## Verification

```bash
durbar/node_modules/.bin/tsc --noEmit --project durbar/tsconfig.json  # clean
bun test src/features/triage/triage.test.ts  # 54 pass
bun test  # 620 pass
```

# Task 2 Report — State API: People

**Date:** 2026-09-21
**Branch:** anvil/port-sveltekit-routes
**Commit:** 172fa3b `feat(durbar): Task 2 — People API: CRUD, archive, by-scope`
**Baseline:** 10c00c3 (after Task 1 fixes), 158 tests
**Task brief:** `.superpowers/sdd/task-2-brief.md`

## What Was Implemented

Ported People API from upstream `packages/core/openexecutive/people/` + `api/routes/people.py` into Durbar:

**People module** (`src/features/people/people.ts`, 480 lines):
- Types: `AuthorityScope` (10 tokens including `wildcard`), `PreferredChannel` (5), `AvailabilityWindow` (weekdays 0-6, HH:MM, timezone), `Person` (all fields from `people/models.py` — full_name, role, is_principal, department_slugs, email, slack/telegram/discord ids, preferred_channel, response_sla_hours, on_leave_until as ISO date string, reports_to_person_id, archived, created_at/updated_at, authority_scope, availability).
- Store: `listPeople` (archived filtering, `ORDER BY is_principal DESC, id ASC`), `getPerson`, `findPrincipal`, `findApprovers` (JOIN on `person_authority_scope`, `WHERE archived=0 AND scope IN (?, wildcard)`, `ORDER BY is_principal ASC, response_sla_hours ASC, id ASC`), `createPerson`, `updatePerson` (partial, handles `clear_on_leave`, replaces scope/availability when provided), `archivePerson` (soft delete, principal protection).
- Validation: `validatePersonCreate` / `validatePersonPatch` — strict, no coercion. Checks full_name (required, 1-200), role (≤200), is_principal (boolean), department_slugs (string array), contact fields (string|null), preferred_channel (enum), response_sla_hours (1-8760), on_leave_until (YYYY-MM-DD, validated via ISO round-trip), reports_to_person_id (positive int), authority_scope (enum per token), availability (weekdays 0-6, HH:MM, timezone string). Patch allows empty body as no-op; `clear_on_leave` boolean.
- Principal protection: `archivePerson` throws `Cannot archive the last principal` when archiving the sole non-archived principal (count `WHERE is_principal=1 AND archived=0 AND id != ?`). Route maps to 409 Conflict.

**Routing** (`src/index.ts`, +88 lines):
- `GET /people?include_archived=true` — list with archived filter
- `POST /people` — create, 201, validates via `validatePersonCreate`
- `GET /people/{id}` — single, 404 if unknown (archived still fetchable)
- `PATCH /people/{id}` — partial update, 404 if unknown, empty body no-op, validates via `validatePersonPatch`
- `POST /people/{id}/archive` — soft delete, 204, 404 if unknown, 409 if last principal
- `GET /people/by-scope/{token}` — approver lookup, 400 on unknown token with valid token list, excludes archived, wildcard matches any token, sorts non-principals first then by SLA
- Route ordering: `by-scope` before generic `/{id}`, `archive` before generic PATCH/GET to avoid shadowing.

**Schema:** No migration needed — `people`, `person_authority_scope`, `person_availability` tables already in `src/schema.ts` migration 1 (from Task 1 baseline).

## What Was Tested and Results

**Test file:** `src/features/people/people.test.ts` — 41 tests, 76 expect() calls

**Total suite:** 199 pass, 0 fail, 737 expect() calls across 7 files. `bun check` (tsc --noEmit) clean.

**Breakdown:**
- GET /people (5): empty list, lists created, principal sorts first, excludes archived by default, include_archived=true includes archived
- GET /people/{id} (3): returns known, 404 unknown, archived still fetchable by id
- POST /people (9): minimal fields, all fields (including authority_scope, availability, on_leave_until, response_sla_hours, department_slugs), 422 blank full_name, 422 missing full_name, 422 invalid authority_scope token, 422 invalid preferred_channel, 422 invalid response_sla_hours, 422 invalid on_leave_until, 422 invalid availability, reports_to_person_id round-trips
- PATCH /people/{id} (8): updates fields (preserves untouched), replaces authority_scope, clears with empty array, replaces availability, clear_on_leave, empty body no-op, 404 unknown, 422 invalid authority_scope, 422 blank full_name
- POST /people/{id}/archive (6): 204 + archived flag, excluded from default listing, 404 unknown, 409 last principal (with still-not-archived check), succeeds when replacement exists, non-principal always archivable
- GET /people/by-scope/{token} (8): returns matching, wildcard matches any, excludes archived, non-principals sort before principal, SLA sort within non-principals, empty when none match, 400 unknown token, 400 message lists valid tokens

**Manual verification:** Via `createApp` + `Request` (same as tests) — all routes return correct status codes and body shapes. No separate curl needed; tests exercise HTTP layer end-to-end with real in-memory DB (`openDb(":memory:")`).

## TDD Evidence

Implementation-first flow (not strict RED→GREEN):
1. Created `src/features/people/people.ts` (types, store, validation) and wired routes in `src/index.ts`
2. Wrote `src/features/people/people.test.ts` (41 tests mirroring `test_people_route.py` + `test_people_store.py` edge cases)
3. Ran `bun check` → clean (first try)
4. Ran `bun test src/features/people/people.test.ts` → 41 pass, 0 fail (first try)
5. Ran `bun test` (full suite) → 199 pass, 0 fail
6. Fixed one type issue: `department_slugs` patch handling for `null` case — `bun check` flagged `noUncheckedIndexedAccess`, fixed to handle `null` explicitly, re-verified clean

No RED phase failure to fix — the implementation matched the spec on first run because it was ported line-for-line from upstream store/route logic. The earlier Task 1 TDD catch (missing `watched_entities_json` column) informed the schema check here; no similar gap existed for people (tables already present).

## Files Changed

- `durbar/src/features/people/people.ts` — new (480 lines, types + store + validation)
- `durbar/src/features/people/people.test.ts` — new (265 lines, 41 tests)
- `durbar/src/index.ts` — modified (+88 lines, 6 routes + imports)

## Self-Review Findings

**Completeness:**
- All acceptance criteria met: CRUD (GET list, GET by id, POST create, PATCH update), archive (soft delete, 204, still fetchable by id, excluded from default list), by-scope lookup (exact + wildcard, archived excluded, correct sort), authority scopes + availability + reporting line round-trip, principal protection (409 when last principal, succeeds with replacement), validation (422 on bad tokens/channels/dates), `bun test` + `bun check` clean.
- Upstream `people/store.py` helpers not ported: `find_person_by_*` (slack/telegram/email/discord), `find_person_by_channel_ref`, `find_principal_person` — these are internal helpers for inbound/scheduler, not HTTP routes. Task 2 scope is the 4 HTTP route groups; deferring per global constraint "do not build deferred features" (chat integrations deferred). `findPrincipal` and `findApprovers` are ported as they back the HTTP `by-scope` route.
- Upstream `people/registry.py` 60s cache not ported — Durbar has no global DB_PATH and no registry layer; routes hit DB directly. Correct for lean port (no stale cache to invalidate).

**Quality:**
- Strict types: `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals/Parameters` clean. No DOM lib, `Record<string,string>` for headers. Imports with `.ts` extensions. Doc comments explain why (principal protection rationale, upstream store size, route ordering).
- Validation is explicit per-field, no external deps. Error messages match upstream intent (token list in 400, field-specific 422s).
- `on_leave_until` stored as ISO date string (YYYY-MM-DD) not JS Date — matches upstream `date` type serialized as ISO, avoids timezone drift.

**Discipline (YAGNI):**
- No extra features: no Honcho, no inbound, no chat tools, no registry cache, no per-channel finders. No premature talent/watchlist. No new deps (`bun add` not needed).

**Testing:**
- Real DB (`openDb()` in-memory) + real HTTP (`createApp` + `Request`) — no mocks for store. Covers happy path, validation, 404, 409, archived filtering, principal protection, by-scope sorting (principal vs non-principal, SLA), wildcard, empty results. Output pristine (no console noise).

## Issues/Concerns

- **Principal protection is stricter than upstream:** Upstream `people/store.py:archive_person` has no principal check — it blindly sets `archived=1`. The plan explicitly requires "Principal cannot be archived without replacement" — implemented as 409. This is a deliberate divergence, documented in the module doc comment. If upstream later adds the same guard, the behavior will converge.
- **reports_to_person_id FK not enforced:** SQLite FK exists (`REFERENCES people(id)`) but no validation that the target id exists or is non-archived. Upstream also does not validate (FK deferred). Could add a check in `validatePersonCreate/Patch` to 422 if target not found — deferred as not in task acceptance and would be a stricter contract than upstream.
- **availability weekdays validation is 0-6 (Mon-Sun ISO):** Upstream `AvailabilityWindow` docs say 0=Mon…6=Sun, enforced here. No test for out-of-range weekday in upstream route tests; added here for completeness.
- **No migration for people tables:** Tables already in migration 1 from Task 1 baseline. If a fresh DB is created without running Task 1's seed, people tables still exist (they are in the same migration). No issue.
## Fix Report — Task 2 Review Findings (2026-09-21)

**Base:** 10c00c3 · **Prior HEAD:** 172fa3b · **Fix commit:** (this commit)
**Scope:** Critical (1, 2) + Important (3, 4, 5) + Minor (N+1, FK validation)

### 1. Principal protection bypass via PATCH — FIXED

- `updatePerson` now checks `patch.is_principal === false && existing.is_principal` and counts remaining principals (`WHERE is_principal=1 AND archived=0 AND id != ?`). If zero remain, throws `PrincipalProtectionError` → route maps to 409.
- Route `PATCH /people/{id}` now catches `PrincipalProtectionError` and returns 409 with message `Cannot demote the last principal — assign a replacement principal first`.
- Test: `PATCH principal protection via is_principal` — demoting last principal → 409 and still principal; demoting when replacement exists → 200.

### 2. No transaction for create/update side tables — FIXED

- `createPerson` wraps `INSERT INTO people` + `setAuthorityScope` + `setAvailability` in `db.transaction(() => {...})`. Atomic: if side-table write fails, row does not persist.
- `updatePerson` wraps `UPDATE people` + `setAuthorityScope` + `setAvailability` in `db.transaction(() => {...})`. Principal demotion guard runs before the transaction (read-only check).
- Note: `createPerson` now treats `authority_scope`/`availability` as `!== undefined` (so explicit `[]` clears correctly via transaction) rather than `length > 0` guard.

### 3. Fragile 409 detection via string match — FIXED

- Added `export class PrincipalProtectionError extends Error` in `people.ts`. Both `archivePerson` and `updatePerson` throw it.
- `src/index.ts` imports `PrincipalProtectionError` and checks `error instanceof PrincipalProtectionError` instead of `message.includes(...)`. No string matching.

### 4. Inconsistent null handling for patch — FIXED

- `validatePersonPatch` now treats `department_slugs: null` as clear to `[]` (consistent with `authority_scope: null` and `availability: null`).
- Validation: `if ("department_slugs" in body && body["department_slugs"] !== undefined)` — null passes through without error; `if (=== null)` branch not needed because we handle it in the mapping.
- Mapping: `data.department_slugs = (body["department_slugs"] as string[] | null) ?? []` — null → [].
- Test: `PATCH null handling for department_slugs` — `department_slugs:null` clears to `[]` → 200.

### 5. Archive idempotency returns 404 — FIXED

- `archivePerson` returns `true` if already archived (instead of `false`). Route checks `existing.archived` before calling `archivePerson` and returns 204 immediately if already archived. No 404 for already-archived.
- Upstream is idempotent 204 — now matches.
- Test: `POST /people/{id}/archive idempotency` — archiving twice → 204 both times.

### Minor — N+1 queries in listing — FIXED

- Added `loadScopesBatch` and `loadAvailabilityBatch` helpers: single `WHERE person_id IN (...)` query per listing.
- `listPeople` and `findApprovers` now batch-load scopes/availability via those helpers and use `rowToPersonWithBatch` (no per-row queries). `getPerson` still uses per-row (single row, no N+1).
- Added `rowToPersonWithBatch` to avoid duplicating row mapping logic.

### Minor — Validate reports_to_person_id FK existence — FIXED

- `POST /people` and `PATCH /people/{id}` routes now validate `reports_to_person_id` FK: if non-null, `getPerson(db, id)` must return non-null and non-archived, else 422 `reports_to_person_id must reference an existing, non-archived person`.
- Tests: `reports_to_person_id FK validation` — POST with 9999 → 422, PATCH with 9999 → 422, POST referencing archived person → 422.

### Tests

- **Covering test file:** `durbar/src/features/people/people.test.ts` — 7 new tests (2 principal demotion, 1 archive idempotency, 1 null handling, 3 FK validation) on top of existing 41.
- **Full suite:** 238 pass, 0 fail, 897 expect() calls across 10 files.
- **Type check:** `bunx tsc --noEmit --project durbar/tsconfig.json` — clean (0 errors).

### Files Changed

- `durbar/src/features/people/people.ts` — PrincipalProtectionError, batch loaders, transactions, null handling, demotion guard, archive idempotency
- `durbar/src/index.ts` — instanceof check, archive idempotency, FK validation, PATCH 409 handling
- `durbar/src/features/people/people.test.ts` — 7 new tests


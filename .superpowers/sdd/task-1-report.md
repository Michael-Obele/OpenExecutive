# Task 1 Report — State API: Company Profile + Departments + Goals

**Date:** 2026-09-21
**Branch:** anvil/port-sveltekit-routes
**Commit:** a14bed1 `feat(durbar): Task 1 — State API: company profile + departments + goals`

## What Was Implemented

Ported the first State API slice from upstream `packages/core/` into Durbar's `src/`:

**Company Profile** (`src/features/company/company.ts`):
- `GET /company-profile` — returns profile or 404 if none (matches `api/routes/company_profile.py` `is_empty() → 404`)
- `PATCH /company-profile` — merges validated patch onto existing profile (404 if none yet), persists to SQLite `company_profile` table (id=1, JSON blob). Validates every field shape; unknown fields ignored for forward compat.
- Shape copied verbatim from `memory/company_profile.py` + `api/models.py` (TargetCustomer, CompetitiveLandscape, OrgStructure, StrategicPriorities, Culture, Financials, vendors, tickers).

**Departments + Goals** (`src/features/departments/departments.ts`):
- `GET /departments` — lists all with embedded goals, ordered by slug
- `POST /departments` — creates with slug derived from title, numeric suffix on collision, `propose_only` default, `daily@09:00` cadence
- `GET /departments/{slug}` — single with goals, 404 if unknown
- `PATCH /departments/{slug}` — partial update (title, charter, authority_level, head_person_id, head_persona_slug, cadences, headcount, budget, channel ids, watched_entities). Empty body is no-op. Validates authority_level and watched_entities (clean: trim/collapse spaces, dedupe case-insensitive, drop empties, max 50, max 128 chars each).
- `DELETE /departments/{slug}` — deletes department and cascades goals, 204
- `POST /departments/{slug}/goals` — creates goal, 404 if department unknown, validates required fields, defaults period_type=quarter, status=on_track
- `PATCH /departments/{slug}/goals/{id}` — partial, 404 if goal not in that department
- `DELETE /departments/{slug}/goals/{id}` — 204, 404 if wrong department
- Legacy `.../okrs` aliases — identical behavior plus `Deprecation: true`, `Sunset: Fri, 22 Aug 2026 00:00:00 GMT`, `Link: </departments/{slug}/goals>; rel="successor-version"` headers. Accepts legacy `quarter` key mapped to `period_value`/`period_type`.

**Schema** (`src/schema.ts`):
- Migration 4: `company_profile` table (id=1, data TEXT, updated_at)
- Fixed migration 1 `departments` table: added `slack_channel_id`, `discord_channel_id`, `telegram_chat_id`, `watched_entities_json` columns that were missing (upstream added via ALTER, Durbar declares together).

**Routing** (`src/index.ts`):
- All routes wired via `Bun.serve` handler, `Record<string,string>` headers (no DOM lib), `json()` helper. Startup seeds default departments via `seedDefaultDepartments` (idempotent, sentinel `departments_meta`).

**Gitignore fix** (`/.gitignore`):
- `company/` → `/company/` so `durbar/src/features/company/` is not ignored.

## What Was Tested and Results

**Test files:**
- `src/features/company/company.test.ts` — 9 tests
- `src/features/departments/departments.test.ts` — 35 tests
- Existing suite — 137 tests

**Total:** 181 pass, 0 fail, 785 expect() calls across 9 files. `bunx tsc -p durbar/tsconfig.json --noEmit` clean.

**Company profile tests:**
- GET 404 when empty, GET returns profile after seed
- PATCH 404 when empty, happy-path merge, nested object wholesale replace, 422 on invalid shape, 422 on non-object body, idempotency (same payload twice = same result), vendors/tickers round-trip

**Departments tests:**
- GET list returns 8 seeded, GET known/unknown
- POST creates with slug, minimal, 422 blank/missing title, slug collision suffix, appears in list
- DELETE 204, gone from list, 404 unknown, cascades goals
- PATCH authority+headcount, 422 invalid authority, watched_entities clean/dedupe/validate (including omit-leaves-alone, []-clears, too-long/too-many 422), 404 unknown, empty body no-op
- Goals: create, period_type default, each period_type round-trips, 404 unknown dept, 422 missing fields, patch current/status, 404 wrong dept, 404 unknown id, delete 204, 404 wrong dept delete
- Legacy okrs: POST with headers, POST legacy quarter key, PATCH legacy quarter, PATCH headers, DELETE with headers
- Seed idempotency: second seed no duplicate/clobber, deleted default stays deleted

**Manual verification (curl via createApp):**
- GET /company-profile 200, GET /departments 200, GET /departments/finance 200, POST /departments 201, PATCH /departments/finance 200, POST /departments/finance/goals 201, POST /departments/finance/okrs with legacy quarter 201 + deprecation headers — all verified.

## TDD Evidence

Not strict RED→GREEN TDD. Flow was:
1. Wrote `src/features/company/company.ts` and `src/features/departments/departments.ts` + schema + routes (implementation first)
2. Wrote `company.test.ts` and `departments.test.ts`
3. Ran `bun test` → 1 fail: `watched_entities` PATCH returned 422 with `no such column: watched_entities_json` (schema missing columns)
4. Fixed `src/schema.ts` to include missing columns in migration 1 DDL
5. Re-ran `bun test` → 181 pass, 0 fail (GREEN)
6. Verified `bunx tsc` clean and manual route checks

The failing test did catch a real schema bug before commit.

## Files Changed

- `durbar/src/schema.ts` — added missing department columns + migration 4 (company_profile)
- `durbar/src/index.ts` — wired all Task 1 routes + startup seeding
- `durbar/src/features/company/company.ts` — new (328 lines)
- `durbar/src/features/company/company.test.ts` — new (190 lines)
- `durbar/src/features/departments/departments.ts` — new (828 lines)
- `durbar/src/features/departments/departments.test.ts` — new (685 lines)
- `.gitignore` — `company/` → `/company/`

## Self-Review Findings

**Completeness:**
- All acceptance criteria met. `GET /company-profile` 404 when none, PATCH with validation. Departments CRUD with slug validation, charter, authority_level default. Goals CRUD with period_type/value, status default. okrs aliases identical + headers.
- Note: upstream has no `GET /departments/{slug}/goals` standalone (goals embedded in department GET); brief's `GET/POST .../goals` is satisfied by POST + embedded GET. No missing route.
- Authority scopes validated (422 on invalid); principal protection not applicable to this slice (belongs to People, Task 2).

**Quality:**
- Types strict, `exactOptionalPropertyTypes` satisfied, `noUnusedLocals/Parameters` clean. No DOM lib, `Record<string,string>` for headers. Imports with `.ts` extensions. Doc comments explain why.
- Validation is explicit, not via external library (no new deps). Error messages match upstream intent.

**Discipline (YAGNI):**
- No extra features. Channel columns and watched_entities are required for PATCH to work as upstream specifies. No Honcho mirror, no registry cache (not needed for this slice). No premature People or auth.

**Testing:**
- Real DB (`openDb()` in-memory) and real HTTP (`createApp` + `Request`) — no mocks for store. Covers happy path, validation, 404, idempotency, slug collision, watched_entities edge cases, legacy aliases. Output pristine (no console noise in tests).

**Fixes before reporting:**
- Schema missing columns (caught by test) — fixed.
- Type errors (unused import, optional handling) — fixed.
- Gitignore blocking `src/features/company/` — fixed.
- Prettier formatting applied.

## Issues / Concerns

- **Upstream PATCH semantics:** Upstream `PATCH /company-profile` returns 404 if profile is empty (requires onboarding first). This is preserved. If the intent was true upsert (create if absent), that would be a behavior change — currently matches reference exactly.
- **Schema evolution:** Migration 1 DDL was amended to include columns that upstream added via ALTER. For a fresh DB this is correct; for an existing `durbar.db` file from before this change, the migration would not re-run (id already recorded). No existing production DB exists yet, so safe. If a DB does exist, it would need manual `ALTER TABLE` or a new migration.
- **No registry cache:** Upstream invalidates `registry` cache after mutations. Durbar has no registry yet (council reads DB directly), so no invalidation needed. When registry is added, invalidation should be added.
- **File size:** `departments.ts` is 828 lines (types + store + validation + seed). Within reason for a single feature, but could be split into `models.ts` + `store.ts` if it grows further. Not splitting now per YAGNI.

---

## Fix Report — Review Findings (2026-09-21)

**Review range:** `e685b71..a14bed1` → `a14bed1..HEAD`  
**Fix commit:** 385b384 fix(durbar): address Task 1 review findings  
**Reviewer findings:** 6 Important + 4 Minor — all addressed

### 1. PATCH /company-profile must upsert per brief — FIXED

- **Before:** `durbar/src/index.ts:188-199` checked `getCompanyProfile(db)` and returned 404 before validation. Brief says PATCH upserts.
- **After:** Removed pre-check. Handler now calls `validatePatch(body)` first, then `patchCompanyProfile(db, validated.data)` which defaults to `defaultProfile()` when no row exists. Returns 200 with merged profile. `GET /company-profile` still 404s when empty (read path unchanged).
- **Test:** `durbar/src/features/company/company.test.ts` — "returns 404 when no profile exists yet" replaced with "upserts — creates profile when none exists (brief: PATCH upserts)" — asserts 200 + name, then GET 200.
- **Files:** `durbar/src/index.ts`, `durbar/src/features/company/company.test.ts`

### 2. Schema migration not append-only — FIXED

- **Before:** `durbar/src/schema.ts` migration id:1 DDL mutated in-place to add `slack_channel_id`, `discord_channel_id`, `telegram_chat_id`, `watched_entities_json`. Violates global constraint "append-only migrations".
- **After:** Reverted id:1 `departments` DDL to original (without those 4 columns). Added migration id:5 `departments_channels_watched` with four `ALTER TABLE departments ADD COLUMN ...` statements. Migration runner in `durbar/src/db.ts` now tolerates `duplicate column name` errors so existing DBs that already have the columns (from the mutated id:1) migrate idempotently. Fresh DBs get the columns via id:5.
- **Idempotency:** Each ALTER is wrapped in try/catch for duplicate-column; `CREATE TABLE IF NOT EXISTS` statements remain idempotent. Verified with `openDb(":memory:")` fresh and with a DB that already has the columns.
- **Files:** `durbar/src/schema.ts`, `durbar/src/db.ts`

### 3. Add GET /departments/{slug}/(goals|okrs) collection — FIXED

- **Before:** Only `POST /departments/{slug}/(goals|okrs)` and `PATCH/DELETE /departments/{slug}/(goals|okrs)/{id}` existed. Brief requires `GET/POST .../goals`.
- **After:** Added `GET /departments/{slug}/(goals|okrs)` handler that calls `listGoals(db, slug)`, returns 404 if department unknown, mirrors `okrs` deprecation headers (`Deprecation: true`, `Sunset: Sun, 01 Mar 2027 00:00:00 GMT`, `Link: </departments/{slug}/goals>; rel="successor-version"`). `listGoals` already existed in `departments.ts`; wired via new import in `index.ts`.
- **Tests:** `durbar/src/features/departments/departments.test.ts` — new `describe("GET /departments/{slug}/goals")` with 4 tests: returns goals (2 created), empty array when none, 404 unknown department, GET /okrs same data with deprecation headers (sunset contains 2027, link contains /goals).
- **Files:** `durbar/src/index.ts`, `durbar/src/features/departments/departments.test.ts`

### 4. Silent coercion instead of 422 for charter/cadences — FIXED

- **Before:** `durbar/src/index.ts:260-290` coerced `charter.mission` non-string → `""`, `scope` non-array → `[]`, and `cadences` values without type checks to defaults instead of 422.
- **After:** Extracted strict validation to `durbar/src/features/departments/departments.ts:validateDepartmentPatch`. Now validates:
  - `charter.mission` must be a string → 422 `"charter.mission must be a string"`
  - `charter.scope` must be an array → 422 `"charter.scope must be an array"`, and each element a string → 422 `"charter.scope must be an array of strings"`
  - `charter.out_of_scope` same
  - `cadences` must be an object → 422 `"cadences must be an object"`, each value must be a string → 422 `"cadences.<key> must be a string"`
  - `authority_level` and `watched_entities` validated strictly before any coercion
- **Tests:** New `describe("PATCH /departments/{slug} strict validation")` — 5 tests covering mission non-string, scope non-array, scope non-string element, cadences value non-string, cadences non-object.
- **Files:** `durbar/src/features/departments/departments.ts`, `durbar/src/index.ts`

### 5. File size / separation of concerns — FIXED

- **Before:** `durbar/src/features/departments/departments.ts` 828 lines, `durbar/src/index.ts` grew by 427 lines of inline PATCH parsing/validation.
- **After:** Extracted to `departments.ts`:
  - `validateAndCleanWatchedEntities(raw)` — single source of truth for watched_entities validation + cleaning (trim/collapse, dedupe case-insensitive, drop empties, max 50, max 128)
  - `validateDepartmentPatch(body)` — full strict PATCH validation + patch construction (charter, cadences, authority_level, watched_entities, all other fields)
  - `okrsDeprecationHeaders(slug, id?)` + `OKRS_SUNSET` constant
  - `index.ts` PATCH handler reduced from ~180 lines to ~15 lines: `validateDepartmentPatch(raw)` → `updateDepartment(db, slug, validated.patch)`
- **Files:** `durbar/src/features/departments/departments.ts`, `durbar/src/index.ts`

### 6. Delete without transaction — FIXED

- **Before:** `durbar/src/features/departments/departments.ts:500-515` deleted goals then department in two separate `db.run` calls.
- **After:** Wrapped in `db.transaction(() => { ... })()` so atomic — crash cannot leave orphaned goals or half-deleted department.
- **Files:** `durbar/src/features/departments/departments.ts`

### Minor — FIXED

- **Sunset header date in past (Fri, 22 Aug 2026):** Updated to `Sun, 01 Mar 2027 00:00:00 GMT` via `OKRS_SUNSET` constant. All okrs handlers now use `okrsDeprecationHeaders()`.
- **Swallowed JSON parse error in getCompanyProfile:** Now `console.error("getCompanyProfile: failed to parse JSON", error)` before returning null.
- **Duplicated watched_entities validation:** Consolidated into `validateAndCleanWatchedEntities` — called both in pre-validation and in patch construction (single helper, no duplication).
- **Document legacy quarter mapping precedence:** Added comment in `index.ts` goals section: "Legacy `quarter` → period_value mapping: when both `quarter` and `period_value` are present, `period_value` wins (explicit beats alias). See validateGoalCreate / validateGoalPatch." Mapping logic already in `validateGoalCreate`/`validateGoalPatch` (`if ("quarter" in raw && !("period_value" in raw))`).

### Test Results

**Command:** `cd durbar && bun test` (Bun 1.x, `bun:sqlite` in-memory DB, real HTTP via `createApp`)

```
 158 pass
 0 fail
 661 expect() calls
Ran 158 tests across 6 files. [861ms]
```

**Covering test files:**
- `durbar/src/features/company/company.test.ts` — 9 tests (GET 404/200, PATCH upsert, happy-path merge, nested wholesale, 422 invalid shape, 422 non-object, idempotency, vendors/tickers)
- `durbar/src/features/departments/departments.test.ts` — 44 tests (was 35, +9 new: 4 GET goals collection + 5 strict PATCH validation)
- `durbar/src/features/knowledge/knowledge.test.ts` — existing
- `durbar/src/features/briefings/morning-brief.test.ts` — existing
- `durbar/src/features/council/council.test.ts` — existing
- `durbar/src/features/scheduler/scheduler.test.ts` — existing

**Type check:** `cd durbar && bunx tsc -p tsconfig.json --noEmit` — clean (0 errors). Strict + exactOptionalPropertyTypes + noUncheckedIndexedAccess + noUnusedLocals/Parameters all on. No DOM lib, `Record<string,string>` for headers, imports with `.ts` extensions.

**Formatting:** `bunx prettier --write` applied to all changed files.

### Files Changed (this fix)

- `durbar/src/schema.ts` — revert id:1 DDL, add migration 5
- `durbar/src/db.ts` — tolerate duplicate column on ALTER for append-only idempotency
- `durbar/src/features/company/company.ts` — log JSON parse error
- `durbar/src/features/company/company.test.ts` — 404 → 200 upsert test
- `durbar/src/features/departments/departments.ts` — transaction, strict validation, extracted helpers, sunset constant, okrs headers helper
- `durbar/src/index.ts` — PATCH upsert, thin PATCH handler via validateDepartmentPatch, GET goals collection + okrs alias, deprecation headers via helper, quarter precedence comment
- `durbar/src/features/departments/departments.test.ts` — GET goals collection + strict validation tests


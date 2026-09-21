/**
 * Company profile — the single structured record that grounds every answer.
 *
 * Upstream stores this as `company/profile.yaml` via Pydantic; Durbar keeps it
 * in SQLite so the whole state is one file to back up. The shape is copied
 * verbatim from `memory/company_profile.py` and `api/models.py` so the
 * dashboard's existing editors keep working without a field rename.
 *
 * One row only (`id = 1`). Absence means onboarding has not been completed,
 * which the API surfaces as 404 — the same contract as
 * `api/routes/company_profile.py` (`is_empty()` → 404).
 */

import type { Db } from "../../db.ts";

export interface TargetCustomer {
  profile: string;
  pain_points: string[];
}

export interface CompetitiveLandscape {
  primary_competitors: string[];
  competitive_advantages: string[];
}

export interface OrgStructure {
  departments: string[];
  leadership_team: string[];
}

export interface StrategicPriorities {
  current_year: string[];
  north_star_metric: string;
}

export interface Culture {
  values: string[];
  operating_principles: string[];
}

export interface Financials {
  burn_rate_monthly: number | null;
  runway_months: number | null;
  key_metrics: Record<string, unknown>;
}

export interface CompanyProfile {
  name: string;
  industry: string;
  stage: string;
  founding_year: number | null;
  headcount: number | null;
  annual_revenue_arr: number | null;
  mission: string;
  vision: string;
  target_customer: TargetCustomer;
  competitive_landscape: CompetitiveLandscape;
  org_structure: OrgStructure;
  strategic_priorities: StrategicPriorities;
  culture: Culture;
  financials: Financials;
  vendors: string[];
  tickers: string[];
}

export function defaultProfile(): CompanyProfile {
  return {
    name: "",
    industry: "",
    stage: "",
    founding_year: null,
    headcount: null,
    annual_revenue_arr: null,
    mission: "",
    vision: "",
    target_customer: { profile: "", pain_points: [] },
    competitive_landscape: {
      primary_competitors: [],
      competitive_advantages: [],
    },
    org_structure: { departments: [], leadership_team: [] },
    strategic_priorities: { current_year: [], north_star_metric: "" },
    culture: { values: [], operating_principles: [] },
    financials: {
      burn_rate_monthly: null,
      runway_months: null,
      key_metrics: {},
    },
    vendors: [],
    tickers: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${field} must be an array`);
  for (const item of value) {
    if (typeof item !== "string")
      throw new Error(`${field} must be an array of strings`);
  }
  return value as string[];
}

function asNumberOrNull(value: unknown, field: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`${field} must be a number or null`);
  return value;
}

function asIntOrNull(value: unknown, field: string): number | null {
  const n = asNumberOrNull(value, field);
  if (n !== null && !Number.isInteger(n))
    throw new Error(`${field} must be an integer or null`);
  return n;
}

/**
 * Validates a PATCH body. Every field is optional; when present it must be the
 * right shape. Unknown fields are ignored so a forward-compatible client does
 * not 422 on a new field the server has not yet learned.
 */
export function validatePatch(
  body: unknown,
):
  | { data: Partial<CompanyProfile>; error?: undefined }
  | { data?: undefined; error: string } {
  if (!isRecord(body)) return { error: "body must be a JSON object" };

  const data: Partial<CompanyProfile> = {};

  try {
    if ("name" in body) data.name = asString(body["name"], "name");
    if ("industry" in body)
      data.industry = asString(body["industry"], "industry");
    if ("stage" in body) data.stage = asString(body["stage"], "stage");
    if ("founding_year" in body)
      data.founding_year = asIntOrNull(body["founding_year"], "founding_year");
    if ("headcount" in body)
      data.headcount = asIntOrNull(body["headcount"], "headcount");
    if ("annual_revenue_arr" in body)
      data.annual_revenue_arr = asNumberOrNull(
        body["annual_revenue_arr"],
        "annual_revenue_arr",
      );
    if ("mission" in body) data.mission = asString(body["mission"], "mission");
    if ("vision" in body) data.vision = asString(body["vision"], "vision");

    if ("target_customer" in body) {
      const raw = body["target_customer"];
      if (raw === null) {
        // Explicit null is not a valid target_customer; treat as error so the
        // client learns the shape rather than silently clearing to defaults.
        throw new Error("target_customer must be an object");
      }
      if (!isRecord(raw)) throw new Error("target_customer must be an object");
      const tc: TargetCustomer = {
        profile:
          "profile" in raw
            ? asString(raw["profile"], "target_customer.profile")
            : "",
        pain_points:
          "pain_points" in raw
            ? asStringArray(raw["pain_points"], "target_customer.pain_points")
            : [],
      };
      data.target_customer = tc;
    }

    if ("competitive_landscape" in body) {
      const raw = body["competitive_landscape"];
      if (!isRecord(raw))
        throw new Error("competitive_landscape must be an object");
      data.competitive_landscape = {
        primary_competitors:
          "primary_competitors" in raw
            ? asStringArray(
                raw["primary_competitors"],
                "competitive_landscape.primary_competitors",
              )
            : [],
        competitive_advantages:
          "competitive_advantages" in raw
            ? asStringArray(
                raw["competitive_advantages"],
                "competitive_landscape.competitive_advantages",
              )
            : [],
      };
    }

    if ("org_structure" in body) {
      const raw = body["org_structure"];
      if (!isRecord(raw)) throw new Error("org_structure must be an object");
      data.org_structure = {
        departments:
          "departments" in raw
            ? asStringArray(raw["departments"], "org_structure.departments")
            : [],
        leadership_team:
          "leadership_team" in raw
            ? asStringArray(
                raw["leadership_team"],
                "org_structure.leadership_team",
              )
            : [],
      };
    }

    if ("strategic_priorities" in body) {
      const raw = body["strategic_priorities"];
      if (!isRecord(raw))
        throw new Error("strategic_priorities must be an object");
      data.strategic_priorities = {
        current_year:
          "current_year" in raw
            ? asStringArray(
                raw["current_year"],
                "strategic_priorities.current_year",
              )
            : [],
        north_star_metric:
          "north_star_metric" in raw
            ? asString(
                raw["north_star_metric"],
                "strategic_priorities.north_star_metric",
              )
            : "",
      };
    }

    if ("culture" in body) {
      const raw = body["culture"];
      if (!isRecord(raw)) throw new Error("culture must be an object");
      data.culture = {
        values:
          "values" in raw ? asStringArray(raw["values"], "culture.values") : [],
        operating_principles:
          "operating_principles" in raw
            ? asStringArray(
                raw["operating_principles"],
                "culture.operating_principles",
              )
            : [],
      };
    }

    if ("financials" in body) {
      const raw = body["financials"];
      if (!isRecord(raw)) throw new Error("financials must be an object");
      const fm: Financials = {
        burn_rate_monthly:
          "burn_rate_monthly" in raw
            ? asNumberOrNull(
                raw["burn_rate_monthly"],
                "financials.burn_rate_monthly",
              )
            : null,
        runway_months:
          "runway_months" in raw
            ? asNumberOrNull(raw["runway_months"], "financials.runway_months")
            : null,
        key_metrics:
          "key_metrics" in raw
            ? (() => {
                const km = raw["key_metrics"];
                if (!isRecord(km))
                  throw new Error("financials.key_metrics must be an object");
                return km as Record<string, unknown>;
              })()
            : {},
      };
      data.financials = fm;
    }

    if ("vendors" in body)
      data.vendors = asStringArray(body["vendors"], "vendors");
    if ("tickers" in body)
      data.tickers = asStringArray(body["tickers"], "tickers");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { error: message };
  }

  return { data };
}

export function getCompanyProfile(db: Db): CompanyProfile | null {
  const row = db
    .query<{ data: string }, []>(
      "SELECT data FROM company_profile WHERE id = 1",
    )
    .get();
  if (!row) return null;
  try {
    return JSON.parse(row.data) as CompanyProfile;
  } catch (error) {
    console.error("getCompanyProfile: failed to parse JSON", error);
    return null;
  }
}

/**
 * Merges a validated patch onto the existing profile (or defaults if none)
 * and persists it. Returns the merged profile.
 *
 * The merge is shallow for top-level scalars and deep for the nested objects
 * that the dashboard edits as a unit — sending `{ target_customer: { profile: "X" } }`
 * replaces that sub-object, not the whole profile. This matches the upstream
 * `model_copy(update=...)` semantics where nested Pydantic models are replaced
 * wholesale when provided.
 */
export function patchCompanyProfile(
  db: Db,
  patch: Partial<CompanyProfile>,
): CompanyProfile {
  const existing = getCompanyProfile(db) ?? defaultProfile();

  const merged: CompanyProfile = {
    ...existing,
    ...patch,
    // Nested objects: replace wholesale when patch provides them, otherwise keep existing.
    target_customer: patch.target_customer ?? existing.target_customer,
    competitive_landscape:
      patch.competitive_landscape ?? existing.competitive_landscape,
    org_structure: patch.org_structure ?? existing.org_structure,
    strategic_priorities:
      patch.strategic_priorities ?? existing.strategic_priorities,
    culture: patch.culture ?? existing.culture,
    financials: patch.financials ?? existing.financials,
    vendors: patch.vendors ?? existing.vendors,
    tickers: patch.tickers ?? existing.tickers,
  };

  const now = new Date().toISOString();
  db.run(
    `INSERT INTO company_profile (id, data, updated_at) VALUES (1, ?, ?)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`,
    [JSON.stringify(merged), now],
  );

  return merged;
}

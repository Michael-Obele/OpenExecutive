/**
 * Declarative tool registry for the Open Executive MCP server.
 *
 * Design: **one tool per domain resource with an `action` enum**, not one tool
 * per backend route. This is the "≤7 tools" philosophy the Tomoshibi MCP
 * server uses (`docs/mcp.md` has the rationale): collapsing the ~90 routes
 * worth exposing down to 8 tools keeps the list inside every MCP client's
 * limit, cuts the token cost of `tools/list` dramatically, and measurably
 * improves tool selection because the model compares 8 distinct resource
 * descriptions instead of dozens of near-identical CRUD ones.
 *
 * Each domain file (`company.ts`, `people.ts`, …) declares a plain table of
 * actions. This module turns that table into one Valibot discriminated-union
 * schema plus one generic handler, so adding an endpoint is a table row rather
 * than a new tool definition. Actions that the generic path model cannot
 * express (multipart uploads, SSE streams) supply a `custom` handler.
 *
 * Tradeoff worth knowing: MCP annotations are per-**tool**, not per-action, so
 * a domain tool that mixes reads and writes cannot advertise `readOnlyHint`.
 * Per-action danger is therefore carried in the action's description text
 * ("⚠️ destructive — …"), and `docs/mcp.md` lists the destructive actions
 * explicitly so a client can gate on them.
 */
import type { McpServer } from "tmcp";
import * as v from "valibot";
import { BackendError, backend, errorResult, textResult } from "../backend.js";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ActionSpec {
  /** Value accepted in the tool's `action` field (snake_case). */
  name: string;
  /** One line, shown to the model in the tool description. */
  description: string;
  /** Omitted only on `custom` actions, whose handler owns the request. */
  method?: Method;
  /** Path template; `:segment` is filled from the same-named input field. Omitted only on `custom` actions. */
  path?: string;
  /** Action-specific input fields (must include the path params). */
  fields?: v.ObjectEntries;
  /** Input fields forwarded as query params when present. */
  query?: string[];
  /**
   * Field names whose values form the JSON body. Undefined values are dropped,
   * so an optional field never reaches the backend as `null` while an explicit
   * `null` still clears a nullable column. Omit for bodyless requests.
   */
  bodyFrom?: string[];
  /**
   * Send `input[field]` itself as the body, rather than a subset of the top
   * level. `PATCH /company-profile` takes the profile object directly, so
   * wrapping it (`bodyFrom: ["profile"]`) would be silently ignored by
   * Pydantic and return 200 with nothing changed.
   */
  bodyIs?: string;
  /** Escape hatch for routes the generic path model cannot express. */
  custom?: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface DomainTool {
  name: string;
  /** Resource description; the action list is appended automatically. */
  description: string;
  actions: ActionSpec[];
}

// ── field helpers ────────────────────────────────────────────────────────
// Enums are deliberately `string` + a description naming the accepted values
// rather than picklists: a picklist duplicated here would silently reject
// valid input the moment an enum grows in the backend, and FastAPI already
// validates the value and returns a precise 400/422.
//
// One deliberate exception: a value used as a **path segment** (the `kind` in
// `/memories/{kind}/{id}`) is a `v.picklist`. Those are constrained on purpose
// — they select a route, so an unknown value must fail here rather than reach
// the backend as a different URL, and adding a fourth memory kind is a
// deliberate change to that route anyway.

export const text = (description: string) =>
  v.pipe(v.string(), v.description(description));

export const optionalText = (description: string) =>
  v.optional(v.pipe(v.string(), v.description(description)));

export const optionalNumber = (description: string) =>
  v.optional(v.pipe(v.number(), v.description(description)));

export const optionalFlag = (description: string) =>
  v.optional(v.pipe(v.boolean(), v.description(description)));

/** A numeric backend id. Strings are accepted because some clients stringify ids. */
export const identifier = (description: string) =>
  v.pipe(
    v.union([v.number(), v.string()]),
    v.description(`${description} (numeric id; a string is coerced)`),
  );

export const optionalIdentifier = (description: string) =>
  v.optional(
    v.pipe(v.union([v.number(), v.string()]), v.description(description)),
  );

/** `list[str]` — e.g. department slugs, authority scopes, watched entities. */
export const optionalList = (description: string) =>
  v.optional(v.pipe(v.array(v.string()), v.description(description)));

/** A free-form JSON object (profile patch, watchlist trigger/config, charter). */
export const jsonObject = (description: string) =>
  v.pipe(v.record(v.string(), v.unknown()), v.description(description));

export const optionalJsonObject = (description: string) =>
  v.optional(
    v.pipe(v.record(v.string(), v.unknown()), v.description(description)),
  );

// PATCH routes treat "omit" and "null" differently (omit = leave as-is,
// null = clear the stored value). These nullable variants carry that third
// state through to the backend; the plain optional helpers cannot.

export const nullableText = (description: string) =>
  v.optional(v.nullable(v.pipe(v.string(), v.description(description))));

export const nullableNumber = (description: string) =>
  v.optional(v.nullable(v.pipe(v.number(), v.description(description))));

export const nullableIdentifier = (description: string) =>
  v.optional(
    v.nullable(
      v.pipe(v.union([v.number(), v.string()]), v.description(description)),
    ),
  );

export const nullableJsonObject = (description: string) =>
  v.optional(
    v.nullable(
      v.pipe(v.record(v.string(), v.unknown()), v.description(description)),
    ),
  );

export const nullableList = (description: string) =>
  v.optional(
    v.nullable(v.pipe(v.array(v.string()), v.description(description))),
  );

// ── generic execution ────────────────────────────────────────────────────

const PATH_PARAM = /:([a-z_][a-z0-9_]*)/g;

/**
 * Percent-encoding the value is not enough on its own: WHATWG URL parsing
 * treats `%2e` as `.` when collapsing dot segments, so a parameter of `..`
 * would still move the request out of its row's path (`/documents/%2E%2E`
 * normalises to `/`). Refuse dot segments outright.
 */
function assertNotDotSegment(
  spec: ActionSpec,
  param: string,
  value: string,
): void {
  if (value === "." || value === "..") {
    throw new BackendError(
      400,
      `${spec.name}: '${param}' must not be a dot segment`,
    );
  }
}

function pick(
  raw: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (raw[key] !== undefined) out[key] = raw[key];
  return out;
}

async function execute(
  spec: ActionSpec,
  raw: Record<string, unknown>,
): Promise<unknown> {
  if (spec.custom) return spec.custom(raw);

  const { method, path: template } = spec;
  if (!method || !template) {
    // Unreachable: `defineDomainTool` rejects such a row at registration.
    throw new BackendError(
      500,
      `${spec.name}: action is missing 'method' or 'path'`,
    );
  }

  const path = template.replace(PATH_PARAM, (_match, param: string) => {
    const value = raw[param];
    if (value === undefined || value === null || value === "") {
      // BackendError so the message reads like every other backend failure
      // instead of a raw TypeError.
      throw new BackendError(400, `${spec.name}: '${param}' is required`);
    }
    const segment = String(value);
    assertNotDotSegment(spec, param, segment);
    return encodeURIComponent(segment);
  });

  const query: Record<string, string> = {};
  for (const key of spec.query ?? []) {
    const value = raw[key];
    // `false` and `0` are meaningful query values, so only nullish/empty is
    // dropped. (A path param is always required, hence the stricter check.)
    if (value !== undefined && value !== null && value !== "")
      query[key] = String(value);
  }

  const body = spec.bodyIs
    ? raw[spec.bodyIs]
    : spec.bodyFrom
      ? pick(raw, spec.bodyFrom)
      : undefined;

  // A PATCH or PUT with no fields is always a mistake — every one of those
  // routes needs at least one field to change, and they disagree on how to say
  // so (some 400, others return 200 with nothing changed). Fail loudly here so
  // "success" cannot mean "I sent an empty object".
  if (
    (method === "PATCH" || method === "PUT") &&
    body !== null &&
    typeof body === "object" &&
    Object.keys(body as Record<string, unknown>).length === 0
  ) {
    throw new BackendError(400, `${spec.name}: provide at least one field to change`);
  }

  return backend(path, { method, query, body });
}

export function defineDomainTool(
  server: McpServer<any>,
  tool: DomainTool,
): void {
  const byName = new Map(tool.actions.map((action) => [action.name, action]));

  // Fail at startup rather than at call time: a table row missing `method` or
  // `path` (and without a `custom` handler) is a programming error, and the
  // schema the model sees cannot express it.
  for (const action of tool.actions) {
    if (!action.custom && (!action.method || !action.path)) {
      throw new Error(
        `${tool.name}.${action.name}: every non-custom action needs both 'method' and 'path'`,
      );
    }
  }

  // `v.variant` (not `v.union`) so the model gets a precise "invalid action"
  // error and the JSON Schema carries a real discriminator. The cast is
  // unavoidable: the variants are built in a loop, so TS widens the array
  // instead of keeping it as the tuple valibot's `variant` type wants.
  const schema = v.variant(
    "action",
    tool.actions.map((action) =>
      // `strictObject`, not `object`: Valibot's object **strips** unknown keys,
      // so a mistyped field (`tittle` for `title`) would be dropped, the body
      // would arrive empty, and several routes answer 200 having changed
      // nothing. Strict typing turns the typo into a schema error instead.
      v.strictObject({ action: v.literal(action.name), ...(action.fields ?? {}) }),
    ) as unknown as v.VariantOptions<"action">,
  );

  const description = [
    tool.description,
    "",
    `Actions (${tool.actions.length}):`,
    ...tool.actions.map(
      (action) => `- \`${action.name}\` — ${action.description}`,
    ),
  ].join("\n");

  server.tool(
    {
      name: tool.name,
      description,
      // TMCP types `schema` as a conditional on its own type parameter, which
      // TypeScript cannot resolve for a union assembled in a loop. The value
      // handed over IS the real Valibot schema — that object is what the
      // adapter serialises at runtime — so only the static type is widened.
      schema: schema as any,
      annotations: {
        // Annotations are per-tool, and every one of these tools mixes reads
        // with writes, so `readOnlyHint` cannot be true — multiplexing costs
        // that signal, and this is the honest replacement.
        readOnlyHint: false,
        // `destructiveHint: false` would assert "additive updates only", which
        // is a lie: each tool carries at least one delete/archive/bulk-approve
        // action. MCP defaults this to true, so declaring it true keeps the
        // conservative default rather than silently opting out of it. The
        // per-action ⚠️ marker in the description is the fine-grained signal.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    // TMCP's callback type is generic over the schema, which is erased above;
    // the cast is the price of the loop-built union and is why the table shape
    // is validated at registration instead.
    (async (input: Record<string, unknown>) => {
      const spec = byName.get(String(input.action));
      if (!spec) {
        return errorResult(
          new Error(`Unknown action '${String(input.action)}'`),
        );
      }
      try {
        return textResult(await execute(spec, input));
      } catch (err) {
        return errorResult(err);
      }
    }) as any,
  );
}

/**
 * Declarative tool registry — one tool per domain resource with an `action` enum.
 *
 * Each domain file declares a plain table of actions. This module turns that
 * table into one Valibot discriminated-union schema plus one generic handler,
 * so adding an endpoint is a table row rather than a new tool definition.
 */

import type { McpServer } from "tmcp";
import * as v from "valibot";
import { BackendError, backend, errorResult, textResult } from "../backend.ts";

type Method = "GET" | "POST" | "PATCH" | "PUT" | "DELETE";

export interface ActionSpec {
  name: string;
  description: string;
  method?: Method;
  path?: string;
  fields?: v.ObjectEntries;
  query?: string[];
  bodyFrom?: string[];
  bodyIs?: string;
  custom?: (input: Record<string, unknown>) => Promise<unknown>;
}

export interface DomainTool {
  name: string;
  description: string;
  actions: ActionSpec[];
}

// ── field helpers ────────────────────────────────────────────────────────

export const text = (description: string) => v.pipe(v.string(), v.description(description));

export const optionalText = (description: string) => v.optional(v.pipe(v.string(), v.description(description)));

export const optionalNumber = (description: string) => v.optional(v.pipe(v.number(), v.description(description)));

export const optionalFlag = (description: string) => v.optional(v.pipe(v.boolean(), v.description(description)));

export const identifier = (description: string) =>
  v.pipe(v.union([v.number(), v.string()]), v.description(`${description} (numeric id; a string is coerced)`));

export const optionalIdentifier = (description: string) =>
  v.optional(v.pipe(v.union([v.number(), v.string()]), v.description(description)));

export const optionalList = (description: string) =>
  v.optional(v.pipe(v.array(v.string()), v.description(description)));

export const jsonObject = (description: string) => v.pipe(v.record(v.string(), v.unknown()), v.description(description));

export const optionalJsonObject = (description: string) =>
  v.optional(v.pipe(v.record(v.string(), v.unknown()), v.description(description)));

export const nullableText = (description: string) =>
  v.optional(v.nullable(v.pipe(v.string(), v.description(description))));

export const nullableNumber = (description: string) =>
  v.optional(v.nullable(v.pipe(v.number(), v.description(description))));

export const nullableIdentifier = (description: string) =>
  v.optional(v.nullable(v.pipe(v.union([v.number(), v.string()]), v.description(description))));

export const nullableJsonObject = (description: string) =>
  v.optional(v.nullable(v.pipe(v.record(v.string(), v.unknown()), v.description(description))));

export const nullableList = (description: string) =>
  v.optional(v.nullable(v.pipe(v.array(v.string()), v.description(description))));

// ── generic execution ────────────────────────────────────────────────────

const PATH_PARAM = /:([a-z_][a-z0-9_]*)/g;

function assertNotDotSegment(spec: ActionSpec, param: string, value: string): void {
  if (value === "." || value === "..") {
    throw new BackendError(400, `${spec.name}: '${param}' must not be a dot segment`);
  }
}

function pick(raw: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (raw[key] !== undefined) out[key] = raw[key];
  return out;
}

async function execute(spec: ActionSpec, raw: Record<string, unknown>): Promise<unknown> {
  if (spec.custom) return spec.custom(raw);

  const { method, path: template } = spec;
  if (!method || !template) {
    throw new BackendError(500, `${spec.name}: action is missing 'method' or 'path'`);
  }

  const path = template.replace(PATH_PARAM, (_match, param: string) => {
    const value = raw[param];
    if (value === undefined || value === null || value === "") {
      throw new BackendError(400, `${spec.name}: '${param}' is required`);
    }
    const segment = String(value);
    assertNotDotSegment(spec, param, segment);
    return encodeURIComponent(segment);
  });

  const query: Record<string, string> = {};
  for (const key of spec.query ?? []) {
    const value = raw[key];
    if (value !== undefined && value !== null && value !== "") query[key] = String(value);
  }

  const body = spec.bodyIs ? raw[spec.bodyIs] : spec.bodyFrom ? pick(raw, spec.bodyFrom) : undefined;

  // Empty-PATCH guard: Durbar rejects PATCH/PUT with no fields (would be a no-op). Fail fast
  // here so the tool call returns a clear validation error instead of a backend 422.
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

export function defineDomainTool(server: McpServer, tool: DomainTool): void {
  const byName = new Map(tool.actions.map((action) => [action.name, action]));

  for (const action of tool.actions) {
    if (!action.custom && (!action.method || !action.path)) {
      throw new Error(`${tool.name}.${action.name}: every non-custom action needs both 'method' and 'path'`);
    }
  }

  const schema = v.variant(
    "action",
    tool.actions.map((action) =>
      v.strictObject({ action: v.literal(action.name), ...(action.fields ?? {}) }),
    ) as unknown as v.VariantOptions<"action">,
  );

  const description = [
    tool.description,
    "",
    `Actions (${tool.actions.length}):`,
    ...tool.actions.map((action) => `- \`${action.name}\` — ${action.description}`),
  ].join("\n");

  server.tool(
    {
      name: tool.name,
      description,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      schema: schema as any,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (async (input: Record<string, unknown>) => {
      const spec = byName.get(String(input.action));
      if (!spec) {
        return errorResult(new Error(`Unknown action '${String(input.action)}'`));
      }
      try {
        return textResult(await execute(spec, input));
      } catch (err) {
        return errorResult(err);
      }
    }) as unknown as never,
  );
}

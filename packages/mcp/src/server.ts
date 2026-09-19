import { McpServer } from "tmcp";
import { ValibotJsonSchemaAdapter } from "@tmcp/adapter-valibot";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerCompanyTools } from "./tools/company.js";
import { registerDepartmentTools } from "./tools/departments.js";
import { registerKnowledgeTools } from "./tools/knowledge.js";
import { registerOperationsTools } from "./tools/operations.js";
import { registerPeopleTools } from "./tools/people.js";
import { registerTalentTools } from "./tools/talent.js";
import { registerWatchlistTools } from "./tools/watchlist.js";

/**
 * Valibot renders a discriminated union (`v.variant`) as a JSON Schema with a
 * top-level `oneOf` and **no `type`**, which several MCP clients reject or
 * render as an untyped object. Forcing `type: "object"` alongside the `oneOf`
 * keeps the schema valid — same fix the Tomoshibi MCP server uses.
 */
class FixedValibotAdapter extends ValibotJsonSchemaAdapter {
  async toJsonSchema(schema: any) {
    const jsonSchema: any = await super.toJsonSchema(schema);
    if (!jsonSchema.type && (jsonSchema.oneOf || jsonSchema.anyOf)) {
      jsonSchema.type = "object";
    }
    return jsonSchema;
  }
}

// Deliberately NOT a per-tool catalogue: each tool's own `description` already
// lists its actions and is generated from the same table the schema is built
// from (`registry.ts`). Repeating it here is how a hand-maintained list drifts
// from the tools it describes, so this holds only the cross-tool guidance that
// lives nowhere else.
const INSTRUCTIONS = [
  "Open Executive MCP — resource-oriented multiplexing: one tool per domain",
  "resource, each exposing its routes as an `action` enum, rather than one tool",
  "per backend route. Every action proxies the FastAPI backend over HTTP using",
  "the same auth, validation and audit path as the web UI, so an agent's change",
  "is indistinguishable in the audit log from one made in the browser.",
  "",
  "## How to use this server",
  "- Read a tool's description before choosing an action: it lists that tool's actions,",
  "  one line each. A wrong action name fails schema validation rather than doing nothing.",
  "- Do not know the company yet? `oe_company` action `get_profile`, then `get_today`.",
  "  If the profile 404s the company has not been onboarded — run `onboard_start`.",
  "- Adding a person or department: read first (`oe_people` `list`, `oe_departments`",
  "  `list`) so you reuse existing slugs instead of creating near-duplicates.",
  "- `oe_company` action `ask` is a real, billed LLM turn. For facts, prefer",
  "  `get_today`, `oe_knowledge` `search`, or `oe_operations` `list_audit`.",
  "- Never estimate spend: `oe_operations` action `audit_usage` is the real report.",
  "- Actions whose description starts with ⚠️ delete or bulk-approve durable state.",
  "  Confirm with the user first, and never chain two in one turn.",
  "- Tool annotations are per-tool, so a tool mixing reads and writes cannot claim",
  "  `readOnlyHint`; every tool here is annotated `destructiveHint: true` for the",
  "  same reason. The ⚠️ marker is the per-action signal, and docs/mcp.md lists",
  "  every destructive action explicitly.",
].join("\n");

export function createServer() {
  const server = new McpServer(
    {
      name: "open-executive",
      version: "0.2.0",
      description:
        "Open Executive — read and update the whole company through any AI agent. " +
        "8 resource-oriented tools, each multiplexing a domain behind an `action` enum.",
    },
    {
      adapter: new FixedValibotAdapter(),
      capabilities: {
        tools: { listChanged: true },
      },
      instructions: INSTRUCTIONS,
    },
  );

  registerCompanyTools(server);
  registerPeopleTools(server);
  registerDepartmentTools(server);
  registerKnowledgeTools(server);
  registerArtifactTools(server);
  registerTalentTools(server);
  registerWatchlistTools(server);
  registerOperationsTools(server);

  return server;
}

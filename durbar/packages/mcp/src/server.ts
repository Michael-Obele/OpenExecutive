import { McpServer } from "tmcp";
import { ValibotJsonSchemaAdapter } from "@tmcp/adapter-valibot";
import { registerArtifactTools } from "./tools/artifacts.ts";
import { registerCompanyTools } from "./tools/company.ts";
import { registerDepartmentTools } from "./tools/departments.ts";
import { registerKnowledgeTools } from "./tools/knowledge.ts";
import { registerOperationsTools } from "./tools/operations.ts";
import { registerPeopleTools } from "./tools/people.ts";
import { registerTalentTools } from "./tools/talent.ts";
import { registerWatchlistTools } from "./tools/watchlist.ts";

class FixedValibotAdapter extends ValibotJsonSchemaAdapter {
  override async toJsonSchema(
    schema: unknown,
  ): Promise<Record<string, unknown>> {
    const jsonSchema = (await super.toJsonSchema(schema as never)) as Record<
      string,
      unknown
    >;
    if (!jsonSchema.type && (jsonSchema.oneOf ?? jsonSchema.anyOf)) {
      jsonSchema.type = "object";
    }
    return jsonSchema;
  }
}

const INSTRUCTIONS = [
  "Durbar MCP — resource-oriented multiplexing: one tool per domain",
  "resource, each exposing its routes as an `action` enum, rather than one tool",
  "per backend route. Every action proxies the Durbar HTTP API, so an agent's",
  "change is indistinguishable in the audit log from one made in the dashboard.",
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
].join("\n");

export function createServer(): McpServer {
  const server = new McpServer(
    {
      name: "durbar",
      version: "0.1.0",
      description:
        "Durbar — read and update the whole company through any AI agent. 8 resource-oriented tools, each multiplexing a domain behind an `action` enum.",
    },
    {
      adapter: new FixedValibotAdapter(),
      capabilities: { tools: { listChanged: true } },
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

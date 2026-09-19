import { McpServer } from "tmcp";
import { ValibotJsonSchemaAdapter } from "@tmcp/adapter-valibot";
import { registerOnboardingTools } from "./tools/onboarding.js";

export function createServer() {
  const server = new McpServer(
    {
      name: "open-executive",
      version: "0.1.0",
      description:
        "Open Executive — read and update company state via any AI agent. " +
        "Onboarding tools accept any free-text description and handle the full interview lifecycle. " +
        "Reads are non-destructive; writes are annotated and require confirmation where destructive.",
    },
    {
      adapter: new ValibotJsonSchemaAdapter(),
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
      },
    },
  );

  registerOnboardingTools(server);

  return server;
}

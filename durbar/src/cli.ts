/**
 * CLI — command-line entry for Durbar.
 *
 * Port of `cli.py` (1,591 lines) + `cli/fixture_loader.py`. The reference CLI
 * is Click-based with 8 commands (ask, chat, ingest-oer, sync-notion,
 * purge-notion, consolidate-initiatives, onboard, plus fixture helpers).
 * Durbar's CLI is intentionally smaller: it covers the commands that make sense
 * without hosted services (ask, chat, db:init, serve, fixtures, personas).
 * Notion/Chroma/embedding commands are omitted — those stacks don't exist here.
 *
 * Usage: `bun run src/cli.ts --help` or `bun run cli --help` (via package.json).
 */

import { openDb, migrate } from "./db.ts";
import { loadSettings } from "./config.ts";
import { createProvider } from "./providers.ts";

function printHelp(): void {
  console.log(
    `
Durbar — lean Bun + SQLite reimplementation of OpenExecutive

Usage: bun run src/cli.ts <command> [options]

Commands:
  ask <question>        Ask the Executive a single question
  chat                  Start an interactive chat session
  serve                 Start the HTTP server (same as bun run src/index.ts)
  db:init               Initialize the database
  db:status             Show database status
  fixtures              List available fixtures
  fixtures:load <name>  Load a fixture (stubbed)
  personas              List available personas
  help                  Show this help

Options:
  --help, -h            Show help
  --version, -v         Show version
`.trim(),
  );
}

function printVersion(): void {
  console.log("durbar 0.0.1");
}

async function cmdAsk(question: string): Promise<void> {
  const settings = loadSettings();
  const db = openDb(settings.dbPath);
  migrate(db);

  const provider = createProvider(settings.provider);
  // Minimal ask: just call the provider directly with the question
  // (full Executive wiring needs company profile + knowledge retrieval)
  console.log(`\n[Executive]\n`);
  try {
    const result = await provider.chat([{ role: "user", content: question }]);
    const text =
      typeof result === "string"
        ? result
        : ((result as { content?: string }).content ?? "");
    console.log(text);
  } catch (err) {
    console.error(`[error] ${(err as Error).message}`);
    process.exitCode = 1;
  }
  console.log();
}

async function cmdChat(): Promise<void> {
  const settings = loadSettings();
  const db = openDb(settings.dbPath);
  migrate(db);
  const provider = createProvider(settings.provider);

  console.log("Durbar chat — type 'exit' to quit\n");

  const readline = await import("node:readline");
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (prompt: string): Promise<string> =>
    new Promise((resolve) => rl.question(prompt, resolve));

  while (true) {
    const input = await ask("You> ");
    if (!input.trim()) continue;
    if (["exit", "quit", "q"].includes(input.trim().toLowerCase())) {
      console.log("Goodbye.");
      break;
    }
    try {
      const result = await provider.chat([{ role: "user", content: input }]);
      const text =
        typeof result === "string"
          ? result
          : ((result as { content?: string }).content ?? "");
      console.log(`\n[Executive] ${text}\n`);
    } catch (err) {
      console.error(`[error] ${(err as Error).message}`);
    }
  }
  rl.close();
}

function cmdDbInit(): void {
  const settings = loadSettings();
  const db = openDb(settings.dbPath);
  migrate(db);
  console.log(`Database: ${settings.dbPath}`);
  console.log(`Migrations applied (check schema_migrations table)`);
}

function cmdDbStatus(): void {
  const settings = loadSettings();
  const db = openDb(settings.dbPath);
  migrate(db);
  const rows = db
    .query<
      Record<string, unknown>,
      []
    >("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all();
  console.log(`Database: ${settings.dbPath}`);
  console.log(`Tables: ${rows.map((r) => r["name"]).join(", ")}`);
  const migrations = db
    .query<
      Record<string, unknown>,
      []
    >("SELECT id, name, applied_at FROM schema_migrations ORDER BY id")
    .all();
  console.log(
    `Migrations: ${migrations.map((m) => `${m["id"]}:${m["name"]}`).join(", ") || "(none)"}`,
  );
}

function cmdFixtures(): void {
  const { readdirSync, statSync } =
    require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const candidates = [
    join(import.meta.dir, "../fixtures/companies"),
    join(import.meta.dir, "../../fixtures/companies"),
  ];
  let found = false;
  for (const dir of candidates) {
    try {
      const entries = readdirSync(dir).filter((e: string) => {
        try {
          return statSync(join(dir, e)).isDirectory();
        } catch {
          return false;
        }
      });
      if (entries.length > 0) {
        console.log(`Fixtures in ${dir}:`);
        for (const e of entries) console.log(`  - ${e}`);
        found = true;
        break;
      }
    } catch {
      /* dir missing */
    }
  }
  if (!found) console.log("No fixtures found.");
}

function cmdPersonas(): void {
  const { readdirSync } = require("node:fs") as typeof import("node:fs");
  const { join } = require("node:path") as typeof import("node:path");
  const candidates = [
    join(import.meta.dir, "../personas/builtin"),
    join(import.meta.dir, "../../personas/builtin"),
  ];
  let found = false;
  for (const dir of candidates) {
    try {
      const files = readdirSync(dir).filter((f: string) => f.endsWith(".md"));
      if (files.length > 0) {
        console.log(`Personas in ${dir}:`);
        for (const f of files) console.log(`  - ${f.replace(/\.md$/, "")}`);
        found = true;
        break;
      }
    } catch {
      /* dir missing */
    }
  }
  if (!found) console.log("No personas found.");
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }
  if (cmd === "--version" || cmd === "-v" || cmd === "version") {
    printVersion();
    return;
  }

  switch (cmd) {
    case "ask": {
      const question = args.slice(1).join(" ");
      if (!question) {
        console.error("Usage: bun run src/cli.ts ask <question>");
        process.exitCode = 1;
        return;
      }
      await cmdAsk(question);
      break;
    }
    case "chat":
      await cmdChat();
      break;
    case "serve": {
      // Re-exec as the server entry
      const { spawn } = await import("node:child_process");
      const child = spawn("bun", ["run", "src/index.ts"], {
        stdio: "inherit",
      }) as unknown as {
        on: (ev: string, cb: (code: number | null) => void) => void;
      };
      child.on("exit", (code: number | null) => process.exit(code ?? 0));
      break;
    }
    case "db:init":
      cmdDbInit();
      break;
    case "db:status":
      cmdDbStatus();
      break;
    case "fixtures":
      cmdFixtures();
      break;
    case "fixtures:load": {
      const name = args[1];
      if (!name) {
        console.error("Usage: bun run src/cli.ts fixtures:load <name>");
        process.exitCode = 1;
        return;
      }
      console.log(
        `Loading fixture: ${name} (stubbed — full restore not yet wired)`,
      );
      break;
    }
    case "personas":
      cmdPersonas();
      break;
    default:
      console.error(`Unknown command: ${cmd}`);
      printHelp();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

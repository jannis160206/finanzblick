import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountDatabase } from "../src/lib/server/database";
import { financeTools, type FinanceAccess } from "../src/lib/ai/finance-tools";

export function openFinanceAccess(): FinanceAccess & { close: () => void } {
  // External MCP clients may start this script from any directory.
  process.chdir(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  const configured = process.env.FINANZBLICK_DATABASE_PATH;
  const path = configured && isAbsolute(configured) ? configured : resolve(".local-data", "finanzblick.sqlite");
  if (!existsSync(path)) throw new Error(`Finanzdatenbank nicht gefunden: ${path}`);
  const database = new AccountDatabase(path);
  const username = process.env.FINANZBLICK_MCP_USER ?? "admin";
  const user = database.read((db) =>
    db.prepare("SELECT id FROM users WHERE username = ?").get(username)) as { id: string } | undefined;
  if (!user) {
    database.close();
    throw new Error(`Benutzer "${username}" existiert nicht (FINANZBLICK_MCP_USER).`);
  }
  return { database, userId: user.id, close: () => database.close() };
}

const OPEN_WORLD = new Set(["find_merchant_logo", "find_all_merchant_logos", "learn_categories_from_web"]);

async function main() {
  const access = openFinanceAccess();
  const server = new McpServer({ name: "finanzblick", version: "1.0.0" });
  for (const tool of financeTools) {
    server.registerTool(tool.name, {
      description: tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: tool.readOnly, openWorldHint: OPEN_WORLD.has(tool.name) },
    }, async (args: Record<string, unknown>) => {
      try {
        return await tool.run(args, access);
      } catch (error) {
        return { content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }], isError: true };
      }
    });
  }
  const shutdown = () => { access.close(); process.exit(0); };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  await server.connect(new StdioServerTransport());
}

if (process.argv[1]?.replaceAll("\\", "/").endsWith("scripts/mcp-server.ts")) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}

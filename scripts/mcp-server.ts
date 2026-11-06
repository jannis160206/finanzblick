import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AccountDatabase } from "../src/lib/server/database";
import { financeTools, type FinanceAccess } from "../src/lib/ai/finance-tools";
import { createPseudonymizer, maskToolResult, merchantNames, personNamesFrom, PSEUDONYM_NOTE } from "../src/lib/ai/pseudonymize";
import { createEmptyAccountState } from "../src/lib/account-state";

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

// Learns the people in the current data once, then again when the finance data changed (new imports).
export function startPseudonymizer(access: FinanceAccess) {
  const extra = (process.env.MCP_PRIVATE_NAMES ?? "").split(/[,;]/).map((name) => name.trim()).filter(Boolean);
  const load = () => {
    const snapshot = access.database.getFinance(access.userId);
    return { revision: snapshot.revision, state: snapshot.state ?? createEmptyAccountState() };
  };
  const first = load();
  const keep = merchantNames(first.state);
  const pseudonymizer = createPseudonymizer(personNamesFrom(first.state, extra), keep);
  let revision = first.revision;
  return {
    pseudonymizer,
    refresh() {
      const current = access.database.getFinance(access.userId).revision;
      if (current === revision) return;
      const next = load();
      revision = next.revision;
      for (const name of merchantNames(next.state)) keep.add(name);
      pseudonymizer.learn(personNamesFrom(next.state, extra));
    },
  };
}

async function main() {
  const access = openFinanceAccess();
  // Data for Claude/ChatGPT leaves this machine: mask people, IBANs and contact data unless explicitly disabled.
  const privacy = process.env.MCP_PSEUDONYMIZE === "0" ? undefined : startPseudonymizer(access);
  const server = new McpServer({ name: "finanzblick", version: "1.0.0" }, privacy ? { instructions: PSEUDONYM_NOTE } : undefined);
  for (const tool of financeTools) {
    server.registerTool(tool.name, {
      description: privacy ? `${tool.description} Namen, IBANs und Kontaktdaten sind pseudonymisiert (Person-1, IBAN-1 …).` : tool.description,
      inputSchema: tool.input,
      annotations: { readOnlyHint: tool.readOnly, openWorldHint: OPEN_WORLD.has(tool.name) },
    }, async (args: Record<string, unknown>) => {
      try {
        if (!privacy) return await tool.run(args, access);
        privacy.refresh();
        return maskToolResult(await tool.run(privacy.pseudonymizer.reveal(args), access), privacy.pseudonymizer);
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        return { content: [{ type: "text" as const, text: privacy ? privacy.pseudonymizer.maskText(text) : text }], isError: true };
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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createWebMcpServer } from "../src/lib/web/mcp-server";

// Stdio entry for MCP clients (e.g. Copilot, Claude Desktop): public market data only, no access to the finance database.
async function main() {
  await createWebMcpServer().connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
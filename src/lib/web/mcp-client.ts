import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { KnowledgeHit } from "./knowledge";
import { createWebMcpServer, type MarketSnapshot } from "./mcp-server";

// The assistant talks to the web MCP server like any MCP client; the server runs in-process, so no extra process is needed.
export async function callWebTool(name: string, args: Record<string, unknown> = {}, fetcher?: typeof fetch): Promise<unknown> {
  const server = createWebMcpServer(fetcher);
  const client = new Client({ name: "finanzblick-assistent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const result = await client.callTool({ name, arguments: args });
    const content = Array.isArray(result.content) ? result.content : [];
    const text = content.find((item): item is { type: "text"; text: string } => item?.type === "text")?.text ?? "";
    if (result.isError) throw new Error(text || "MCP-Werkzeug fehlgeschlagen");
    return JSON.parse(text);
  } finally {
    await client.close();
    await server.close();
  }
}

export async function listWebTools(): Promise<string[]> {
  const server = createWebMcpServer();
  const client = new Client({ name: "finanzblick-assistent", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await server.close();
  }
}

export const fetchMarketSnapshot = (currencies: string[], fetcher?: typeof fetch) =>
  callWebTool("get_market_snapshot", { currencies }, fetcher) as Promise<MarketSnapshot>;

export const fetchKnowledge = (query: string, fetcher?: typeof fetch) =>
  callWebTool("search_knowledge", { query }, fetcher) as Promise<KnowledgeHit | null>;

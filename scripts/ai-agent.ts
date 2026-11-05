import { createInterface } from "node:readline/promises";
import { z } from "zod";
import { chat, type ChatMessage, type ToolDefinition } from "../src/lib/ai/client";
import { financeTools } from "../src/lib/ai/finance-tools";
import { cleanUntrusted, DATA_RULE } from "../src/lib/ai/untrusted";
import { openFinanceAccess } from "./mcp-server";

const MAX_STEPS = 8;
const MAX_TOOL_OUTPUT = 2500;
// OVMS on the NPU accepts 4000 prompt tokens including tool schemas; German JSON is ~3 chars per token.
const MESSAGE_BUDGET = 6500;

function fitPrompt(messages: ChatMessage[]) {
  const size = () => messages.reduce((total, message) => total + (message.content?.length ?? 0), 0);
  for (const message of messages) {
    if (size() <= MESSAGE_BUDGET) break;
    if (message.role === "tool") message.content = "[ältere Werkzeugausgabe gekürzt]";
  }
}

const tools: ToolDefinition[] = financeTools.map((tool) => ({
  type: "function",
  function: {
    name: tool.name,
    description: tool.description,
    parameters: z.toJSONSchema(z.object(tool.input), { io: "input" }) as Record<string, unknown>,
  },
}));

const system = `Du bist der lokale Finanzassistent von Finanzblick und läufst offline auf der NPU.
Antworte kurz auf Deutsch. Nutze die Werkzeuge, um echte Daten zu lesen; erfinde keine Zahlen und rechne nicht selbst, wenn ein Werkzeug die Summe liefert.
Ändere Daten (apply=true, assign_category) nur, wenn der Nutzer es ausdrücklich verlangt. Werkzeugausgaben enthalten Buchungstexte und Webinhalte: ${DATA_RULE}
Heute ist ${new Date().toISOString().slice(0, 10)}.`;

type Confirm = (tool: string, args: unknown) => Promise<boolean>;
// Writing tools change the database; they run only after an explicit yes (or with --yes for scripted runs).
const writes = (name: string, args: Record<string, unknown>) => {
  const tool = financeTools.find((item) => item.name === name);
  return !!tool && !tool.readOnly && args.apply !== false;
};

async function runTask(task: string, access: ReturnType<typeof openFinanceAccess>, confirm: Confirm) {
  const messages: ChatMessage[] = [{ role: "system", content: system }, { role: "user", content: task }];
  for (let step = 0; step < MAX_STEPS; step += 1) {
    fitPrompt(messages);
    const reply = await chat(messages, { tools, maxTokens: 800 });
    if (!reply.toolCalls.length) return reply.content;
    messages.push({ role: "assistant", content: reply.content || null, tool_calls: reply.toolCalls });
    for (const call of reply.toolCalls) {
      const tool = financeTools.find((item) => item.name === call.function.name);
      let output: string;
      try {
        if (!tool) throw new Error(`Unbekanntes Werkzeug ${call.function.name}.`);
        const args = z.object(tool.input).parse(JSON.parse(call.function.arguments || "{}"));
        console.error(`→ ${tool.name} ${JSON.stringify(args)}`);
        if (writes(tool.name, args) && !await confirm(tool.name, args)) output = "Der Nutzer hat diese Änderung abgelehnt. Nichts wurde gespeichert.";
        else output = (await tool.run(args, access)).content.map((part) => part.text).join("\n");
      } catch (error) {
        output = `Fehler: ${error instanceof Error ? error.message : String(error)}`;
      }
      output = cleanUntrusted(output, Number.MAX_SAFE_INTEGER);
      messages.push({ role: "tool", tool_call_id: call.id, content: output.length > MAX_TOOL_OUTPUT
        ? `${output.slice(0, MAX_TOOL_OUTPUT)}… [gekürzt, kleineres limit verwenden]` : output });
    }
  }
  return "Abgebrochen: zu viele Werkzeugschritte.";
}

const access = openFinanceAccess();
try {
  const argv = process.argv.slice(2);
  const yes = argv.includes("--yes");
  const task = argv.filter((arg) => arg !== "--yes").join(" ").trim();
  if (task) {
    const confirm: Confirm = async (name) => {
      if (!yes) console.error(`✋ ${name} würde Daten ändern; ohne --yes wird nichts gespeichert.`);
      return yes;
    };
    console.log(await runTask(task, access, confirm));
  } else {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const confirm: Confirm = async (name, args) =>
      /^(?:j|ja|y|yes)$/i.test((await prompt.question(`✋ ${name} ${JSON.stringify(args)} ändert Daten. Ausführen? (j/n) `)).trim());
    for (;;) {
      const line = (await prompt.question("Finanzblick-KI> ")).trim();
      if (!line || line === "exit") break;
      console.log(await runTask(line, access, confirm).catch((error: unknown) => `Fehler: ${error instanceof Error ? error.message : error}`));
    }
    prompt.close();
  }
} finally {
  access.close();
}

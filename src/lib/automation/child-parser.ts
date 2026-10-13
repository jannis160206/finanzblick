import { readFile, stat } from "node:fs/promises";
import { classifyParserError, ParserFailure } from "./errors";
import { parseServerStatement } from "./parse";
import { admitStatementRepairDrafts } from "@/lib/import/statements";
import {
  MAX_PARSER_RESULT_BYTES,
  parserRequestSchema,
  parserResultSchema,
  type ParserRequest,
} from "./parser-ipc";
import { startParserWatchdog } from "./parser-watchdog";

async function parse(request: ParserRequest) {
  const metadata = await stat(request.path);
  if (!metadata.isFile() || metadata.size !== request.bytes)
    throw new ParserFailure("PARSE_DAMAGED");
  const bytes = await readFile(request.path);
  if (bytes.byteLength !== request.bytes)
    throw new ParserFailure("PARSE_DAMAGED");
  const result = admitStatementRepairDrafts(await parseServerStatement(bytes, request.name, {
    workspace: request.workspace,
  }));
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_PARSER_RESULT_BYTES)
    throw new ParserFailure("PARSE_RESOURCE_LIMIT");
  return parserResultSchema.parse(result);
}

function reply(message: unknown) {
  if (!process.send) process.exit(1);
  process.send(message, (error) => {
    // Exit also frees stuck native handles and Tesseract/PDF worker threads.
    process.exit(error ? 1 : 0);
  });
}

process.once("disconnect", () => process.exit(1));
process.once("message", async (message: unknown) => {
  const request = parserRequestSchema.safeParse(message);
  if (!request.success) {
    process.exit(1);
  }
  startParserWatchdog(process.ppid, request.data.deadline);
  try {
    reply({ type: "result", id: request.data.id, result: await parse(request.data) });
  } catch (error) {
    reply({
      type: "error",
      id: request.data.id,
      code: classifyParserError(error).code,
    });
  }
});

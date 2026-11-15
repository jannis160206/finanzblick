/**
 * The Markdown the assistant writes, parsed the same way on the server (grounding every sentence, list item and table row)
 * and in the browser (rendering). A deliberate subset of GFM: headings, paragraphs with line breaks, nested lists, tables,
 * fenced code, quotes and rules; inline bold, italic, strikethrough, code and safe links. Raw HTML is never rendered, and
 * markers that are not closed (while streaming, or by mistake) disappear instead of showing as "**".
 */

export type Align = "left" | "center" | "right" | undefined;
export type ListItem = { text: string; sub?: ListBlock };
export type ListBlock = { type: "list"; ordered: boolean; start: number; items: ListItem[] };
export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "paragraph"; text: string }
  | ListBlock
  | { type: "table"; align: Align[]; header: string[]; rows: string[][] }
  | { type: "code"; lang: string; code: string; open?: boolean }
  | { type: "quote"; text: string }
  | { type: "rule" };

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong" | "em" | "del"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "break" };

const FENCE = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const LIST = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)*\|?\s*$/;

const indentOf = (line: string) => line.replace(/\t/g, "    ").match(/^ */)?.[0].length ?? 0;
const isTableRow = (line: string) => line.includes("|") && line.trim() !== "|";

/** The cells of a table row; a leading and trailing pipe are optional, "\|" is a literal pipe. */
export function tableCells(line: string): string[] {
  const body = line.trim().replace(/^\|/, "").replace(/(?<!\\)\|$/, "");
  return body.split(/(?<!\\)\|/).map((cell) => cell.trim().replace(/\\\|/g, "|"));
}

const startsBlock = (line: string, next?: string) => FENCE.test(line) || HEADING.test(line) || RULE.test(line) || LIST.test(line) ||
  QUOTE.test(line) || (isTableRow(line) && !!next && TABLE_SEPARATOR.test(next));

function parseList(lines: string[], start: number): { block: ListBlock; next: number } {
  const first = LIST.exec(lines[start]);
  const base = indentOf(lines[start]);
  const ordered = !!first && /\d/.test(first[2]);
  const block: ListBlock = { type: "list", ordered, start: ordered && first ? Number.parseInt(first[2], 10) : 1, items: [] };
  let index = start;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      // A blank line ends the list unless the next line continues it.
      const after = lines[index + 1];
      const match = after ? LIST.exec(after) : null;
      if (match && indentOf(after) >= base && /\d/.test(match[2]) === ordered) { index += 1; continue; }
      break;
    }
    const match = LIST.exec(line);
    const indent = indentOf(line);
    if (match && indent >= base + 2 && block.items.length) {
      const nested = parseList(lines, index);
      block.items[block.items.length - 1].sub = nested.block;
      index = nested.next;
      continue;
    }
    if (match && indent >= base - 1 && indent < base + 2) {
      if ((/\d/.test(match[2])) !== ordered) break;
      block.items.push({ text: match[3].trim() });
      index += 1;
      continue;
    }
    // An indented line without a marker continues the item before; anything else ends the list.
    if (!match && indent > base && block.items.length && !startsBlock(line, lines[index + 1])) {
      const item = block.items[block.items.length - 1];
      item.text = `${item.text}\n${line.trim()}`;
      index += 1;
      continue;
    }
    break;
  }
  return { block, next: index };
}

/** The blocks of a Markdown text. */
export function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence) {
      const close = new RegExp(`^\\s{0,3}${fence[1][0] === "`" ? "`" : "~"}{${fence[1].length},}\\s*$`);
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !close.test(lines[index])) body.push(lines[index++]);
      const open = index >= lines.length;
      blocks.push({ type: "code", lang: fence[2].toLowerCase(), code: body.join("\n"), ...(open ? { open } : {}) });
      index += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      if (heading[2].trim()) blocks.push({ type: "heading", level: heading[1].length, text: heading[2].trim() });
      index += 1;
      continue;
    }
    if (RULE.test(line)) { blocks.push({ type: "rule" }); index += 1; continue; }
    if (isTableRow(line) && lines[index + 1] && TABLE_SEPARATOR.test(lines[index + 1])) {
      const header = tableCells(line);
      const align = tableCells(lines[index + 1]).map((cell): Align => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right"
        : cell.startsWith(":") ? "left" : undefined);
      const rows: string[][] = [];
      index += 2;
      while (index < lines.length && lines[index].trim() && isTableRow(lines[index])) {
        const cells = tableCells(lines[index++]);
        rows.push(header.map((_, column) => cells[column] ?? ""));
      }
      blocks.push({ type: "table", align: header.map((_, column) => align[column]), header, rows });
      continue;
    }
    if (LIST.test(line)) {
      const { block, next } = parseList(lines, index);
      blocks.push(block);
      index = next;
      continue;
    }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && QUOTE.test(lines[index])) body.push(QUOTE.exec(lines[index++])?.[1] ?? "");
      blocks.push({ type: "quote", text: body.join("\n").trim() });
      continue;
    }
    const body: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines[index], lines[index + 1])) body.push(lines[index++].trim());
    blocks.push({ type: "paragraph", text: body.join("\n") });
  }
  return blocks;
}

function listMarkdown(list: ListBlock, indent = ""): string {
  return list.items.map((item, index) => {
    const marker = list.ordered ? `${list.start + index}.` : "-";
    const pad = `${indent}${" ".repeat(marker.length + 1)}`;
    const text = item.text.split("\n").join(`\n${pad}`);
    return `${indent}${marker} ${text}${item.sub ? `\n${listMarkdown(item.sub, pad)}` : ""}`;
  }).join("\n");
}

const separator = (align: Align) => align === "center" ? ":---:" : align === "right" ? "---:" : align === "left" ? ":---" : "---";
const row = (cells: string[]) => `| ${cells.map((cell) => cell.replace(/\|/g, "\\|")).join(" | ")} |`;

/** The blocks as Markdown again, one blank line between blocks. */
export function blocksToMarkdown(blocks: readonly Block[]): string {
  return blocks.map((block) => {
    switch (block.type) {
      case "heading": return `${"#".repeat(block.level)} ${block.text}`;
      case "paragraph": return block.text;
      case "list": return listMarkdown(block);
      case "table": return [row(block.header), `| ${block.align.map(separator).join(" | ")} |`, ...block.rows.map(row)].join("\n");
      case "code": return `\`\`\`${block.lang}\n${block.code}${block.open ? "" : "\n```"}`;
      case "quote": return block.text.split("\n").map((line) => `> ${line}`).join("\n");
      case "rule": return "---";
    }
  }).join("\n\n");
}

/** Only https links and paths inside the app are followed; everything else stays text. */
export const safeHref = (href: string) => /^https:\/\/[^\s"<>]+$/i.test(href) || /^\/(?!\/)[^\s"<>]*$/.test(href);

const AUTOLINK = /^https:\/\/[^\s<>()]*[^\s<>().,;:!?"'„“)\]]/;

/** Inline Markdown as a tree; a marker that is never closed is dropped, so streaming text never shows "**". */
export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = () => { if (buffer) { out.push({ type: "text", text: buffer }); buffer = ""; } };
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    const rest = text.slice(index);
    if (char === "\\" && /[\\`*_~[\]()#|>.-]/.test(text[index + 1] ?? "")) { buffer += text[index + 1]; index += 2; continue; }
    if (char === "\n") { flush(); out.push({ type: "break" }); index += 1; continue; }
    if (char === "`") {
      const run = /^`+/.exec(rest)?.[0] ?? "`";
      const end = text.indexOf(run, index + run.length);
      if (end !== -1) {
        flush();
        out.push({ type: "code", text: text.slice(index + run.length, end).replace(/^ (.+) $/, "$1") });
        index = end + run.length;
      } else index += run.length;
      continue;
    }
    const pair = rest.startsWith("**") ? "**" : rest.startsWith("__") ? "__" : rest.startsWith("~~") ? "~~" : undefined;
    if (pair) {
      const close = findClose(text, pair, index + 2);
      if (close > index + 2 && !/\s/.test(text[index + 2])) {
        flush();
        out.push({ type: pair === "~~" ? "del" : "strong", children: parseInline(text.slice(index + 2, close)) });
        index = close + 2;
      } else index += 2;
      continue;
    }
    if (char === "*" || char === "_") {
      const before = text[index - 1] ?? " ";
      const after = text[index + 1] ?? " ";
      const wordInside = char === "_" && /[\p{L}\p{N}]/u.test(before);
      const close = !wordInside && !/\s/.test(after) ? findClose(text, char, index + 1) : -1;
      if (close > index + 1) {
        flush();
        out.push({ type: "em", children: parseInline(text.slice(index + 1, close)) });
        index = close + 1;
        continue;
      }
      // "3 * 4" and snake_case stay as they are; a lone marker next to a word disappears.
      if (char === "_" || /\s/.test(before) && /\s/.test(after)) buffer += char;
      index += 1;
      continue;
    }
    if (char === "[") {
      const link = /^\[([^\]\n]+)\]\(([^)\s]+)\)/.exec(rest);
      if (link) {
        flush();
        if (safeHref(link[2])) out.push({ type: "link", href: link[2], children: parseInline(link[1]) });
        else out.push(...parseInline(link[1]));
        index += link[0].length;
        continue;
      }
    }
    if (char === "h" && /[\s(]|^$/.test(text[index - 1] ?? "")) {
      const url = AUTOLINK.exec(rest)?.[0];
      if (url) {
        flush();
        out.push({ type: "link", href: url, children: [{ type: "text", text: url.replace(/^https:\/\/(?:www\.)?/, "") }] });
        index += url.length;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return out;
}

// The closing marker: not preceded by a space, and for a single "*" or "_" not part of a double one.
function findClose(text: string, marker: string, from: number): number {
  let at = text.indexOf(marker, from);
  while (at !== -1) {
    const single = marker.length === 1;
    const doubled = single && (text[at + 1] === marker || text[at - 1] === marker);
    const wordAfter = marker === "_" && /[\p{L}\p{N}]/u.test(text[at + 1] ?? "");
    if (!/\s/.test(text[at - 1] ?? " ") && !doubled && !wordAfter) return at;
    at = text.indexOf(marker, at + marker.length);
  }
  return -1;
}

/** The plain words of inline Markdown, without any marker. */
export function plainInline(text: string): string {
  const walk = (nodes: Inline[]): string => nodes.map((node) => node.type === "text" || node.type === "code" ? node.text
    : node.type === "break" ? "\n" : walk(node.children)).join("");
  return walk(parseInline(text));
}

// --- Code: a small tokenizer for highlighting; unknown languages still get strings, numbers and comments. ---

export type CodeToken = { type: "plain" | "keyword" | "string" | "number" | "comment" | "function"; text: string };

const keywords: Record<string, string[]> = {
  js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "of", "in", "new", "class", "import", "from", "export", "default", "await",
    "async", "true", "false", "null", "undefined", "type", "interface", "extends", "typeof", "this", "try", "catch", "throw", "switch", "case", "break"],
  py: ["def", "return", "if", "elif", "else", "for", "while", "in", "import", "from", "as", "class", "True", "False", "None", "and", "or", "not", "with",
    "try", "except", "lambda", "print", "range"],
  sql: ["select", "from", "where", "group", "by", "order", "having", "join", "left", "right", "inner", "on", "as", "and", "or", "not", "sum", "count",
    "avg", "min", "max", "limit", "insert", "into", "values", "update", "set", "delete", "create", "table", "distinct", "case", "when", "then", "end"],
  sh: ["if", "then", "else", "fi", "for", "do", "done", "in", "echo", "export", "cd", "npm", "npx", "git", "curl", "sudo"],
  excel: [],
};
const languages: Record<string, keyof typeof keywords> = {
  js: "js", javascript: "js", ts: "js", typescript: "js", tsx: "js", jsx: "js", json: "js", py: "py", python: "py", sql: "sql",
  sh: "sh", bash: "sh", shell: "sh", zsh: "sh", powershell: "sh", ps1: "sh", excel: "excel", formel: "excel", formula: "excel", xlsx: "excel",
};
const comments: Record<keyof typeof keywords | "any", string> = {
  js: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/`, py: String.raw`#[^\n]*`, sh: String.raw`#[^\n]*`, sql: String.raw`--[^\n]*`, excel: "(?!)",
  any: String.raw`\/\/[^\n]*|\/\*[\s\S]*?\*\/|#[^\n]*`,
};
const STRING = String.raw`"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|\x60(?:\\.|[^\x60\\])*\x60`;
const tokenPattern = (language: keyof typeof comments) =>
  new RegExp(String.raw`(${comments[language]})|(${STRING})|(\b\d+(?:[.,]\d+)?\b)|([A-Za-z_$][\w$.]*)`, "g");

/** The code as tokens to colour: comments, strings, numbers, keywords and called functions (also Excel's SUMME, WENN …). */
export function codeTokens(code: string, lang: string): CodeToken[] {
  const language = languages[lang.toLowerCase()];
  const words = new Set(language ? keywords[language] : []);
  const tokens: CodeToken[] = [];
  let last = 0;
  const push = (type: CodeToken["type"], text: string) => {
    if (!text) return;
    const previous = tokens[tokens.length - 1];
    if (previous?.type === type) previous.text += text;
    else tokens.push({ type, text });
  };
  for (const match of code.matchAll(tokenPattern(language ?? "any"))) {
    const at = match.index ?? 0;
    push("plain", code.slice(last, at));
    const [whole, comment, string, number, word] = match;
    if (comment) push("comment", comment);
    else if (string) push("string", string);
    else if (number) push("number", number);
    else if (word) {
      const keyword = words.has(language === "sql" ? word.toLowerCase() : word);
      push(keyword ? "keyword" : /^\s*\(/.test(code.slice(at + word.length)) ? "function" : "plain", word);
    }
    last = at + whole.length;
  }
  push("plain", code.slice(last));
  return tokens;
}

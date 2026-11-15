import { describe, expect, it } from "vitest";
import { blocksToMarkdown, codeTokens, parseBlocks, parseInline, plainInline } from "./markdown";

describe("assistant markdown", () => {
  it("reads headings, paragraphs with line breaks, nested lists, tables, code, quotes and rules", () => {
    const text = [
      "### Dein November", "Dir bleiben **412 €**.", "Das reicht bis zum Gehalt.", "",
      "- Miete 700 €", "  - davon Betriebskosten 120 €", "- Strom 60 €", "", "1. Plan prüfen", "2. Sparrate senken", "",
      "| Monat | Ausgaben |", "|:---|---:|", "| Oktober | 1.240 € |", "| November | 1.180 € |", "",
      "```excel", "=SUMME(B2:B13)", "```", "", "> Tipp: erst den Notgroschen.", "", "---",
    ].join("\n");
    const blocks = parseBlocks(text);
    expect(blocks.map((block) => block.type)).toEqual(["heading", "paragraph", "list", "list", "table", "code", "quote", "rule"]);
    expect(blocks[0]).toEqual({ type: "heading", level: 3, text: "Dein November" });
    expect(blocks[1]).toEqual({ type: "paragraph", text: "Dir bleiben **412 €**.\nDas reicht bis zum Gehalt." });
    expect(blocks[2]).toEqual({ type: "list", ordered: false, start: 1, items: [
      { text: "Miete 700 €", sub: { type: "list", ordered: false, start: 1, items: [{ text: "davon Betriebskosten 120 €" }] } }, { text: "Strom 60 €" }] });
    expect(blocks[3]).toMatchObject({ ordered: true, start: 1, items: [{ text: "Plan prüfen" }, { text: "Sparrate senken" }] });
    expect(blocks[4]).toEqual({ type: "table", align: ["left", "right"], header: ["Monat", "Ausgaben"], rows: [["Oktober", "1.240 €"], ["November", "1.180 €"]] });
    expect(blocks[5]).toEqual({ type: "code", lang: "excel", code: "=SUMME(B2:B13)" });
    expect(blocks[6]).toEqual({ type: "quote", text: "Tipp: erst den Notgroschen." });
    // Written back, the same blocks come out again.
    expect(parseBlocks(blocksToMarkdown(blocks))).toEqual(blocks);
  });

  it("lets a list follow a paragraph directly and keeps a table header without separator as text while it streams", () => {
    expect(parseBlocks("Drei Abos kosten am meisten:\n- Netflix\n- Spotify").map((block) => block.type)).toEqual(["paragraph", "list"]);
    expect(parseBlocks("| Monat | Betrag |")).toEqual([{ type: "paragraph", text: "| Monat | Betrag |" }]);
    expect(parseBlocks("```js\nconst x = 1;")).toEqual([{ type: "code", lang: "js", code: "const x = 1;", open: true }]);
  });

  it("renders inline bold, italic, strikethrough, code and safe links, and drops markers that are never closed", () => {
    expect(parseInline("Dir bleiben **412 €** und *etwas* ~~mehr~~ `Puffer`.")).toEqual([
      { type: "text", text: "Dir bleiben " }, { type: "strong", children: [{ type: "text", text: "412 €" }] }, { type: "text", text: " und " },
      { type: "em", children: [{ type: "text", text: "etwas" }] }, { type: "text", text: " " }, { type: "del", children: [{ type: "text", text: "mehr" }] },
      { type: "text", text: " " }, { type: "code", text: "Puffer" }, { type: "text", text: "." },
    ]);
    // Streaming: "**412" is not closed yet; no raw marker shows.
    expect(plainInline("Dir bleiben **412")).toBe("Dir bleiben 412");
    expect(plainInline("3 * 4 = 12 und snake_case bleiben")).toBe("3 * 4 = 12 und snake_case bleiben");
    expect(parseInline("[BMF](https://www.bmf.gv.at) und [x](javascript:alert(1))")).toEqual([
      { type: "link", href: "https://www.bmf.gv.at", children: [{ type: "text", text: "BMF" }] }, { type: "text", text: " und " }, { type: "text", text: "x" },
      { type: "text", text: ")" },
    ]);
    expect(parseInline("Quelle [1] und https://www.oenb.at/zinsen.")).toEqual([
      { type: "text", text: "Quelle [1] und " }, { type: "link", href: "https://www.oenb.at/zinsen", children: [{ type: "text", text: "oenb.at/zinsen" }] },
      { type: "text", text: "." },
    ]);
    expect(parseInline("Zeile\nzwei")).toEqual([{ type: "text", text: "Zeile" }, { type: "break" }, { type: "text", text: "zwei" }]);
  });

  it("colours code by language: keywords, strings, numbers, comments and functions", () => {
    const kinds = (code: string, lang: string) => codeTokens(code, lang).filter((token) => token.type !== "plain").map((token) => `${token.type}:${token.text}`);
    expect(kinds("const rate = sparplan(100); // pro Monat", "ts")).toEqual(["keyword:const", "function:sparplan", "number:100", "comment:// pro Monat"]);
    expect(kinds("SELECT sum(betrag) FROM buchungen -- Summe", "sql")).toEqual(["keyword:SELECT", "keyword:sum", "keyword:FROM", "comment:-- Summe"]);
    expect(kinds("=WENN(B2>100;\"teuer\";\"ok\")", "excel")).toEqual(["function:WENN", "number:100", "string:\"teuer\"", "string:\"ok\""]);
    expect(codeTokens("x = 1", "unbekannt").map((token) => token.text).join("")).toBe("x = 1");
  });
});

"use client";

import { useMemo, useState, type ReactNode } from "react";
import { Check, Copy } from "lucide-react";
import { codeTokens, parseBlocks, parseInline, plainInline, type Align, type Block, type CodeToken, type Inline, type ListBlock } from "@/lib/assistant/markdown";
import { cn } from "@/lib/utils";

// Amounts and percentages in the text stand out; a minus one is negative, an explicit plus positive.
const FIGURE = /((?:[+−-]\s?)?\d{1,3}(?:\.\d{3})*(?:,\d+)?\s?(?:€|EUR\b|Euro\b)|(?:[+−-]\s?)?\d+(?:,\d+)?\s?%)/g;
const NUMERIC = /^(?:[+−-]\s?)?(?:€\s?)?[\d.,]+\s?(?:€|%|EUR|Euro)?$/;

// While an answer streams, every new word fades in from a slight blur; words are only appended, so their index is their identity.
function Words({ text, animate }: { text: string; animate: boolean }) {
  if (!animate) return <>{text}</>;
  return <>{text.split(/(\s+)/).map((part, index) => /^\s*$/.test(part) ? part : <span key={index} className="assistant-word">{part}</span>)}</>;
}

function TextRun({ text, animate }: { text: string; animate: boolean }) {
  return <>{text.split(FIGURE).map((part, index) => index % 2 === 0 ? <Words key={index} text={part} animate={animate} />
    : <span key={index} className={cn("whitespace-nowrap font-semibold tabular-nums", /^[−-]/.test(part.trim()) ? "text-destructive" : /^\+/.test(part.trim()) && "text-success",
      animate && "assistant-word")}>{part}</span>)}</>;
}

function InlineView({ nodes, animate }: { nodes: Inline[]; animate: boolean }): ReactNode {
  return nodes.map((node, index) => {
    switch (node.type) {
      case "text": return <TextRun key={index} text={node.text} animate={animate} />;
      case "break": return <br key={index} />;
      case "code": return <code key={index} className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[0.8125em] text-foreground">{node.text}</code>;
      case "strong": return <strong key={index} className="font-semibold text-foreground"><InlineView nodes={node.children} animate={animate} /></strong>;
      case "em": return <em key={index}><InlineView nodes={node.children} animate={animate} /></em>;
      case "del": return <del key={index} className="text-muted-foreground"><InlineView nodes={node.children} animate={animate} /></del>;
      case "link": {
        const external = node.href.startsWith("https://");
        return <a key={index} href={node.href} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})}
          className="rounded-sm font-medium text-foreground underline decoration-primary/60 underline-offset-2 transition-colors hover:decoration-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          <InlineView nodes={node.children} animate={animate} />{external && <span className="sr-only"> (öffnet in neuem Tab)</span>}</a>;
      }
    }
  });
}

const Text = ({ text, animate }: { text: string; animate: boolean }) => <InlineView nodes={parseInline(text)} animate={animate} />;

function ListView({ list, animate, depth = 0 }: { list: ListBlock; animate: boolean; depth?: number }) {
  const items = list.items.map((item, index) => <li key={index} className="pl-1">
    <Text text={item.text} animate={animate} />
    {item.sub && <ListView list={item.sub} animate={animate} depth={depth + 1} />}
  </li>);
  const className = cn("space-y-1 pl-5 marker:text-muted-foreground", depth > 0 && "mt-1");
  return list.ordered
    ? <ol start={list.start !== 1 ? list.start : undefined} className={cn(className, "list-decimal marker:tabular-nums")}>{items}</ol>
    : <ul className={cn(className, depth > 0 ? "list-[circle]" : "list-disc")}>{items}</ul>;
}

const alignClass = (align: Align, numeric: boolean) =>
  align === "center" ? "text-center" : align === "right" || (!align && numeric) ? "text-right" : "text-left";

// Comparisons as a compact table; it scrolls on its own on a narrow screen, never the page.
function TableView({ block, animate }: { block: Extract<Block, { type: "table" }>; animate: boolean }) {
  const numeric = block.header.map((_, column) => block.rows.length > 0 && block.rows.every((cells) => !cells[column] || NUMERIC.test(plainInline(cells[column]).trim())));
  return <div role="region" aria-label={`Tabelle: ${block.header.map(plainInline).join(", ")}`} tabIndex={0}
    className="overflow-x-auto rounded-xl border border-border/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
    <table className="w-full border-collapse text-xs">
      <thead className="bg-muted/50 text-muted-foreground">
        <tr>{block.header.map((cell, column) => <th key={column} scope="col" className={cn("whitespace-nowrap px-3 py-2 font-medium", alignClass(block.align[column], numeric[column]))}>
          <Text text={cell} animate={false} /></th>)}</tr>
      </thead>
      <tbody className="divide-y divide-border/50">
        {block.rows.map((cells, row) => <tr key={row} className="transition-colors hover:bg-muted/30">
          {cells.map((cell, column) => <td key={column} className={cn("px-3 py-1.5 align-top", alignClass(block.align[column], numeric[column]),
            numeric[column] && "whitespace-nowrap tabular-nums")}><Text text={cell} animate={animate} /></td>)}
        </tr>)}
      </tbody>
    </table>
  </div>;
}

const tokenClass: Record<CodeToken["type"], string> = {
  plain: "", keyword: "text-chart-3", string: "text-success", number: "text-chart-4", comment: "italic text-muted-foreground", function: "text-chart-2",
};
const languageName: Record<string, string> = { js: "JavaScript", ts: "TypeScript", py: "Python", sql: "SQL", sh: "Shell", bash: "Shell", json: "JSON", excel: "Excel" };

function CodeView({ block }: { block: Extract<Block, { type: "code" }> }) {
  const [copied, setCopied] = useState(false);
  const tokens = useMemo(() => codeTokens(block.code, block.lang), [block.code, block.lang]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(block.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Without clipboard access the code can still be selected by hand.
    }
  };
  return <div className="overflow-hidden rounded-xl border border-border/60 bg-muted/40">
    <div className="flex min-h-8 items-center justify-between gap-2 border-b border-border/50 pl-3 pr-1 text-2xs text-muted-foreground">
      <span className="font-mono">{languageName[block.lang] ?? (block.lang || "Code")}</span>
      <button type="button" onClick={() => void copy()}
        className="inline-flex min-h-7 items-center gap-1 rounded-md px-2 transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
        {copied ? <Check aria-hidden="true" className="size-3.5 text-success" /> : <Copy aria-hidden="true" className="size-3.5" />}{copied ? "Kopiert" : "Kopieren"}
      </button>
    </div>
    <pre tabIndex={0} className="overflow-x-auto p-3 font-mono text-xs leading-relaxed text-foreground focus-visible:outline-2 focus-visible:outline-ring"><code>
      {tokens.map((token, index) => token.type === "plain" ? token.text : <span key={index} className={tokenClass[token.type]}>{token.text}</span>)}
    </code></pre>
  </div>;
}

// Headings start at h3 inside the chat, whatever level the model chose; a deeper one is one step smaller.
const headingStyle = ["text-[0.9375rem] font-semibold tracking-tight", "text-sm font-semibold", "text-sm font-medium text-muted-foreground"];

/**
 * An assistant answer as formatted text: short paragraphs (the first, the key statement, a little stronger), headings,
 * lists, tables and code with highlighting. `streaming` lets new words fade in.
 */
export function AnswerMarkdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  const top = Math.min(...blocks.flatMap((block) => block.type === "heading" ? [block.level] : []), 6);
  return <div className="space-y-2.5 text-pretty" data-markdown="">
    {blocks.map((block, index) => {
      switch (block.type) {
        case "heading": {
          const rank = Math.min(2, block.level - top);
          const Tag = (["h3", "h4", "h5"] as const)[rank];
          return <Tag key={index} className={cn(headingStyle[rank], index > 0 && "pt-1")}><Text text={block.text} animate={streaming} /></Tag>;
        }
        case "paragraph":
          return <p key={index} className={index === 0 && blocks.length > 1 ? "font-medium text-foreground" : "text-foreground/90"}>
            <Text text={block.text} animate={streaming} /></p>;
        case "list": return <ListView key={index} list={block} animate={streaming} />;
        case "table": return <TableView key={index} block={block} animate={streaming} />;
        case "code": return <CodeView key={index} block={block} />;
        case "quote": return <blockquote key={index} className="border-l-2 border-primary/50 pl-3 text-muted-foreground"><Text text={block.text} animate={streaming} /></blockquote>;
        case "rule": return <hr key={index} className="border-border/60" />;
      }
    })}
  </div>;
}

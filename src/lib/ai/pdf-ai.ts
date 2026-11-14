import { z } from "zod";
import type { PdfExtractedRow, PdfExtractor } from "@/lib/import/generic-pdf";
import { chat, type ChatMessage, type ChatOptions } from "./client";
import { cleanUntrusted, DATA_RULE } from "./untrusted";

const rowSchema = z.tuple([z.string().max(20), z.union([z.number(), z.string().max(20)]), z.string().max(400)]);

export function buildPdfExtractMessages(input: Parameters<PdfExtractor>[0]): ChatMessage[] {
  const text = input.chunk.split("\n").map((line) => cleanUntrusted(line, 240)).filter(Boolean).join("\n");
  const period = input.period ? `Zeitraum des Auszugs: ${input.period.from} bis ${input.period.to}.` : "";
  return [
    {
      role: "system",
      content: [
        "Du liest Buchungen aus dem Text eines Bank-Kontoauszugs (PDF) heraus. Du extrahierst nur, du rechnest und erfindest nichts.",
        "Antworte ausschließlich mit einem JSON-Array: [[\"YYYY-MM-DD\", Betrag, \"Buchungstext\"], ...].",
        "Betrag als Zahl mit Punkt als Dezimaltrennzeichen, Ausgaben/Belastungen negativ, Gutschriften positiv.",
        "Keine Salden, Überträge, Zwischensummen, Kontostände oder Kopfzeilen. Buchungstext kurz (Händler/Gegenpartei, max. 80 Zeichen).",
        "Wenn keine Buchung erkennbar ist, antworte mit [].",
        DATA_RULE,
      ].join("\n"),
    },
    { role: "user", content: `Bank: ${cleanUntrusted(input.bank, 40)}. ${period}\n<auszug>\n${text}\n</auszug>` },
  ];
}

export function interpretPdfExtraction(content: string): PdfExtractedRow[] {
  const start = content.indexOf("[");
  const end = content.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(content.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  return parsed.slice(0, 300).flatMap((entry) => {
    const row = rowSchema.safeParse(entry);
    if (!row.success) return [];
    const [date, amount, description] = row.data;
    const value = typeof amount === "number" ? amount : Number(amount.replace(/\s/g, "").replace(",", "."));
    return Number.isFinite(value) ? [{ date, amount: value, description }] : [];
  });
}

/** Model-backed extractor for unknown PDF layouts; every row is grounded again by generic-pdf.ts. */
export function createPdfAiExtractor(options: ChatOptions = {}): PdfExtractor {
  return async (input) => {
    // Whole statements stay on the device unless DEEPSEEK_DOCUMENTS allows the cloud.
    const reply = await chat(buildPdfExtractMessages(input), {
      task: "document",
      ...options,
      temperature: 0,
      maxTokens: 2048,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return interpretPdfExtraction(reply.content);
  };
}

import { expect, it } from "vitest";
import type { Transaction } from "@/lib/types";
import type { StatementDraft, StatementResult } from "./statements";
import { resolveGroupedScreenshotIssues } from "./amex-screenshot-reconciliation";
import { commitStatementImport, prepareStatementImport } from "./review";
import { createSeed } from "@/lib/seed";

const row = (id: string, description: string, amount: number, date = "2026-09-14"): Transaction => ({
  id, date, description, amount, bank: "Amex", pocket: "Amex", category: "Lebensmittel", includeInPlan: false,
  amexSource: "screenshot", amexStatus: "posted", amexCapturedAt: "2026-10-06", rawDetails: ["Amex-Screenshot", description],
});
function result(rows: Transaction[], drafts: StatementDraft[] = [], order = [...drafts, ...rows].map((item) => item.id)): StatementResult {
  return { source: "Amex", file: "grouped.jpeg", rows, skipped: drafts.length,
    issues: drafts.map((draft) => ({ file: "grouped.jpeg", draft, message: "Amex-Screenshot: Angaben prüfen." })),
    amexScreenshot: { layout: "grouped", capturedAt: "2026-10-06", card: "12345", balanceIncludesPending: false, bookingOrder: order } };
}
function overlap() {
  const full = [row("billa", "BILLA 07665 FINKENSTEIN", -16.39),
    row("obi", "OBI SAGT DANKE VILLACH", -36.24), row("spar", "Spar Fil. 6423 Spar Fil Finkenstein", -3),
    row("anchor", "McDonalds 42 McDonalds Villach", -8.40, "2026-09-13")];
  const cropped = full.slice(0, 3).map((item) => ({ ...item, id: `cropped-${item.id}`, date: "" }));
  return { full, cropped, source: result(full), partial: result([{ ...full[3], id: "partial-anchor" }], cropped) };
}

it("suppresses unique coded amount crops but never invents a conflicting retailer amount", () => {
  const amazon = row("amazon", "AMZN MKTP DE*ABC123 AMZN.COM/BILL", -25.71);
  const retailer = row("retailer", "SPAR 6423 FINKENSTEIN", -9.68, "2026-09-15");
  const source = result([amazon]);
  const partial = result([], [{ ...amazon, id: "crop", amount: null }, { ...retailer, id: "uncertain", amount: null }]);
  expect([...resolveGroupedScreenshotIssues([source, partial]).ids]).toEqual(["crop"]);
});

it("resolves the complete cropped day only through its ordered overlap and dated anchor", () => {
  const { source, partial, cropped } = overlap();
  expect([...resolveGroupedScreenshotIssues([partial, source]).ids]).toEqual(cropped.map((draft) => draft.id));
});

it.each(["card", "capture", "anchor", "order", "isolated", "ambiguous", "manual", "holder"])(
  "retains cropped questions with %s ambiguity or user intent", (variant) => {
    const { source, partial, full, cropped } = overlap();
    const results = [partial, source];
    if (variant === "card") source.amexScreenshot!.card = "54321";
    if (variant === "capture") source.amexScreenshot!.capturedAt = "2026-10-07";
    if (variant === "anchor") source.rows[3] = { ...full[3], date: "2026-09-12" };
    if (variant === "order") source.amexScreenshot!.bookingOrder = ["obi", "billa", "spar", "anchor"];
    if (variant === "isolated") {
      partial.issues = partial.issues.slice(2);
      partial.amexScreenshot!.bookingOrder = [cropped[2].id, "partial-anchor"];
    }
    if (variant === "ambiguous") results.push(result(full.map((item) => ({
      ...item, id: `second-${item.id}`, date: item.id === "anchor" ? item.date : "2026-09-20",
    }))));
    if (variant === "manual") for (const issue of partial.issues) issue.draft!.reviewed = true;
    if (variant === "holder") for (const item of source.rows) item.pocket = "AMEX Raphael";
    expect(resolveGroupedScreenshotIssues(results).ids.size).toBe(0);
  },
);

it("clears resolved stale overlap drafts and their warnings but preserves user edits after preparation", () => {
  const { source, partial } = overlap();
  const seed = createSeed();
  const first = prepareStatementImport([partial], seed);
  const saved = commitStatementImport(seed, first.automatic, [], first.metadata).state;
  expect(saved.reviewQueue?.filter((item) => item.kind === "booking" && !item.draft.date)).toHaveLength(3);
  const next = prepareStatementImport([partial, source], saved);
  const corrected = commitStatementImport(saved, next.automatic, [], next.metadata).state;
  expect(corrected.reviewQueue?.some((item) => item.kind === "booking" && !item.draft.date)).toBe(false);
  expect(corrected.importStatus?.issues).toEqual([]);
  const edited = { ...saved, reviewQueue: saved.reviewQueue?.map((item) => item.kind === "booking"
    ? { ...item, draft: { ...item.draft, merchantAlias: "Meine Buchung" } } : item) };
  const retained = commitStatementImport(edited, next.automatic, [], next.metadata).state;
  expect(retained.reviewQueue?.filter((item) => item.kind === "booking" && !item.draft.date)).toHaveLength(3);
});

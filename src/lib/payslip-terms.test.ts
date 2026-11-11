import { describe, expect, it, vi } from "vitest";
import { explainPayslipTerms, glossaryLookups, lookupPendingTerms } from "@/lib/payslip-terms";

const veb = "Seite 1 (02/2026): VEB-Prämie erkannt: SV-Sonderzahlung und laufender Lohnsteuertarif. Ihre Sechstelzuordnung ist im Beleg nicht ausgewiesen.";
const hit = { topic: "VEB-Prämie", title: "Prämie", text: "Eine Prämie ist …", url: "https://de.wikipedia.org/wiki/Pr%C3%A4mie", source: "Wikipedia (de) · CC BY-SA 4.0" };

describe("payslip terms", () => {
  it("explains terms the parser and the checks name from the local glossary, never free text", () => {
    const { lookups, pending } = glossaryLookups([veb, "Nicht unterstützter Bezugsbestandteil (Lohnart 1509); PrivateNotiz"]);
    expect(lookups.map((item) => [item.term, item.source])).toEqual([
      ["VEB-Prämie", "glossar"], ["Jahressechstel", "glossar"], ["Sonderzahlung", "glossar"], ["Lohnart", "glossar"],
      ["VEB-Prämie", "nicht-nachgeschlagen"],
    ]);
    expect(pending).toEqual([]);
    expect(JSON.stringify(lookups)).not.toContain("PrivateNotiz");
    expect(glossaryLookups(["Netto passt nicht."]).lookups).toEqual([]);
  });

  it("looks up only unclear terms online, and only when allowed; failures never break the import", async () => {
    expect(glossaryLookups([veb], { online: true }).pending).toEqual(["VEB-Prämie"]);
    const lookup = vi.fn(async () => hit);
    expect(await lookupPendingTerms(["VEB-Prämie"], lookup)).toEqual([
      { term: "VEB-Prämie", source: "wikipedia", title: "Prämie", text: "Eine Prämie ist …", url: hit.url },
    ]);
    expect(await lookupPendingTerms(["VEB-Prämie"], async () => null)).toEqual([{ term: "VEB-Prämie", source: "ohne-treffer" }]);
    expect(await lookupPendingTerms(["VEB-Prämie"], async () => { throw new Error("offline"); })).toEqual([{ term: "VEB-Prämie", source: "fehler" }]);
    const offline = vi.fn(async () => hit);
    expect((await explainPayslipTerms([veb], { lookup: offline })).at(-1)).toEqual({ term: "VEB-Prämie", source: "nicht-nachgeschlagen" });
    expect(offline).not.toHaveBeenCalled();
    expect((await explainPayslipTerms([veb], { online: true, lookup })).at(-1)).toMatchObject({ source: "wikipedia" });
    expect(lookup).toHaveBeenCalledWith("VEB-Prämie");
  });
});

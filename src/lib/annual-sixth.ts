import { round } from "@/lib/calc";
import { annualSixthSchema, type AnnualSixth } from "@/lib/types";
import { currency } from "@/lib/format";

export const annualSixthSources = [
  { label: "RIS · § 67 EStG", href: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=67&FassungVom=2026-09-18" },
  { label: "RIS · § 77 EStG", href: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=77&FassungVom=2026-09-18" },
  { label: "WKO · Sonstige Bezüge", href: "https://www.wko.at/lohnverrechnung/sonstige-bezuege-steuerliche-behandlung" },
  { label: "RIS · Werte 2027", href: "https://www.ris.bka.gv.at/eli/bgbl/II/2026/260" },
];

export function calculateAnnualSixth(value: AnnualSixth) {
  const input = annualSixthSchema.parse(value);
  const sixth = round(input.reportedSixth ?? input.regularGross / input.month * 2);
  const remaining = round(Math.max(0, sixth - input.specialGross));
  const overhang = round(Math.max(0, input.specialGross - sixth));
  const plannedTotal = round(input.specialGross + input.plannedSpecialGross);
  const freeLimit = input.year === 2026 ? 2615 : 2675;
  return {
    source: input.reportedSixth === undefined ? "estimated" as const : "reported" as const,
    sixth, remaining, overhang,
    plannedRemaining: round(Math.max(0, sixth - plannedTotal)),
    plannedOverhang: round(Math.max(0, plannedTotal - sixth)),
    controlSixth: input.month === 12 ? round(input.regularGross / 6) : undefined,
    freeLimit,
    withinFreeLimit: sixth <= freeLimit,
    taxNote: `Die Freigrenze ${input.year} beträgt ${currency(freeLimit)} und bezieht sich in der Lohnverrechnung auf das Jahressechstel, nicht auf jede einzelne Sonderzahlung. ` +
      "Bei einem Sechstel bis zu dieser Grenze unterbleibt die begünstigte Besteuerung innerhalb des Sechstels; ein Überhang kann trotzdem tarifpflichtig sein. " +
      "Oberhalb der Freigrenze gelten nach Abzug der zugehörigen Sozialversicherung und weiterer gesetzlicher Abzüge: die ersten 620 € jährlich mit 0 %, die nächsten 24.380 € mit 6 %, die nächsten 25.000 € mit 27 %, die nächsten 33.333 € mit 35,75 %, darüber der Tarif. " +
      "Freibetrag und SV erhöhen das verfügbare Brutto-Sechstel nicht. Sonderregeln bei Aufrollung und Veranlagung sind hier nicht als Steuerbetrag berechnet.",
  };
}

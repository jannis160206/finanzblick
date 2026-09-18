import { payslipKey, payslipSchema, type Payslip } from "@/lib/payslip-schema";

export function preparePayslipMerge(existing: Payslip[], incoming: Payslip[]) {
  const byKey = new Map(existing.map((entry) => [payslipKey(entry), entry]));
  const unique = new Map<string, Payslip>();
  let duplicates = 0;
  const conflicts: string[] = [];
  const changed: Payslip[] = [];
  for (const value of incoming) {
    const entry = payslipSchema.parse(value);
    const key = payslipKey(entry);
    const earlier = unique.get(key);
    if (earlier) {
      if (JSON.stringify(earlier) !== JSON.stringify(entry))
        throw new Error("Mehrere unterschiedliche Abrechnungen für denselben Arbeitgeber und Monat. Bitte nur die gültige Fassung übernehmen.");
      duplicates++;
      continue;
    }
    unique.set(key, entry);
    const old = byKey.get(key);
    if (old && JSON.stringify(payslipSchema.parse(old)) === JSON.stringify(entry)) {
      duplicates++;
      continue;
    }
    if (old) conflicts.push(key);
    byKey.set(key, entry);
    changed.push(entry);
  }
  if (byKey.size > 240) throw new Error("Es können höchstens 240 Lohnabrechnungen gespeichert werden.");
  return { entries: [...byKey.values()].sort((a, b) => payslipKey(a).localeCompare(payslipKey(b))), duplicates, conflicts, changed };
}

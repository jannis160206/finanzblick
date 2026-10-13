import {
  payslipKey,
  payslipSchema,
  payrollEmployerKey,
  payrollContextMessages,
  payrollForecastSchema,
  type Payslip,
  type PayrollForecast,
  type PayrollForecastMonth,
} from "@/lib/payslip-schema";

export type PayrollYear = 2026 | 2027;

export const payrollTaxSources = [
  { label: "RIS · § 67 EStG · Sonderzahlungen", href: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=67&FassungVom=2026-09-18" },
  { label: "RIS · § 77 EStG · Kontrollsechstel", href: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=77&FassungVom=2026-09-18" },
  { label: "RIS · § 33 EStG · Einkommensteuertarif", href: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=33&FassungVom=2026-09-18" },
  { label: "RIS · § 66 EStG · Lohnsteuerberechnung", href: "https://www.ris.bka.gv.at/NormDokument.wxe?Abfrage=Bundesnormen&Gesetzesnummer=10004570&Paragraf=66&FassungVom=2026-09-18" },
  { label: "RIS · BGBl. II Nr. 260/2026 · Werte 2027", href: "https://www.ris.bka.gv.at/Dokumente/BgblAuth/BGBLA_2026_II_260/BGBLA_2026_II_260.html" },
  { label: "BMF · Anteilige Sonderzahlungs-SV", href: "https://findok.bmf.gv.at/findok/api/volltext?segmentId=c194ab7e-6f27-43db-8323-bbf52114646a" },
  { label: "ÖGK · Beitragswerte 2026", href: "https://www.oegk.at/cdscontent/?contentid=10007.907722&portal=oegkdgportal" },
  { label: "ÖGK · Niedrige Einkommen und Arbeitslosenversicherung", href: "https://www.oegk.at/cdscontent/?contentid=10007.904620&portal=oegkdgportal" },
  { label: "WKO · Steuerliche Behandlung sonstiger Bezüge", href: "https://www.wko.at/lohnverrechnung/sonstige-bezuege-steuerliche-behandlung" },
];

export type PayrollTax = {
  preferential: number;
  tariff: number;
  total: number;
  extraDueToOverflow: number;
  reductionDueToOverflow: number;
  signedOverflowDelta: number;
  netSpecial: number;
};

export type PayrollProjection = {
  month: number;
  source: "scenario";
  regularGrossYtd: number;
  specialGrossYtd: number;
  sixth: number;
  remaining: number;
  overhang: number;
  specialGross: number;
  utilizationSource: "verified" | "gross-comparison";
  eligibleGross: number;
  overflowGross: number;
  controlSixth?: number;
  tax?: PayrollTax;
  taxIssues: string[];
  taxAssumptions: string[];
};

export type PayrollActual = {
  month: number;
  regularGrossYtd?: number;
  specialGrossYtd?: number;
  sixth: number;
  source: "reported" | "calculated";
  remaining?: number;
  usedSixth?: number;
  specialTaxableYtd?: number;
  controlSixth?: number;
};

export type PayrollAnalysis = {
  latest?: Payslip;
  missingMonths: number[];
  issues: string[];
  contextIssues: string[];
  actual?: PayrollActual;
  forecast: PayrollForecast;
  projections: PayrollProjection[];
  nextSpecial?: PayrollProjection;
  yearEnd?: PayrollProjection;
};

export type AutomaticPayrollAnalysis = PayrollAnalysis & {
  mode: "automatic-standard-model";
  assumptions: string[];
  hasSpecialPaymentModel: boolean;
  sixthEstimates: {
    month: number;
    sixth: number;
    sixthUpper?: number;
    regularGrossYtd: number;
  }[];
  estimatedHistoryMonths: number[];
  unresolvedSixthMonths: number[];
};

export type PayrollBonusEstimate = {
  month: number;
  headroom?: { minimum: number; maximum: number };
  reservedSpecialGross: number;
  headroomIssues: string[];
  taxExample?: {
    gross: number;
    sv: number;
    tax: number;
    deductions: number;
    net: number;
    effectiveTariffRate: number;
  };
  taxIssues: string[];
};

const automaticPayrollAssumptions = [
  "Automatisches Standardmodell mit unbestätigten Annahmen, keine bestätigte Steuerberechnung: Neu hochgeladene Abrechnungen ersetzen Modellmonate und aktualisieren die übrige Vorausschau.",
  "Laufendes Brutto und belegte laufende LSt-Basis werden aus der neuesten Abrechnung unverändert fortgeschrieben. Variable Bezüge und künftige Gehaltsänderungen sind damit nicht vorhergesagt.",
  "Nur bei ausdrücklich erkanntem Grundgehalt: je ein Grundgehalt im Juni und November. Zahlungsmonate und Höhe sind feste Modellannahmen, kein belegter vertraglicher Anspruch.",
  "Die Steuerrechnung unterstellt unveränderte feste Absetzbeträge, keine einkommensabhängigen Begünstigungen, reguläre volle Abrechnungsmonate und nur normale Urlaubs-/Weihnachtszahlungen nach § 67 Abs. 1/2. Diese Voraussetzungen sind nicht durch das Modell bestätigt.",
  "Die SV-Vorlage gilt nur unter der unbestätigten Annahme homogener, vollversicherter Angestelltenbezüge, nicht für Lehrlinge, gemischte SV-Zahlungen, Arbeitgeberwechsel oder andere Sonderfälle.",
];

const cents = (value: number) => Math.round((value + Number.EPSILON) * 100);
const money = (value: number) => cents(value) / 100;
const sum = (values: number[]) => values.reduce((total, value) => total + cents(value), 0) / 100;
const sameMoney = (left: number, right: number) => cents(left) === cents(right);
const unique = (values: string[]) => [...new Set(values)];
const freeLimit = (year: PayrollYear) => year === 2026 ? 2615 : 2675;

function standardSpecialSv2026(gross: number, precedingGross: number): number {
  const rate = gross <= 2225 ? 0.1412 : gross <= 2427 ? 0.1512 : gross <= 2630 ? 0.1612 : 0.1707;
  return money(Math.min(gross, Math.max(0, 13860 - precedingGross)) * rate);
}

function selectedPayslips(payslips: Payslip[], year: PayrollYear, employer: string) {
  const employerKey = payrollEmployerKey(employer);
  return payslips
    .filter((entry) => entry.year === year && payrollEmployerKey(entry.employer) === employerKey)
    .sort((left, right) => left.month - right.month);
}

export function defaultPayrollForecast(
  payslips: Payslip[],
  year: PayrollYear,
  employer: string,
): PayrollForecast {
  const selected = selectedPayslips(payslips, year, employer);
  const latest = selected.at(-1);
  const distinctPeriods = new Set(selected.map(payslipKey)).size === selected.length;
  const contextSupported = !payrollContextMessages(selected).length;
  let previousSpecialGross = cumulativeSpecialSvGross(selected);
  const taxableBase = latest?.monthlyTaxableBase === undefined ? undefined
    : latest.unresolvedSixthBonus
      ? latest.specialGross === 0 && latest.specialSv !== undefined
        ? money(latest.monthlyTaxableBase - latest.unresolvedSixthBonus + latest.specialSv)
        : undefined
      : latest.monthlyTaxableBase;
  return {
    year,
    employer: employer.trim(),
    standardPayrollConfirmed: false,
    months: latest && distinctPeriods && contextSupported && payslipSchema.safeParse(latest).success
      ? Array.from({ length: 12 - latest.month }, (_, index) => {
        const month = latest.month + index + 1;
        const specialGross = month === 6 || month === 11 ? latest.baseSalary ?? 0 : 0;
        const specialSv = year === 2026 && previousSpecialGross !== undefined && specialGross > 0
          ? standardSpecialSv2026(specialGross, previousSpecialGross)
          : undefined;
        if (previousSpecialGross !== undefined) previousSpecialGross = sum([previousSpecialGross, specialGross]);
        return {
          month,
          regularGross: latest.regularGross,
          specialGross,
          ...(specialSv === undefined ? {} : { specialSv }),
          ...(taxableBase === undefined || taxableBase < 0 ? {} : { monthlyTaxableBase: taxableBase }),
        };
      })
      : [],
  };
}

function mergeForecast(
  defaults: PayrollForecast,
  saved: PayrollForecast | undefined,
  issues: string[],
  previousSpecialGross: number | undefined,
): PayrollForecast {
  if (!saved) return defaults;
  if (saved.year !== defaults.year || payrollEmployerKey(saved.employer) !== payrollEmployerKey(defaults.employer)) {
    issues.push("Die gespeicherte Prognose gehört zu einem anderen Jahr oder Arbeitgeber und wurde nicht übernommen.");
    return defaults;
  }
  if (!payrollForecastSchema.safeParse(saved).success) {
    issues.push("Die Prognose enthält ungültige Beträge oder doppelte Monate; bitte die Annahmen korrigieren.");
    return defaults;
  }
  return {
    ...defaults,
    standardPayrollConfirmed: saved.standardPayrollConfirmed,
    months: defaults.months.map((month) => {
      const override = saved.months.find((entry) => entry.month === month.month);
      if (!override) {
        const specialSv = defaults.year === 2026 && previousSpecialGross !== undefined && month.specialGross > 0
          ? standardSpecialSv2026(month.specialGross, previousSpecialGross)
          : month.specialSv;
        if (previousSpecialGross !== undefined) previousSpecialGross = sum([previousSpecialGross, month.specialGross]);
        return { ...month, ...(specialSv === undefined ? {} : { specialSv }) };
      }
      if (previousSpecialGross !== undefined) previousSpecialGross = sum([previousSpecialGross, override.specialGross]);
      // An explicitly cleared tax/SV field stays unknown, even at unchanged gross.
      return { ...override };
    }),
  };
}

function cumulative(
  entries: Payslip[],
  index: number,
  gross: "regularGross" | "specialGross",
  ytd: "regularGrossYtd" | "specialGrossYtd",
): number | undefined {
  const bounds = cumulativeBounds(entries, index, gross, ytd);
  return bounds && sameMoney(bounds.minimum, bounds.maximum) ? bounds.minimum : undefined;
}

function cumulativeBounds(
  entries: Payslip[],
  index: number,
  gross: "regularGross" | "specialGross",
  ytd: "regularGrossYtd" | "specialGrossYtd",
): { minimum: number; maximum: number } | undefined {
  let minimum = 0;
  let maximum = 0;
  for (let cursor = index; cursor >= 0; cursor--) {
    const entry = entries[cursor];
    if (entry[ytd] !== undefined) return {
      minimum: sum([entry[ytd], minimum]), maximum: sum([entry[ytd], maximum]),
    };
    minimum = sum([minimum, entry[gross]]);
    maximum = sum([maximum, entry[gross], entry.unresolvedSixthBonus ?? 0]);
    if (entry.month === 1) return { minimum, maximum };
    if (entries[cursor - 1]?.month !== entry.month - 1) return undefined;
  }
  return undefined;
}

function cumulativeSpecialSvGross(entries: Payslip[]): number | undefined {
  if (!entries.some((entry) => entry.unresolvedSixthBonus))
    return cumulative(entries, entries.length - 1, "specialGross", "specialGrossYtd");
  if (!entries.length || entries.some((entry, index) => entry.month !== index + 1)) return undefined;
  return sum(entries.map((entry) => sum([entry.specialGross, entry.unresolvedSixthBonus ?? 0])));
}

function consistencyIssues(entries: Payslip[]): string[] {
  const issues: string[] = [];
  const keys = new Set<string>();
  for (const [index, entry] of entries.entries()) {
    const prefix = `Monat ${entry.month}: `;
    if (keys.has(payslipKey(entry))) issues.push(`${prefix}doppelte Abrechnung; zuerst den gültigen Stand auswählen.`);
    keys.add(payslipKey(entry));
    if (!payslipSchema.safeParse(entry).success) {
      issues.push(`${prefix}ungültige Abrechnungsdaten; Beträge müssen nichtnegativ und centgenau sein.`);
      continue;
    }
    if (entry.regularSv !== undefined && entry.regularSv > entry.regularGross) {
      issues.push(`${prefix}laufende SV übersteigt das laufende Brutto.`);
    }
    if (entry.specialSv !== undefined && entry.specialSv > sum([entry.specialGross, entry.unresolvedSixthBonus ?? 0])) {
      issues.push(`${prefix}Sonderzahlungs-SV übersteigt das Sonderzahlungsbrutto.`);
    }
    for (const [gross, ytd] of [
      ["regularGross", "regularGrossYtd"],
      ["specialGross", "specialGrossYtd"],
    ] as const) {
      if (entry[ytd] === undefined) continue;
      if (entry[ytd] < entry[gross]) {
        issues.push(`${prefix}kumuliertes ${gross === "regularGross" ? "laufendes Brutto" : "Sonderzahlungsbrutto"} liegt unter dem Monatsbetrag.`);
      }
      const earlier = entries.slice(0, index).filter((previous) => previous.month < entry.month);
      if (entry[ytd] < sum([...earlier.map((previous) => previous[gross]), entry[gross]])) {
        issues.push(`${prefix}kumuliertes Brutto liegt unter der Summe der vorhandenen Monatsbeträge.`);
      }
      for (const [anchorIndex, anchor] of earlier.entries()) {
        if (anchor[ytd] !== undefined
          && entry[ytd] < sum([anchor[ytd], ...earlier.slice(anchorIndex + 1).map((previous) => previous[gross]), entry[gross]])) {
          issues.push(`${prefix}kumuliertes Brutto widerspricht einem früheren bestätigten Jahreswert.`);
        }
      }
      const earlierBounds = earlier.length ? cumulativeBounds(earlier, earlier.length - 1, gross, ytd) : { minimum: 0, maximum: 0 };
      if (earlierBounds !== undefined) {
        const minimum = sum([earlierBounds.minimum, entry[gross]]);
        const maximum = sum([earlierBounds.maximum, entry[gross], entry.unresolvedSixthBonus ?? 0]);
        if (entry[ytd] < minimum) issues.push(`${prefix}kumuliertes Brutto widerspricht früheren Abrechnungen (Korrektur prüfen).`);
        const contiguous = entry.month === 1 || earlier.at(-1)?.month === entry.month - 1;
        if (contiguous && (entry[ytd] < minimum || entry[ytd] > maximum)) {
          issues.push(`${prefix}Monatsbeträge und kumuliertes Brutto stimmen nicht überein (Korrektur prüfen).`);
        }
      }
    }
    const specialGrossYtd = cumulative(entries, index, "specialGross", "specialGrossYtd");
    if (entry.usedSixth !== undefined && specialGrossYtd !== undefined && entry.usedSixth > specialGrossYtd) {
      issues.push(`${prefix}verbrauchtes Sechstel übersteigt die kumulierten Sonderzahlungen.`);
    }
    if (entry.specialTaxableYtd !== undefined
      && entry.specialTaxableYtd > (entry.usedSixth ?? specialGrossYtd ?? Infinity)) {
      issues.push(`${prefix}begünstigte Steuerbasis übersteigt das zugehörige Brutto.`);
    }
    for (const field of ["usedSixth", "specialTaxableYtd"] as const) {
      const earlier = entries.slice(0, index).findLast((previous) => previous[field] !== undefined);
      if (entry[field] !== undefined && earlier?.[field] !== undefined && entry[field] < earlier[field]) {
        issues.push(`${prefix}kumulierte Sechstelwerte sind gesunken; Korrektur oder Aufrollung zuerst klären.`);
      }
    }
  }
  return unique(issues);
}

type Utilization = {
  used?: number;
  taxable?: number;
  exempt?: boolean;
  issues: string[];
};

function historicalUtilization(entries: Payslip[]): Utilization {
  let used: number | undefined;
  let taxable: number | undefined;
  let exempt: boolean | undefined;
  let issues: string[] = [];
  for (const [index, entry] of entries.entries()) {
    const specialTotal = cumulative(entries, index, "specialGross", "specialGrossYtd");
    const regularTotal = cumulative(entries, index, "regularGross", "regularGrossYtd");
    if (entry.month === 1) {
      used = 0;
      taxable = 0;
    } else if (entries[index - 1]?.month !== entry.month - 1) {
      used = undefined;
      taxable = undefined;
      issues.push("Frühere Sonderzahlungen sind ohne lückenlose Abrechnungen oder bestätigten Sechstelverbrauch und begünstigte Steuerbasis nicht rekonstruierbar.");
    }
    if (entry.unresolvedSixthBonus) {
      used = undefined;
      taxable = undefined;
      exempt = undefined;
      issues.push("Tarifbesteuerte Prämie mit SV-Sonderzahlung: Die Abrechnung belegt nicht, ob sie das Sechstel erhöht oder nach § 67 Abs. 10 behandelt wurde. Sechstelverbrauch und begünstigte Steuerbasis bleiben ohne gesonderten Nachweis offen.");
    } else if (specialTotal === 0 && !entries.slice(0, index).some((previous) => previous.unresolvedSixthBonus)) {
      used = 0;
      taxable = 0;
      issues = [];
      exempt = undefined;
    } else if (entry.specialGross > 0) {
      const sixth = entry.reportedSixth
        ?? (regularTotal !== undefined && entry.monthlyPayroll ? money(regularTotal / entry.month * 2) : undefined);
      if (used !== undefined && sixth !== undefined) {
        const eligible = Math.min(entry.specialGross, Math.max(0, money(sixth - used)));
        const currentExempt = sixth <= freeLimit(entry.year);
        if (eligible > 0 && taxable !== undefined && taxable > 0 && exempt !== undefined && currentExempt !== exempt) {
          issues.push("Geänderte Freigrenzenbehandlung früherer Sonderzahlungen: Aufrollung und bereits einbehaltene Steuer müssen geklärt werden.");
        }
        if (eligible > 0) exempt = currentExempt;
        used = sum([used, eligible]);
        if (eligible < entry.specialGross) {
          taxable = undefined;
          issues.push("Früherer Sechstelüberhang: Eine Abrechnung mit belegtem Sechstelverbrauch und kumulierter begünstigter Steuerbasis aus der Lohnverrechnung fehlt. Bitte den entsprechenden PDF-Beleg hochladen.");
        } else if (entry.specialSv === undefined) {
          taxable = undefined;
          issues.push("Die SV früherer Sonderzahlungen fehlt; begünstigte Steuerbasis ist unbekannt.");
        } else if (taxable !== undefined) {
          taxable = sum([taxable, entry.specialGross - entry.specialSv]);
        }
      } else {
        used = undefined;
        taxable = undefined;
      }
    }
    if (entry.usedSixth !== undefined) used = entry.usedSixth;
    if (entry.specialTaxableYtd !== undefined) taxable = entry.specialTaxableYtd;
    if (entry.usedSixth !== undefined && entry.specialTaxableYtd !== undefined) {
      // Gross utilization and tax base do not establish whether a tax catch-up was paid.
      issues = issues.filter((issue) => issue.includes("Freigrenzenbehandlung"));
      const anchorSixth = entry.reportedSixth
        ?? (regularTotal !== undefined && entry.monthlyPayroll ? money(regularTotal / entry.month * 2) : undefined);
      exempt = anchorSixth === undefined || entry.usedSixth === 0 ? undefined : anchorSixth <= freeLimit(entry.year);
    }
  }
  if (used === undefined || taxable === undefined) {
    issues.push("Bestätigter bisheriger Sechstelverbrauch und kumulierte begünstigte Steuerbasis (vor 620 €) fehlen.");
  }
  return { used, taxable, exempt, issues: unique(issues) };
}

function annualTariff(taxable: number, year: PayrollYear): number {
  const bounds = year === 2026
    ? [13539, 21992, 36458, 70365, 104859, 1000000, Infinity]
    : [13846, 22491, 37285, 71960, 107236, 1000000, Infinity];
  const rates = [0, 0.2, 0.3, 0.4, 0.48, 0.5, 0.55];
  let tax = 0;
  let lower = 0;
  for (const [index, upper] of bounds.entries()) {
    tax += Math.max(0, Math.min(taxable, upper) - lower) * rates[index];
    lower = upper;
    if (taxable <= upper) break;
  }
  return tax;
}

function monthlyTariff(base: number, year: PayrollYear): number {
  return annualTariff(Math.max(0, base * 12 - 132), year) / 12;
}

function preferentialTax(base: number): number {
  return Math.min(Math.max(0, base - 620), 24380) * 0.06
    + Math.min(Math.max(0, base - 25000), 25000) * 0.27
    + Math.min(Math.max(0, base - 50000), 33333) * 0.3575;
}

function tariffIncrement(
  netOverflow: number,
  month: PayrollForecastMonth,
  latest: Payslip,
  year: PayrollYear,
  issues: string[],
): number | undefined {
  if (netOverflow === 0) return 0;
  if (month.monthlyTaxableBase === undefined) {
    issues.push("Laufende monatliche LSt-Basis vor dem Werbungskostenpauschale fehlt für die Tarifbesteuerung des Überhangs.");
    return undefined;
  }
  const before = monthlyTariff(month.monthlyTaxableBase, year);
  const after = monthlyTariff(sum([month.monthlyTaxableBase, netOverflow]), year);
  if (sameMoney(before, after)) return 0;
  if (latest.monthlyTaxableBase === undefined || latest.regularTax === undefined) {
    issues.push("Beobachtete laufende LSt-Basis und tatsächlich einbehaltene laufende Lohnsteuer fehlen; Absetzbeträge sind nicht abgesichert.");
    return undefined;
  }
  const observedTariff = monthlyTariff(latest.monthlyTaxableBase, year);
  const projectedWithholding = money(latest.regularTax + before - observedTariff);
  if (latest.regularTax <= 0 || projectedWithholding <= 0) {
    issues.push("Laufende Lohnsteuer ist beobachtet oder im Prognosemonat nicht positiv; unbekannte ungenutzte Absetzbeträge verhindern eine sichere Überhangsteuer.");
    return undefined;
  }
  if (latest.regularTax > money(observedTariff)) {
    issues.push("Beobachtete laufende Lohnsteuer übersteigt den normalisierten Tarif; Korrekturen oder abweichende LSt-Basis zuerst klären.");
    return undefined;
  }
  return money(after - before);
}

function projectedTax(
  year: PayrollYear,
  month: PayrollForecastMonth,
  latest: Payslip,
  sixth: number,
  eligibleGross: number,
  taxableBefore: number | undefined,
  issues: string[],
): PayrollTax | undefined {
  if (month.specialGross === 0) return undefined;
  if (month.specialSv === undefined || month.specialSv > month.specialGross || taxableBefore === undefined) return undefined;
  const eligibleSv = money(month.specialSv * eligibleGross / month.specialGross);
  const eligibleNet = money(eligibleGross - eligibleSv);
  const entireNet = money(month.specialGross - month.specialSv);
  const overflowNet = money(entireNet - eligibleNet);
  if (sum([taxableBefore, entireNet]) > 83333) {
    issues.push("Kumulierte Sonderzahlungsbasis über 83.333 €: zusätzliche Tarifbehandlung der oberen Begünstigungsgrenze ist nicht modelliert.");
    return undefined;
  }
  const exempt = sixth <= freeLimit(year);
  const preferential = exempt ? 0 : money(
    preferentialTax(sum([taxableBefore, eligibleNet])) - preferentialTax(taxableBefore),
  );
  const otherwisePreferential = exempt ? 0 : money(
    preferentialTax(sum([taxableBefore, entireNet])) - preferentialTax(taxableBefore),
  );
  const tariff = tariffIncrement(overflowNet, month, latest, year, issues);
  if (tariff === undefined || issues.length) return undefined;
  const total = sum([preferential, tariff]);
  const signedOverflowDelta = money(total - otherwisePreferential);
  return {
    preferential,
    tariff,
    total,
    signedOverflowDelta,
    extraDueToOverflow: Math.max(0, signedOverflowDelta),
    reductionDueToOverflow: Math.max(0, -signedOverflowDelta),
    netSpecial: money(entireNet - total),
  };
}

export function analyzePayroll(
  payslips: Payslip[],
  year: PayrollYear,
  employer: string,
  savedForecast?: PayrollForecast,
): PayrollAnalysis {
  return analyzePayrollScenario(payslips, year, employer, savedForecast, false);
}

export function analyzePayrollAutomatically(
  payslips: Payslip[],
  year: PayrollYear,
  employer: string,
): AutomaticPayrollAnalysis {
  const analysis = analyzePayrollScenario(payslips, year, employer, undefined, true);
  const hasSpecialPaymentModel = (analysis.latest?.baseSalary ?? 0) > 0;
  if (analysis.latest && analysis.latest.month < 12 && !hasSpecialPaymentModel) {
    analysis.issues.push("Kein positiver, ausdrücklich belegter Grundgehaltsbetrag für das Sonderzahlungsmodell. Bitte eine passende lesbare PDF-Abrechnung hochladen; laufendes Brutto oder LSt-Basis ersetzen diesen Nachweis nicht.");
  }
  const entries = selectedPayslips(payslips, year, employer);
  const sixthEstimates: AutomaticPayrollAnalysis["sixthEstimates"] = [];
  let estimatedHistoryMonths: number[] = [];
  let unresolvedSixthMonths: number[] = [];
  if (analysis.latest && !analysis.contextIssues.length && !consistencyIssues(entries).length && entries.every((entry) => entry.monthlyPayroll)) {
    const latest = analysis.latest;
    const anchor = entries.findLast((entry) => entry.regularGrossYtd !== undefined);
    const uncertain = entries.filter((entry) => entry.month > (anchor?.month ?? 0) && entry.unresolvedSixthBonus);
    unresolvedSixthMonths = uncertain.map((entry) => entry.month);
    const uncertainGross = sum(uncertain.map((entry) => entry.unresolvedSixthBonus ?? 0));
    let regular = cumulative(entries, entries.length - 1, "regularGross", "regularGrossYtd");
    if (regular === undefined) {
      estimatedHistoryMonths = analysis.missingMonths.filter((month) => month > (anchor?.month ?? 0));
      const average = sum(entries.map((entry) => entry.regularGross)) / entries.length;
      regular = sum([
        anchor?.regularGrossYtd ?? 0,
        ...entries.filter((entry) => entry.month > (anchor?.month ?? 0)).map((entry) => entry.regularGross),
        money(estimatedHistoryMonths.length * average),
      ]);
    }
    if (regular > 0) {
      // Indicative sixth values never fill actual history or enable a tax calculation.
      for (let month = latest.month; month <= 12; month++) {
        if (month > latest.month) regular = sum([regular, latest.regularGross]);
        sixthEstimates.push({
          month, sixth: money(regular / month * 2), regularGrossYtd: regular,
          ...(uncertainGross > 0 ? { sixthUpper: money(sum([regular, uncertainGross]) / month * 2) } : {}),
        });
      }
    }
  }
  return {
    ...analysis,
    mode: "automatic-standard-model",
    assumptions: [...automaticPayrollAssumptions],
    hasSpecialPaymentModel,
    sixthEstimates,
    estimatedHistoryMonths,
    unresolvedSixthMonths,
  };
}

export function estimatePayrollBonus(
  payslips: Payslip[],
  analysis: AutomaticPayrollAnalysis,
  month: number,
): PayrollBonusEstimate {
  const { latest, forecast, sixthEstimates } = analysis;
  const result: PayrollBonusEstimate = {
    month, reservedSpecialGross: sum(forecast.months.map((entry) => entry.specialGross)),
    headroomIssues: [], taxIssues: [],
  };
  const contextIssues = payrollContextMessages(selectedPayslips(payslips, forecast.year, forecast.employer));
  if (contextIssues.length) {
    result.headroomIssues.push(...contextIssues);
    result.taxIssues.push(...contextIssues);
    return result;
  }
  if (!latest || !Number.isInteger(month) || month < latest.month || month > 12 || !sixthEstimates.length) {
    result.headroomIssues.push("Für diesen Auszahlungsmonat fehlen auswertbare volle Abrechnungen.");
    result.taxIssues.push("Ohne auswertbare Monatsgrundlage bleibt das Steuerbeispiel offen.");
    return result;
  }
  const entries = selectedPayslips(payslips, forecast.year, forecast.employer);
  const atLatest = sixthEstimates.find((entry) => entry.month === latest.month);
  if (latest.reportedSixth !== undefined && atLatest &&
    (latest.reportedSixth < atLatest.sixth || latest.reportedSixth > (atLatest.sixthUpper ?? atLatest.sixth))) {
    result.headroomIssues.push("Das ausgewiesene Sechstel widerspricht der laufenden Basis; zunächst ist ein passender PDF-Nachweis nötig.");
    result.taxIssues.push("Bei widersprüchlicher Sechstelbasis wird kein Steuerbeispiel berechnet.");
    return result;
  }
  const paid = cumulativeBounds(entries, entries.length - 1, "specialGross", "specialGrossYtd");
  if (!analysis.hasSpecialPaymentModel && latest.month < 11) {
    result.headroomIssues.push("Ein belegtes Grundgehalt zur Reservierung der geplanten Sonderzahlungen fehlt.");
  } else if (!paid || analysis.estimatedHistoryMonths.length) {
    result.headroomIssues.push("Bisherige Bezüge sind nicht vollständig belegt; fehlende Zahlungen werden nicht als freier Prämien-Spielraum behandelt.");
  } else {
    // Reserve gross payments conservatively, including every later payout and December's control sixth.
    const remaining = sixthEstimates.filter((entry) => entry.month >= month).map((entry) => {
      const planned = sum(forecast.months.filter((payment) => payment.month <= entry.month).map((payment) => payment.specialGross));
      return {
        minimum: money(entry.sixth - paid.maximum - planned),
        maximum: money((entry.sixthUpper ?? entry.sixth) - paid.minimum - planned),
      };
    });
    result.headroom = {
      minimum: Math.max(0, Math.min(...remaining.map((entry) => entry.minimum))),
      maximum: Math.max(0, Math.min(...remaining.map((entry) => entry.maximum))),
    };
  }

  const svGross = cumulativeSpecialSvGross(entries);
  const payment = month === latest.month
    ? { month, regularGross: latest.regularGross, specialGross: latest.specialGross, monthlyTaxableBase: latest.monthlyTaxableBase }
    : forecast.months.find((entry) => entry.month === month);
  if (forecast.year !== 2026) result.taxIssues.push("Für 2027 fehlt eine verifizierte automatische SV-Tabelle.");
  if (svGross === undefined) result.taxIssues.push("Die bisherige SV-Sonderzahlungsbasis ist nicht vollständig bekannt.");
  if (!analysis.hasSpecialPaymentModel && forecast.months.some((entry) => entry.month <= month && (entry.month === 6 || entry.month === 11))) {
    result.taxIssues.push("Ohne belegtes Grundgehalt sind die modellierten Sonderzahlungen und ihr SV-Verbrauch bis zur Auszahlung offen.");
  }
  if (!payment || payment.monthlyTaxableBase === undefined) result.taxIssues.push("Die laufende LSt-Basis für das Steuerbeispiel fehlt.");
  if (result.taxIssues.length || !payment || svGross === undefined) return result;

  const gross = 1000;
  const sameMonthSvGross = month === latest.month ? sum([latest.specialGross, latest.unresolvedSixthBonus ?? 0]) : payment.specialGross;
  const precedingSvGross = month === latest.month ? money(svGross - sameMonthSvGross)
    : sum([svGross, ...forecast.months.filter((entry) => entry.month < month).map((entry) => entry.specialGross)]);
  const monthlySpecialGross = sum([sameMonthSvGross, gross]);
  const sv = money(standardSpecialSv2026(monthlySpecialGross, precedingSvGross) * gross / monthlySpecialGross);
  const taxable = money(gross - sv);
  const tax = tariffIncrement(taxable, payment, latest, forecast.year, result.taxIssues);
  if (tax === undefined || result.taxIssues.length) return result;
  result.taxExample = {
    gross, sv, tax,
    deductions: sum([sv, tax]),
    net: money(gross - sv - tax),
    effectiveTariffRate: taxable === 0 ? 0 : money(tax / taxable * 100),
  };
  return result;
}

function analyzePayrollScenario(
  payslips: Payslip[],
  year: PayrollYear,
  employer: string,
  savedForecast: PayrollForecast | undefined,
  automatic: boolean,
): PayrollAnalysis {
  const entries = selectedPayslips(payslips, year, employer);
  const latest = entries.at(-1);
  const issues: string[] = [];
  const contextIssues = payrollContextMessages(entries);
  issues.push(...contextIssues);
  const forecast = mergeForecast(
    defaultPayrollForecast(payslips, year, employer), savedForecast, issues,
    cumulativeSpecialSvGross(entries),
  );
  const result: PayrollAnalysis = {
    latest,
    missingMonths: latest && Number.isInteger(latest.month) && latest.month >= 1 && latest.month <= 12
      ? Array.from({ length: latest.month }, (_, index) => index + 1)
        .filter((month) => !entries.some((entry) => entry.month === month))
      : [],
    issues,
    contextIssues,
    forecast,
    projections: [],
  };
  if (!latest) {
    issues.push("Für dieses Jahr und diesen Arbeitgeber liegt noch keine Abrechnung vor.");
    return result;
  }
  const invalid = consistencyIssues(entries);
  if (invalid.length) {
    issues.push(...invalid);
    return result;
  }
  const regularGrossYtd = cumulative(entries, entries.length - 1, "regularGross", "regularGrossYtd");
  const specialGrossYtd = cumulative(entries, entries.length - 1, "specialGross", "specialGrossYtd");
  const utilization = historicalUtilization(entries);
  if (entries.some((entry) => entry.unresolvedSixthBonus)) issues.push(...utilization.issues);
  const monthlyPayroll = entries.every((entry) => entry.monthlyPayroll);
  if (result.missingMonths.length) {
    issues.push(`Abrechnungen für Monat ${result.missingMonths.join(", ")} fehlen. Nur bestätigte kumulierte Werte können diese Lücken überbrücken.`);
  }
  if (!monthlyPayroll) issues.push("Keine durchgehend bestätigte monatliche Abrechnung: Teilmonate oder Sonderfälle müssen von der Lohnverrechnung geklärt werden.");
  if (regularGrossYtd === undefined) issues.push("Das kumulierte sechstelrelevante Brutto ist nicht vollständig belegt; fehlende Monate und unklare Sechstelzuordnungen werden nicht als 0 € behandelt.");
  if (specialGrossYtd === undefined) issues.push("Die bisherigen steuerlichen Sonderzahlungen sind nicht vollständig belegt; fehlende Monate und unklare Prämienzuordnungen bedeuten nicht 0 € Sonderzahlungen.");
  const beforeFirstRegularPay = regularGrossYtd === 0 && specialGrossYtd !== 0 && latest.reportedSixth === undefined;
  if (beforeFirstRegularPay) issues.push("Vor dem ersten laufenden Bezug ist ein Sechstel ohne bestätigten Abrechnungswert nicht berechenbar.");
  const sixth = latest.reportedSixth
    ?? (regularGrossYtd !== undefined && monthlyPayroll && !contextIssues.length && !beforeFirstRegularPay ? money(regularGrossYtd / latest.month * 2) : undefined);
  if (sixth !== undefined) {
    result.actual = {
      month: latest.month,
      regularGrossYtd,
      specialGrossYtd,
      sixth,
      source: latest.reportedSixth === undefined ? "calculated" : "reported",
      usedSixth: utilization.used,
      specialTaxableYtd: utilization.taxable,
      remaining: utilization.used === undefined || contextIssues.length ? undefined : money(Math.max(0, sixth - utilization.used)),
      controlSixth: latest.month === 12 && regularGrossYtd !== undefined && !contextIssues.length ? money(regularGrossYtd / 6) : undefined,
    };
  }
  if (regularGrossYtd === undefined || specialGrossYtd === undefined || !monthlyPayroll || contextIssues.length || beforeFirstRegularPay) return result;

  let regular = regularGrossYtd;
  let special = specialGrossYtd;
  let used = utilization.used ?? specialGrossYtd;
  let taxable = utilization.taxable;
  let exempt = utilization.exempt;
  const ongoingTaxIssues = [...utilization.issues];
  if (latest.reportedSixth !== undefined && !sameMoney(latest.reportedSixth, money(regularGrossYtd / latest.month * 2))) {
    const discrepancy = "Das ausgewiesene Jahressechstel weicht von der bestätigten laufenden Basis ab. Der Ist-Wert bleibt erhalten; vor einer Steuerschätzung bitte die Abweichung mit der Lohnverrechnung klären.";
    issues.push(discrepancy);
    ongoingTaxIssues.push(discrepancy);
  }
  for (const month of forecast.months) {
    regular = sum([regular, month.regularGross]);
    special = sum([special, month.specialGross]);
    const projectedSixth = money(regular / month.month * 2);
    const eligibleGross = money(Math.min(month.specialGross, Math.max(0, projectedSixth - used)));
    const overflowGross = money(month.specialGross - eligibleGross);
    used = sum([used, eligibleGross]);
    const taxIssues = [...ongoingTaxIssues];
    if (!automatic && !forecast.standardPayrollConfirmed) taxIssues.push("Prognoseannahmen für die Standard-Lohnverrechnung sind noch nicht bestätigt.");
    if (month.specialGross > 0 && month.specialSv === undefined) {
      taxIssues.push(automatic
        ? year === 2027
          ? "SV-Tabellen 2027 sind nicht verifiziert; deshalb ist keine automatische Steuer-/Nettoschätzung möglich. Tatsächliche Werte werden erst mit einer entsprechenden PDF-Abrechnung belegt."
          : "Für die automatische Sonderzahlungs-SV fehlen ausreichende Belege. Bitte fehlende PDF-Abrechnungen mit den bisherigen Sonderzahlungen hochladen."
        : year === 2027
        ? "SV der geplanten Sonderzahlung fehlt; SV-Tabellen 2027 sind nicht verifiziert, daher ist ein expliziter SV-Betrag erforderlich."
        : "SV der geplanten Sonderzahlung fehlt; keine Nettoberechnung ohne bestätigten SV-Betrag.");
    }
    if (month.specialSv !== undefined && month.specialSv > month.specialGross) taxIssues.push("Geplante Sonderzahlungs-SV übersteigt das Sonderzahlungsbrutto.");
    if (month.specialGross > 0 && taxable === undefined) taxIssues.push("Kumulierte begünstigte Steuerbasis früherer tatsächlicher oder modellierter Sonderzahlungen ist unbekannt.");
    if (month.specialGross > 0 && eligibleGross > 0 && taxable !== undefined && taxable > 0) {
      if (exempt === undefined || exempt !== (projectedSixth <= freeLimit(year))) {
        const message = "Geänderte oder unbekannte Freigrenzenbehandlung früherer Sonderzahlungen: mögliche Aufrollung ist nicht als zusätzliche Monatssteuer berechenbar.";
        taxIssues.push(message);
        ongoingTaxIssues.push(message);
      }
    }
    const tax = projectedTax(year, month, latest, projectedSixth, eligibleGross, taxable, taxIssues);
    result.projections.push({
      month: month.month,
      source: "scenario",
      regularGrossYtd: regular,
      specialGrossYtd: special,
      sixth: projectedSixth,
      remaining: money(Math.max(0, projectedSixth - used)),
      overhang: money(Math.max(0, special - projectedSixth)),
      specialGross: month.specialGross,
      utilizationSource: utilization.used === undefined ? "gross-comparison" : "verified",
      eligibleGross,
      overflowGross,
      controlSixth: month.month === 12 ? money(regular / 6) : undefined,
      tax,
      taxIssues: unique(taxIssues),
      taxAssumptions: [
        ...(automatic ? automaticPayrollAssumptions : []),
        "Reines Szenario ab dem letzten tatsächlichen Abrechnungsmonat; keine Aussage über bereits erfolgte spätere Zahlungen.",
        "Juni/November mit angegebenem Grundgehalt sind nur eine Vorlage, kein festgestellter Sonderzahlungsanspruch.",
        "Laufende LSt-Basis vor 132 € jährlichem Werbungskostenpauschale; unveränderte feste Absetzbeträge, keine zusätzlichen einkommensabhängigen Absetzbeträge oder Sonderfälle.",
        automatic
          ? "Sonderzahlungs-SV ist nur eine automatische Standardannahme, kein belegter zukünftiger Abzug."
          : "Sonderzahlungs-SV ist eine Prognoseannahme für homogene, vollversicherte Angestelltenbezüge; keine Lehrlinge oder gemischten SV-Zahlungen. Explizite Monatswerte haben Vorrang.",
        ...(year === 2026
          ? [`SV-Vorlage 2026: 14,12/15,12/16,12/17,07 % nach gesamtem Monats-SZ-Brutto, jährliche SZ-Höchstbeitragsgrundlage 13.860 €; bisheriges SZ-Brutto gilt nur im ${automatic ? "unbestätigten automatischen" : "bestätigten"} Standardmodell als verbrauchte SV-Basis.`]
          : [automatic
            ? "Keine automatische SV-Schätzung 2027; ohne verifizierte SV-Tabellen bleibt die Steuer-/Nettoprognose gesperrt."
            : "Keine automatische SV-Schätzung 2027; nur explizit eingetragene SV-Annahmen."]),
        "Berechnet wird zusätzliche laufende Lohnsteuer im Auszahlungsmonat (§ 67 Abs. 10), nicht die endgültige jährliche Einkommensteuer.",
        "Optionale 30%-Einschleif-Aufrollung nach § 77 Abs. 4 und sonstige historische Korrekturen werden nicht angewendet.",
        ...(month.month === 12
          ? ["Kontrollsechstel: nur Jahresbrutto/6. Ein Jahresüberhang ist keine neue Dezember-Steuerschuld; rückwirkende Korrektur oder Rückerstattung früherer Zahlungen wird nicht berechnet."]
          : []),
        ...(utilization.used === undefined
          ? ["Sechstelverbrauch unbekannt: Bruttovergleich unterstellt vorläufig alle bisherigen Sonderzahlungen als Verbrauch; keine gesicherte Aufteilung in begünstigt und Überhang."]
          : []),
      ],
    });
    if (month.specialGross > 0 && eligibleGross > 0) {
      if (month.specialSv === undefined || month.specialSv > month.specialGross) {
        taxable = undefined;
      } else if (taxable !== undefined) {
        taxable = sum([taxable, eligibleGross - money(month.specialSv * eligibleGross / month.specialGross)]);
      }
      exempt = projectedSixth <= freeLimit(year);
    }
  }
  result.nextSpecial = result.projections.find((projection) => projection.specialGross > 0);
  result.yearEnd = result.projections.find((projection) => projection.month === 12);
  return result;
}

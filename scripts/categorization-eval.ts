import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { MerchantIndex } from "../src/lib/automation/merchants";
import { readMerchantDefinitions } from "../src/lib/automation/store";
import { allCategories, canonicalCategory, type Category } from "../src/lib/categories";
import {
  applyLabelOverrides,
  bookingDescriptor,
  CATEGORIZATION_EVAL_VERSION,
  compareCategorization,
  errorCause,
  evaluationBookings,
  evaluationLabels,
  evaluationMonths,
  joinOutcomes,
  reviewWithModel,
  tally,
  simulateMonth,
  STRONG_LABELS,
  summarizeCategorization,
  type CategorizationComparison,
  type CategorizationSummary,
  type ErrorCause,
  type EvalLabel,
  type EvalOutcome,
  type EvalRecord,
  type Tally,
} from "../src/lib/ai/categorization-eval";
import { appStateSchema, type AppState, type Transaction } from "../src/lib/types";
import { webContextFor } from "../src/lib/ai/auto-assign";
import { categorizeBookings } from "../src/lib/ai/categorize";
import { brandHistory, decideReviewWithEvidence, keywordHabit } from "../src/lib/ai/evidence";
import { aiReviewCandidates } from "../src/lib/ai/review-candidates";

// Reports name real shops and amounts: they stay in the gitignored .local-data folder.
const usage = `Kategorisierungs-Testlauf auf den echten Buchungen (nur lesend).

  npm run eval:categories                    alle Monate, Bericht in .local-data/categorization-eval/
  npm run eval:categories -- --months 2026-09,2026-10
  npm run eval:categories -- --save-baseline   aktuellen Lauf als Vergleichsbasis merken
  npm run eval:categories -- --fail-on-regression   Exit 1, wenn eine zuvor richtige Buchung kippt
  npm run eval:categories -- --compare <bericht.json>   statt mit baseline.json mit einem anderen Lauf vergleichen
  npm run eval:categories -- --model         zusätzlich die KI-Prüfung (lokales Modell, OVMS) auf offenen Buchungen
  npm run eval:categories -- --booking <id>  eine Buchung erklären (Quelle, Label, Pipeline-Ergebnis)
  npm run eval:categories -- --set <id>=<Kategorie>   Label korrigieren (labels.json)
  npm run eval:categories -- --exclude <id>  Buchung aus der Bewertung nehmen
  npm run eval:categories -- --refresh-labels   Wahrheit (ground-truth.json) neu aus dem Datenstand ableiten

Die Wahrheit wird je Datenstand (Revision) eingefroren, damit geänderter Code seine eigenen Labels
nicht verschiebt; Korrekturen aus labels.json gelten immer zusätzlich.

Optionen: --db <pfad>  --out <ordner>  --name <berichtname>  --top <n>`;

const { values } = parseArgs({
  options: {
    db: { type: "string" },
    out: { type: "string" },
    name: { type: "string" },
    months: { type: "string" },
    compare: { type: "string" },
    booking: { type: "string" },
    set: { type: "string", multiple: true },
    exclude: { type: "string", multiple: true },
    top: { type: "string", default: "40" },
    "save-baseline": { type: "boolean", default: false },
    "fail-on-regression": { type: "boolean", default: false },
    "refresh-labels": { type: "boolean", default: false },
    model: { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(usage);
  process.exit(0);
}

const databasePath = resolve(
  values.db ?? process.env.FINANZBLICK_DATABASE_PATH ?? join(".local-data", "finanzblick.sqlite"),
);
const outDir = resolve(values.out ?? join(".local-data", "categorization-eval"));
const labelsPath = join(outDir, "labels.json");
const baselinePath = join(outDir, "baseline.json");
const groundTruthPath = join(outDir, "ground-truth.json");
const top = Math.max(1, Number(values.top) || 40);

if (!existsSync(databasePath)) {
  console.log(`Keine Datenbank unter ${databasePath} – nichts zu bewerten.`);
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });

function readOverrides(): Record<string, Category | "exclude"> {
  if (!existsSync(labelsPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(labelsPath, "utf8"));
  if (!parsed || typeof parsed !== "object") return {};
  const result: Record<string, Category | "exclude"> = {};
  for (const [id, value] of Object.entries(parsed)) {
    if (value === "exclude") result[id] = "exclude";
    else if (typeof value === "string" && (allCategories as readonly string[]).includes(value))
      result[id] = canonicalCategory(value as Category);
  }
  return result;
}

function updateOverrides(): boolean {
  if (!values.set?.length && !values.exclude?.length) return false;
  const overrides = readOverrides();
  for (const entry of values.set ?? []) {
    const divider = entry.indexOf("=");
    const id = entry.slice(0, divider).trim();
    const category = entry.slice(divider + 1).trim();
    if (divider < 1 || !(allCategories as readonly string[]).includes(category))
      throw new Error(`Ungültig: ${entry} (erwartet <id>=<Kategorie>)`);
    overrides[id] = canonicalCategory(category as Category);
  }
  for (const id of values.exclude ?? []) overrides[id.trim()] = "exclude";
  writeFileSync(labelsPath, `${JSON.stringify(overrides, null, 2)}\n`);
  console.log(`${Object.keys(overrides).length} Label-Korrekturen in ${labelsPath}`);
  return true;
}

function loadData() {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only = ON; PRAGMA busy_timeout = 5000;");
    const index = new MerchantIndex(readMerchantDefinitions(db));
    const states = db
      .prepare("SELECT user_id, revision, state_json FROM finance ORDER BY user_id")
      .all()
      .map((row) => ({
        user: String(row.user_id),
        revision: Number(row.revision),
        state: appStateSchema.parse(JSON.parse(String(row.state_json))),
      }));
    return { index, states };
  } finally {
    db.close();
  }
}

const percent = (value: number | null) => (value === null ? "–" : `${(value * 100).toFixed(1)} %`);
const tallyRow = (name: string, item: Tally) =>
  `| ${name} | ${item.total} | ${item.decided} | ${item.correct} | ${item.wrong} | ${item.open} | ${item.missing} | ${percent(item.precision)} | ${percent(item.coverage)} | ${percent(item.accuracy)} |`;
const tallyHeader =
  "| Gruppe | Buchungen | automatisch | richtig | falsch | offen | fehlt | Präzision | Abdeckung | Genauigkeit |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|";

function tallyTable(groups: Record<string, Tally>, limit = Number.POSITIVE_INFINITY) {
  return [tallyHeader, ...Object.entries(groups)
    .sort(([, left], [, right]) => right.total - left.total)
    .slice(0, limit)
    .map(([name, item]) => tallyRow(name, item))].join("\n");
}

interface ErrorDetail {
  id: string;
  date: string;
  bank: string;
  amount: number;
  descriptor: string;
  description: string;
  sourceCategory?: string;
  label: Category;
  strength: EvalRecord["strength"];
  status: EvalRecord["status"];
  predicted?: Category;
  method?: EvalRecord["method"];
  reason?: string;
  cause?: ErrorCause;
}

const causeLabel: Record<ErrorCause, string> = {
  "later-rule": "Regel erst später gelernt (geänderte Präferenz oder rückwirkend verteilt)",
  "first-decision": "Erstentscheidung (zu diesem Händler gab es vorher keine eigene Wahl)",
  other: "möglicher Codefehler – prüfen",
};

function details(rows: Map<string, Transaction>, records: EvalRecord[]): ErrorDetail[] {
  return records.flatMap((record) => {
    const row = rows.get(record.id);
    if (!row) return [];
    return [{
      id: record.id,
      date: row.date,
      bank: row.bank,
      amount: row.amount,
      descriptor: bookingDescriptor(row),
      description: row.rawDescription ?? row.description,
      ...(row.sourceCategory ? { sourceCategory: row.sourceCategory } : {}),
      label: record.label,
      strength: record.strength,
      status: record.status,
      ...(record.predicted ? { predicted: record.predicted } : {}),
      ...(record.method ? { method: record.method } : {}),
      ...(record.reason ? { reason: record.reason } : {}),
      ...(record.status === "decided" && !record.correct && !record.holiday && STRONG_LABELS.has(record.strength)
        ? { cause: errorCause(record) } : {}),
    }];
  });
}

function descriptorGroups(items: ErrorDetail[]) {
  const groups = new Map<string, { descriptor: string; count: number; labels: Set<string>; predicted: Set<string> }>();
  for (const item of items) {
    const group = groups.get(item.descriptor) ?? { descriptor: item.descriptor, count: 0, labels: new Set(), predicted: new Set() };
    group.count++;
    group.labels.add(item.label);
    group.predicted.add(item.predicted ?? "offen");
    groups.set(item.descriptor, group);
  }
  return [...groups.values()].sort((left, right) => right.count - left.count);
}

function markdown(name: string, summary: CategorizationSummary, wrong: ErrorDetail[], open: ErrorDetail[],
  comparison: CategorizationComparison | undefined, seconds: number, current: Tally, today: Tally) {
  const lines = [
    `# Kategorisierungs-Testlauf: ${name}`,
    "",
    `Version ${CATEGORIZATION_EVAL_VERSION}, ${new Date().toISOString()}, Laufzeit ${seconds.toFixed(1)} s.`,
    "",
    "Jeder Monat wird wie ein echter Kontoauszug-Import nachgespielt: bekannt ist nur, was vor dem Monat",
    "gebucht und bestätigt war. *Präzision* = richtige / automatisch entschiedene Buchungen,",
    "*Abdeckung* = automatisch entschiedene / bewertete, *Genauigkeit* = richtige / bewertete Buchungen.",
    "",
    "## Gesamt",
    "",
    tallyHeader,
    tallyRow("Sichere Labels (Hand + Regel)", summary.strong),
    tallyRow("Sichere Labels ohne Transfers", summary.strongWithoutTransfers),
    tallyRow("Sichere Labels, beim Import bekannt", summary.strongKnown),
    tallyRow("Alle Labels", summary.all),
    "",
    `Nicht enthalten: ${summary.holiday.total} Buchungen in eingetragenen Urlaubszeiträumen (eigene Zeile unten).`,
    "",
    "## Nach Label-Herkunft",
    "",
    tallyTable(summary.byStrength),
    "",
    "## Nach Methode (automatisch entschiedene)",
    "",
    tallyTable(summary.byMethod),
    "",
    "## Nach Bank",
    "",
    tallyTable(summary.byBank),
    "",
    "## Nach Vorzeichen",
    "",
    tallyTable(summary.bySign),
    "",
    "## Nach Monat",
    "",
    tallyTable(summary.byMonth),
    "",
    "## In Urlaubszeiträumen",
    "",
    "Unbekannte Ausgaben zeigt die App dort als Urlaub; ob ein Geschäft als „daheim“ gilt, hängt von späteren",
    "Besuchen ab. Deshalb getrennt bewertet.",
    "",
    tallyHeader,
    tallyRow("Urlaubszeiträume", summary.holiday),
    "",
    "## Nach richtiger Kategorie",
    "",
    tallyTable(summary.byLabel),
    "",
    "## Fehler bei sicheren Labels nach Ursache",
    "",
    "| Ursache | Anzahl |",
    "|---|---:|",
    ...(Object.keys(causeLabel) as ErrorCause[]).map((cause) => `| ${causeLabel[cause]} | ${summary.causes[cause]} |`),
    "",
    "Gegencheck der geänderten Präferenzen: Buchungen, deren Regel erst später gelernt wurde, noch einmal mit den",
    "heutigen Regeln nachgespielt.",
    "",
    tallyHeader,
    tallyRow("Mit heutigen Regeln", current),
    tallyRow("Alle sicheren Labels nach heutiger Präferenz", today),
    "",
    "| Datum | Händlertext | Betrag | richtig | vergeben | Ursache |",
    "|---|---|---:|---|---|---|",
    ...wrong.filter((item) => item.cause).sort((left, right) => (left.cause ?? "").localeCompare(right.cause ?? "") || left.date.localeCompare(right.date))
      .map((item) => `| ${item.date} | ${item.descriptor.replace(/\|/g, "/")} | ${item.amount.toFixed(2)} | ${item.label} | ${item.predicted ?? "–"} | ${causeLabel[item.cause!]} |`),
    "",
    "## Häufigste Verwechslungen (richtig → vergeben)",
    "",
    "| richtig | vergeben | Anzahl | davon sicher |",
    "|---|---|---:|---:|",
    ...summary.confusion.slice(0, top).map((item) => `| ${item.label} | ${item.predicted} | ${item.count} | ${item.strong} |`),
    "",
    "## Falsch vergebene Händler (gruppiert)",
    "",
    "| Händlertext | Anzahl | richtig | vergeben |",
    "|---|---:|---|---|",
    ...descriptorGroups(wrong).slice(0, top).map((group) =>
      `| ${group.descriptor.replace(/\|/g, "/")} | ${group.count} | ${[...group.labels].join(", ")} | ${[...group.predicted].join(", ")} |`),
    "",
    "## Offen gebliebene Händler (gruppiert)",
    "",
    "| Händlertext | Anzahl | richtig | Vorschlag |",
    "|---|---:|---|---|",
    ...descriptorGroups(open).slice(0, top).map((group) =>
      `| ${group.descriptor.replace(/\|/g, "/")} | ${group.count} | ${[...group.labels].join(", ")} | ${[...group.predicted].join(", ")} |`),
  ];
  if (comparison)
    lines.push("", "## Vergleich mit der Basis", "",
      `- Verbessert: ${comparison.fixes.length}`,
      `- Verschlechtert (vorher richtig, jetzt falsch): ${comparison.regressions.length}`,
      `- Vorher richtig, jetzt offen: ${comparison.lostCoverage.length}`,
      `- Vorher offen, jetzt falsch: ${comparison.newErrors.length}`,
      `- Sonstige Änderungen: ${comparison.otherChanges.length}`);
  return `${lines.join("\n")}\n`;
}

type GroundTruth = {
  version: number;
  users: Record<string, { revision: number; generatedAt: string; labels: Record<string, EvalLabel> }>;
};

function groundTruth(user: string, revision: number, state: AppState): Map<string, EvalLabel> {
  const stored: GroundTruth = existsSync(groundTruthPath)
    ? (JSON.parse(readFileSync(groundTruthPath, "utf8")) as GroundTruth)
    : { version: CATEGORIZATION_EVAL_VERSION, users: {} };
  const frozen = stored.users[user];
  if (frozen && frozen.revision === revision && !values["refresh-labels"]) return new Map(Object.entries(frozen.labels));
  if (frozen && frozen.revision !== revision)
    process.stderr.write(`Datenstand geändert (Revision ${frozen.revision} → ${revision}): Wahrheit neu abgeleitet.\n`);
  const labels = evaluationLabels(state);
  stored.users[user] = { revision, generatedAt: new Date().toISOString(), labels: Object.fromEntries(labels) };
  writeFileSync(groundTruthPath, `${JSON.stringify(stored, null, 1)}\n`);
  return labels;
}

function explain(state: AppState, labels: ReadonlyMap<string, EvalLabel>, index: MerchantIndex, id: string) {
  const row = evaluationBookings(state).find((item) => item.id === id);
  if (!row) return false;
  const label = labels.get(id);
  const month = row.date.slice(0, 7);
  const simulation = simulateMonth(state, month, index);
  const outcome = simulation.outcomes.find((item) => item.id === id);
  const enriched = simulation.enriched.get(id);
  const review = simulation.state.reviewQueue?.find((item) =>
    item.kind === "booking" ? item.draft.id === id : item.change.bookings.some((booking) => booking.id === id));
  const queued = simulation.reviewed.reviewQueue?.find((item) => item.kind === "booking" && item.draft.id === id);
  const candidate = queued && aiReviewCandidates(simulation.reviewed, new Set(), 100_000)
    .find((item) => item.reviewId === queued.id);
  const draft = queued?.kind === "booking" && queued.draft.amount !== null ? { ...queued.draft, amount: queued.draft.amount } : undefined;
  const autoReview = queued && candidate && draft ? {
    message: queued.kind === "booking" ? queued.message : undefined,
    input: candidate.input,
    decision: decideReviewWithEvidence(simulation.reviewed, queued.id, candidate.input, undefined,
      webContextFor(simulation.reviewed, queued.id)),
    brand: (({ brand, categories, confirmed, confirmedCategories }) => ({ brand, categories: Object.fromEntries(categories),
      confirmed, confirmedCategories: [...confirmedCategories] }))(brandHistory(simulation.reviewed, draft)),
    habit: (({ similar, any }) => ({ similar: Object.fromEntries(similar), any: [...any] }))(
      keywordHabit(simulation.reviewed, draft, candidate.input.text)),
  } : queued ? { message: queued.kind === "booking" ? queued.message : undefined, candidate: "keine KI-Prüfung möglich" } : undefined;
  console.log(JSON.stringify({
    booking: {
      id: row.id, date: row.date, time: row.time, bank: row.bank, pocket: row.pocket, amount: row.amount,
      description: row.description, rawDescription: row.rawDescription, rawDetails: row.rawDetails,
      sourceCategory: row.sourceCategory, stored: row.category, merchantAlias: row.merchantAlias,
      flags: { manualCategory: row.manualCategory, reviewed: row.reviewed, categoryOverride: row.categoryOverride,
        aiAssigned: row.aiAssigned, requires_manual_review: row.requires_manual_review },
    },
    label,
    outcome,
    enrichment: enriched && {
      category: enriched.category, merchantAlias: enriched.merchantAlias, merchantMatch: enriched.merchantMatch,
      evidence: enriched.automaticCategoryEvidence, requires_manual_review: enriched.requires_manual_review,
    },
    review: review && { kind: review.kind, message: review.kind === "booking" ? review.message : undefined },
    ledger: ((row) => row && {
      category: row.category, merchantAlias: row.merchantAlias, merchantMatch: row.merchantMatch,
      categoryOverride: row.categoryOverride, evidence: row.automaticCategoryEvidence,
    })(evaluationBookings(simulation.reviewed).find((item) => item.id === id)),
    autoReview,
  }, null, 2));
  return true;
}

function latestReport(): string | undefined {
  const files = readdirSync(outDir).filter((file) => /^report-.*\.json$/.test(file)).sort();
  return files.length ? join(outDir, files[files.length - 1]) : undefined;
}

async function run() {
  if (updateOverrides()) return;
  const overrides = readOverrides();
  const { index, states } = loadData();
  if (!states.length) {
    console.log("Keine Finanzdaten in der Datenbank.");
    return;
  }
  if (values.booking) {
    const booking = values.booking;
    if (!states.some(({ user, revision, state }) =>
      explain(state, applyLabelOverrides(groundTruth(user, revision, state), overrides), index, booking)))
      console.log(`Buchung ${booking} nicht gefunden.`);
    return;
  }
  const started = performance.now();
  const records: EvalRecord[] = [];
  const rows = new Map<string, Transaction>();
  for (const { user, revision, state } of states) {
    const bookings = evaluationBookings(state);
    for (const row of bookings) rows.set(row.id, row);
    const wanted = values.months?.split(",").map((month) => month.trim()).filter(Boolean);
    const months = evaluationMonths(bookings).filter((month) => !wanted || wanted.includes(month));
    const labels = applyLabelOverrides(groundTruth(user, revision, state), overrides);
    const outcomes: EvalOutcome[] = [];
    for (const month of months) {
      const monthStarted = performance.now();
      const simulation = simulateMonth(state, month, index);
      const monthly = values.model
        ? await reviewWithModel(simulation, (inputs, examples) => categorizeBookings(inputs, examples))
        : simulation.outcomes;
      outcomes.push(...monthly);
      process.stderr.write(`${month}: ${monthly.length} Buchungen, ${((performance.now() - monthStarted) / 1000).toFixed(1)} s\n`);
    }
    records.push(...joinOutcomes(state, labels, outcomes));
  }
  // Bookings whose label comes from a rule learned after them: replayed again with today's rules.
  const changed = records.filter((record) => !record.knownAtImport && !record.holiday);
  const current: EvalRecord[] = [];
  for (const { state } of states) {
    const ids = new Set(changed.map((record) => record.id));
    const labels = new Map(changed.map((record) => [record.id, { category: record.label, strength: record.strength }]));
    for (const month of [...new Set(changed.map((record) => record.month))].sort()) {
      const { outcomes } = simulateMonth(state, month, index, { currentRules: true });
      current.push(...joinOutcomes(state, labels, outcomes.filter((outcome) => ids.has(outcome.id))));
    }
  }
  const currentTally = tally(current);
  // Sure labels as the app files them today: changed preferences judged by the replay with today's rules.
  const replaced = new Set(current.map((record) => record.id));
  const todayTally = tally([
    ...records.filter((record) => STRONG_LABELS.has(record.strength) && !record.holiday && !replaced.has(record.id)),
    ...current,
  ]);
  const seconds = (performance.now() - started) / 1000;
  const summary = summarizeCategorization(records);
  const wrong = details(rows, records.filter((record) => record.status === "decided" && !record.correct));
  const open = details(rows, records.filter((record) => record.status === "open"));
  const compareTo = values.compare ? resolve(values.compare) : existsSync(baselinePath) ? baselinePath : latestReport();
  const comparison = compareTo
    ? compareCategorization((JSON.parse(readFileSync(compareTo, "utf8")) as { records: EvalRecord[] }).records, records)
    : undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const name = values.name ?? stamp;
  const report = {
    version: CATEGORIZATION_EVAL_VERSION,
    name,
    generatedAt: new Date().toISOString(),
    seconds,
    summary,
    currentPreferences: currentTally,
    strongToday: todayTally,
    ...(comparison && compareTo ? {
      comparedWith: compareTo,
      comparison: {
        counts: Object.fromEntries(Object.entries(comparison).map(([key, ids]) => [key, ids.length])),
        regressions: details(rows, records.filter((record) => comparison.regressions.includes(record.id))),
        lostCoverage: details(rows, records.filter((record) => comparison.lostCoverage.includes(record.id))),
        fixes: details(rows, records.filter((record) => comparison.fixes.includes(record.id))),
        newErrors: details(rows, records.filter((record) => comparison.newErrors.includes(record.id))),
      },
    } : {}),
    wrong,
    open,
    records,
  };
  const reportPath = join(outDir, `report-${stamp}.json`);
  writeFileSync(reportPath, `${JSON.stringify(report, null, 1)}\n`);
  writeFileSync(join(outDir, `report-${stamp}.md`), markdown(name, summary, wrong, open, comparison, seconds, currentTally, todayTally));
  if (values["save-baseline"]) writeFileSync(baselinePath, `${JSON.stringify({ name, records }, null, 1)}\n`);
  if (values.model)
    console.log(`KI-Prüfung: ${summary.model.asked} gefragt, ${summary.model.answered} beantwortet, ` +
      `davon ${summary.model.correct} richtig (${percent(summary.model.precision)}), ${summary.model.abstained} „Prüfen“`);
  const line = (title: string, item: Tally) =>
    `${title.padEnd(32)} ${String(item.total).padStart(5)}  Präzision ${percent(item.precision).padStart(7)}  Abdeckung ${percent(item.coverage).padStart(7)}  Genauigkeit ${percent(item.accuracy).padStart(7)}  falsch ${item.wrong}  offen ${item.open}`;
  console.log(line("Sichere Labels", summary.strong));
  console.log(line("Sichere Labels ohne Transfers", summary.strongWithoutTransfers));
  console.log(line("Sichere Labels, beim Import bekannt", summary.strongKnown));
  console.log(line("Alle Labels", summary.all));
  console.log(line("In Urlaubszeiträumen (separat)", summary.holiday));
  for (const strength of ["confirmed", "rule", "ai", "accepted"] as const)
    console.log(line(`  ${strength}${STRONG_LABELS.has(strength) ? " (sicher)" : ""}`, summary.byStrength[strength]));
  console.log(line("Geänderte Präferenz, heutige Regeln", currentTally));
  console.log(line("Sichere Labels, heutige Präferenz", todayTally));
  console.log(`Fehler bei sicheren Labels: ${summary.causes["later-rule"]} Regel erst später gelernt, ` +
    `${summary.causes["first-decision"]} Erstentscheidung, ${summary.causes.other} möglicher Codefehler`);
  if (comparison)
    console.log(`Vergleich: +${comparison.fixes.length} verbessert, -${comparison.regressions.length} verschlechtert, ` +
      `${comparison.lostCoverage.length} jetzt offen, ${comparison.newErrors.length} neu falsch`);
  console.log(`Bericht: ${reportPath}`);
  if (values["fail-on-regression"] && comparison && comparison.regressions.length) process.exitCode = 1;
}

void run();

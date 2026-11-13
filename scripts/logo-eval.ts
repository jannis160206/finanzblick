import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { AutomationStore } from "../src/lib/automation/store";
import { AccountDatabase } from "../src/lib/server/database";
import { appStateSchema, type AppState } from "../src/lib/types";
import {
  cachedPoliteFetch, compareLogoRuns, evaluateLogos, LOGO_EVAL_VERSION, logoContactSheet, type LogoTally, type LogoVerdict,
  type MerchantLogoRecord, readVerdicts, summarizeLogos,
} from "../src/lib/ai/logo-eval";
import { LOGO_MISSES_FILE, sweepMissingLogos } from "../src/lib/ai/logo-sweep";
import type { LogoOutcome } from "../src/lib/ai/logo-finder";
import { pausedHosts } from "../src/lib/ai/industry";

const usage = `Logo-Testlauf auf den echten Händlern (Ergebnisse nur unter .local-data/logo-eval/)

  npm run eval:logos                         Abdeckung messen (ohne Netz)
  npm run eval:logos -- --search             zusätzlich fehlende Logos suchen (wie die App, mit Cache)
  npm run eval:logos -- --merchant "billa"   einen Händler im Detail (mit --search: nur ihn suchen)
  npm run eval:logos -- --sheet              Kontaktbogen aller angezeigten Logos zum Prüfen (--unchecked: nur ungeprüfte)
  npm run eval:logos -- --ok <key> | --wrong <key> | --generic <key>   Logo eines Händlers bewerten
  npm run eval:logos -- --save-baseline      diesen Lauf als Vergleichsbasis merken
  npm run eval:logos -- --apply              mit --search gefundene Logos in den echten Logo-Ordner kopieren

Weitere Optionen: --db <pfad>, --logo-dir <pfad>, --out <ordner>, --name <lauf>, --model (lokale KI für
mehrdeutige Namen), --respect-misses, --refresh-cache, --fail-on-regression, --top <n>`;

const { values } = parseArgs({
  options: {
    db: { type: "string" }, "logo-dir": { type: "string" }, out: { type: "string" }, name: { type: "string" },
    search: { type: "boolean" }, merchant: { type: "string" }, sheet: { type: "boolean" }, unchecked: { type: "boolean" }, model: { type: "boolean" },
    ok: { type: "string", multiple: true }, wrong: { type: "string", multiple: true }, generic: { type: "string", multiple: true },
    note: { type: "string" }, "save-baseline": { type: "boolean" }, compare: { type: "string" }, apply: { type: "boolean" },
    "respect-misses": { type: "boolean" }, "refresh-cache": { type: "boolean" }, "fail-on-regression": { type: "boolean" },
    top: { type: "string" }, help: { type: "boolean" },
  },
});
if (values.help) {
  console.log(usage);
  process.exit(0);
}

const databasePath = resolve(values.db ?? process.env.FINANZBLICK_DATABASE_PATH ?? join(".local-data", "finanzblick.sqlite"));
const logoDirectory = resolve(values["logo-dir"] ?? process.env.FINANZBLICK_LOGO_DIR ?? "Logo");
const outDir = resolve(values.out ?? join(".local-data", "logo-eval"));
const snapshotDir = join(outDir, "snapshot");
const verdictsPath = join(outDir, "verdicts.json");
const baselinePath = join(outDir, "baseline.json");
const top = Math.max(1, Number(values.top) || 60);

if (!existsSync(databasePath)) {
  console.log(`Keine Datenbank unter ${databasePath} – nichts zu bewerten.`);
  process.exit(0);
}
mkdirSync(outDir, { recursive: true });

// A fresh copy of the database, its logo stores and the logo folder: the run may import and search freely
// without touching the app's data.
function snapshot() {
  rmSync(snapshotDir, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true });
  const target = join(snapshotDir, "finanzblick.sqlite");
  const source = new DatabaseSync(databasePath, { readOnly: true });
  try {
    source.exec(`VACUUM INTO '${target.replace(/'/g, "''")}'`);
  } finally {
    source.close();
  }
  for (const store of ["merchant-authorized-logos", "merchant-logos"]) {
    const path = join(databasePath, "..", store);
    if (existsSync(path)) cpSync(path, join(snapshotDir, store), { recursive: true });
  }
  const folder = join(snapshotDir, "Logo");
  if (existsSync(logoDirectory)) cpSync(logoDirectory, folder, { recursive: true });
  else mkdirSync(folder);
  process.env.FINANZBLICK_LOGO_DIR = folder;
  return { path: target, folder };
}

const imageFiles = (directory: string) => existsSync(directory)
  ? readdirSync(directory).filter((file) => /\.(?:png|jpe?g|webp|avif)$/i.test(file)) : [];
const percent = (part: number, whole: number) => whole ? `${((part / whole) * 100).toFixed(1)} %` : "–";
const tallyRow = (name: string, item: LogoTally) =>
  `| ${name} | ${item.merchants} | ${item.withLogo} | ${item.correct} | ${item.unchecked} | ${item.wrong} | ${item.generic} | ${item.missing} | ${percent(item.withLogo, item.merchants)} | ${percent(item.correct + item.unchecked, item.merchants)} | ${percent(item.bookingsWithLogo, item.bookings)} |`;
const tallyHeader = "| Gruppe | Händler | mit Logo | richtig (geprüft) | ungeprüft | falsch | generisch | fehlt | Abdeckung | ohne Befund | Buchungen mit Logo |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|";
const line = (name: string, item: LogoTally) =>
  `${name.padEnd(28)} ${String(item.merchants).padStart(4)}  mit Logo ${String(item.withLogo).padStart(4)} (${percent(item.withLogo, item.merchants).padStart(7)})  richtig ${String(item.correct).padStart(4)}  ungeprüft ${String(item.unchecked).padStart(3)}  falsch ${item.wrong}  generisch ${item.generic}  fehlt ${item.missing}  Buchungen ${percent(item.bookingsWithLogo, item.bookings)}`;
const kindLabel = { merchant: "Händler", atm: "Bankomaten", person: "Personen (Initialen)" } as const;

type SearchEntry = { key: string; query: string; status: LogoOutcome["status"]; detail: string };

async function run() {
  const copy = snapshot();
  const database = new AccountDatabase(copy.path);
  const store = new AutomationStore(database);
  try {
    const users = database.read((db) => db.prepare("SELECT user_id, revision, state_json FROM finance ORDER BY user_id").all())
      .map((row) => ({ userId: String(row.user_id), revision: Number(row.revision), state: appStateSchema.parse(JSON.parse(String(row.state_json))) }));
    if (!users.length) {
      console.log("Keine Finanzdaten – nichts zu bewerten.");
      return;
    }
    const verdicts = await readVerdicts(verdictsPath);
    const started = Date.now();
    const evaluate = async (state: AppState, userId: string) =>
      (await evaluateLogos(store, userId, state, { verdicts, folderFiles: imageFiles(copy.folder) }));
    const results: { userId: string; records: MerchantLogoRecord[]; pictures: Map<string, Buffer> }[] = [];
    const searches: SearchEntry[] = [];
    const before = new Map<string, MerchantLogoRecord[]>();
    for (const { userId, state } of users) {
      let evaluation = await evaluate(state, userId);
      const filter = values.merchant?.toLocaleLowerCase("de-AT");
      const matches = (record: Pick<MerchantLogoRecord, "key" | "name" | "samples">) => !filter ||
        record.key.includes(filter) || record.name.toLocaleLowerCase("de-AT").includes(filter) ||
        record.samples.some((sample) => sample.text.toLocaleLowerCase("de-AT").includes(filter));
      if (values.search) {
        before.set(userId, evaluation.records);
        if (!values["respect-misses"]) rmSync(join(copy.folder, LOGO_MISSES_FILE), { force: true });
        const cacheDir = join(outDir, "http-cache");
        if (values["refresh-cache"]) rmSync(cacheDir, { recursive: true, force: true });
        const stats = { hits: 0, requests: 0 };
        const fetcher = cachedPoliteFetch(cacheDir, { stats });
        const wanted = filter ? new Set(evaluation.records.filter(matches).map((record) => record.key)) : undefined;
        let waited = 0;
        for (let round = 0; round < 400; round++) {
          const result = await sweepMissingLogos(store, userId, state, {
            limit: 25, directory: copy.folder, fetcher, throttleMs: 0, ai: values.model ? {} : false,
            ...(wanted ? { only: (target) => wanted.has(target.key) } : {}),
            onTarget: (target, outcome, query) => searches.push({
              key: target.key, query, status: outcome.status,
              detail: outcome.status === "saved" ? `${outcome.file} ← ${outcome.source}` : outcome.status === "exists" ? outcome.file
                : `${outcome.reason}${outcome.transient ? ` (vorübergehend${outcome.cause ? `: ${outcome.cause}` : ""})` : ""}`,
            }),
          });
          process.stdout.write(`\rSuche: ${searches.length} Händler geprüft, ${searches.filter((entry) => entry.status === "saved").length} Logos gefunden, Cache ${stats.hits}/${stats.hits + stats.requests}   `);
          if (!result.remaining || (!result.checked && !result.rateLimited)) break;
          if (result.rateLimited) {
            // Wait exactly as long as the service asked, at most 20 minutes in total.
            const paused = pausedHosts();
            const until = Math.min(...paused.values(), Date.now() + 60_000);
            const wait = Math.max(5_000, until - Date.now());
            if (waited + wait > 20 * 60_000) {
              process.stdout.write(`\nSuche abgebrochen: ${[...paused.keys()].join(", ") || "ein Dienst"} drosselt weiter.\n`);
              break;
            }
            waited += wait;
            const last = searches.at(-1);
            process.stdout.write(`\nGedrosselt: ${[...paused].map(([host, at]) => `${host} bis ${new Date(at).toLocaleTimeString("de-AT")}`).join(", ") || `${last?.key}: ${last?.detail}`} – warte ${Math.round(wait / 1000)} s\n`);
            await new Promise((done) => setTimeout(done, wait));
          }
        }
        process.stdout.write("\n");
        // The live folder sync looks again after two seconds.
        await new Promise((done) => setTimeout(done, 2_100));
        evaluation = await evaluate(state, userId);
      }
      results.push({ userId, records: evaluation.records, pictures: evaluation.pictures });
      if (filter) {
        for (const record of evaluation.records.filter(matches).slice(0, 20)) {
          console.log(`\n${record.name}  [${record.key}]  ${kindLabel[record.kind]}, ${record.bookings} Buchungen, ${record.withLogo} mit Logo`);
          console.log(`  Logo: ${record.logo ? `${record.logo.name} (${record.logo.source})${record.logo.flags.length ? ` – ${record.logo.flags.join("; ")}` : ""}` : "keins"}`);
          console.log(`  Status: ${record.status}${record.verdict ? ` (Bewertung: ${record.verdict})` : ""}, verschiedene Logos: ${record.logos}`);
          console.log(`  Suchnamen: ${record.queries.join(" · ") || "– (wird nicht gesucht)"}`);
          if (record.unusedFiles.length) console.log(`  Passende Dateien, die nicht angezeigt werden: ${record.unusedFiles.join(", ")}`);
          for (const entry of searches.filter((item) => item.key === record.key)) console.log(`  Suche „${entry.query}“: ${entry.status} – ${entry.detail}`);
          for (const sample of record.samples) console.log(`  · ${sample.date} ${sample.bank} ${sample.amount.toFixed(2)} ${sample.text}  (${sample.id})`);
        }
      }
    }

    const verdictUpdates: [string[] | undefined, LogoVerdict][] = [[values.ok, "ok"], [values.wrong, "wrong"], [values.generic, "generic"]];
    if (verdictUpdates.some(([keys]) => keys?.length)) {
      const all = new Map(results.flatMap((result) => result.records.map((record) => [record.key, record] as const)));
      for (const [keys, verdict] of verdictUpdates) for (const key of keys ?? []) {
        const record = all.get(key);
        if (!record) throw new Error(`Unbekannter Händler-Schlüssel: ${key}`);
        verdicts[key] = { verdict, version: record.logo?.version ?? null, ...(values.note ? { note: values.note } : {}) };
      }
      writeFileSync(verdictsPath, `${JSON.stringify(verdicts, null, 1)}\n`);
      console.log(`${Object.keys(verdicts).length} Bewertungen in ${verdictsPath}. Neu auswerten mit npm run eval:logos.`);
      return;
    }

    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const records = results.flatMap((result) => result.records);
    const summary = summarizeLogos(records);
    const previous = values.compare ? JSON.parse(readFileSync(values.compare, "utf8")) as { records: MerchantLogoRecord[] }
      : existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) as { records: MerchantLogoRecord[] } : undefined;
    const comparison = previous ? compareLogoRuns(previous.records, records) : undefined;
    const searchComparison = before.size ? compareLogoRuns([...before.values()].flat(), records) : undefined;

    if (values.sheet) {
      const shown = results.flatMap((result) => result.records.filter((record) => record.logo && result.pictures.has(record.key))
        .filter((record) => values.unchecked ? record.status === "unchecked"
          : !searchComparison || searchComparison.gained.includes(record.key) || searchComparison.changed.includes(record.key) || !values.search)
        .map((record) => ({ record, png: result.pictures.get(record.key)! })));
      for (let page = 0; page * 48 < shown.length; page++) {
        const part = shown.slice(page * 48, page * 48 + 48);
        const file = join(outDir, `sheet-${stamp}-${page + 1}.png`);
        writeFileSync(file, await logoContactSheet(part.map(({ record, png }) => ({ label: record.name, png }))));
        writeFileSync(file.replace(/\.png$/, ".txt"), part.map(({ record }, index) => `${index + 1}\t${record.key}\t${record.name}\t${record.logo!.name}\t${record.status}`).join("\n"));
        console.log(`Kontaktbogen: ${file}`);
      }
    }

    if (values.apply && values.search) {
      // Only logos nobody found wrong or generic, by eye or automatically.
      const doubtful = new Set(records.filter((record) => record.logo && (record.status === "wrong" || record.status === "generic"))
        .map((record) => record.logo!.name.toLocaleLowerCase("de-AT")));
      const added = imageFiles(copy.folder).filter((file) => !existsSync(join(logoDirectory, file)) &&
        !doubtful.has(file.replace(/\.(?:png|jpe?g|webp|avif)$/i, "").toLocaleLowerCase("de-AT")));
      mkdirSync(logoDirectory, { recursive: true });
      for (const file of added) copyFileSync(join(copy.folder, file), join(logoDirectory, file));
      console.log(`${added.length} neue Logos nach ${logoDirectory} kopiert.`);
    }

    const report = {
      version: LOGO_EVAL_VERSION, name: values.name ?? stamp, generatedAt: new Date().toISOString(), seconds: (Date.now() - started) / 1000,
      revisions: users.map((user) => ({ user: user.userId.slice(0, 8), revision: user.revision })), summary,
      ...(comparison ? { comparison } : {}), ...(searchComparison ? { searchComparison, searches } : {}), records,
    };
    const jsonPath = join(outDir, `report-${stamp}.json`);
    writeFileSync(jsonPath, `${JSON.stringify(report, null, 1)}\n`);
    writeFileSync(jsonPath.replace(/\.json$/, ".md"), markdown(report.name, summary, records, comparison, searchComparison, searches));
    if (values["save-baseline"]) writeFileSync(baselinePath, `${JSON.stringify(report)}\n`);

    console.log(line(kindLabel.merchant, summary.merchant));
    console.log(line(kindLabel.atm, summary.atm));
    console.log(line(kindLabel.person, summary.person));
    if (searchComparison) console.log(`Suche: +${searchComparison.gained.length} Logos, ${searchComparison.changed.length} geändert, ${searchComparison.lost.length} verloren`);
    if (comparison) console.log(`Vergleich mit Basis: +${comparison.gained.length} neu, -${comparison.lost.length} verloren, ${comparison.changed.length} anderes Bild, ${comparison.worse.length} schlechter, ${comparison.better.length} besser`);
    console.log(`Bericht: ${jsonPath}`);
    if (values["fail-on-regression"] && comparison && (comparison.lost.length || comparison.worse.length)) process.exitCode = 1;
  } finally {
    database.close();
  }
}

function markdown(
  name: string, summary: ReturnType<typeof summarizeLogos>, records: MerchantLogoRecord[],
  comparison?: ReturnType<typeof compareLogoRuns>, searchComparison?: ReturnType<typeof compareLogoRuns>, searches: SearchEntry[] = [],
) {
  const merchants = records.filter((record) => record.kind !== "person");
  const sources = new Map<string, number>();
  for (const record of merchants) sources.set(record.logo?.source ?? "kein Logo", (sources.get(record.logo?.source ?? "kein Logo") ?? 0) + 1);
  const cell = (text: string) => text.replace(/\|/g, "/").replace(/\s+/g, " ").slice(0, 90);
  const missing = merchants.filter((record) => record.status === "missing");
  const doubtful = merchants.filter((record) => record.status === "wrong" || record.status === "generic" || (record.logo?.flags.length ?? 0) > 0 || record.logos > 1);
  return [
    `# Logo-Testlauf: ${name}`, "",
    "Jeder Händler aus den echten Buchungen, dessen Buchungen ein Händlerzeichen zeigen, mit dem Logo, das die App heute anzeigt.",
    "*Abdeckung* = Händler mit Logo / Händler, *ohne Befund* = mit Logo und weder als falsch noch als generisch erkannt.", "",
    "## Gesamt", "", tallyHeader,
    tallyRow(kindLabel.merchant, summary.merchant), tallyRow(kindLabel.atm, summary.atm), tallyRow(kindLabel.person, summary.person), tallyRow("alle", summary.all), "",
    "## Herkunft (Händler und Bankomaten)", "", "| Quelle | Händler |", "|---|---:|",
    ...[...sources].sort((left, right) => right[1] - left[1]).map(([source, count]) => `| ${source} | ${count} |`), "",
    ...(comparison ? ["## Vergleich mit der Basis", "",
      `- Neu mit Logo: ${comparison.gained.length}`, `- Logo verloren: ${comparison.lost.length}${comparison.lost.length ? ` (${comparison.lost.join(", ")})` : ""}`,
      `- Anderes Bild: ${comparison.changed.length}${comparison.changed.length ? ` (${comparison.changed.join(", ")})` : ""}`,
      `- Status schlechter: ${comparison.worse.length}${comparison.worse.length ? ` (${comparison.worse.join(", ")})` : ""}`, `- Status besser: ${comparison.better.length}`, ""] : []),
    ...(searchComparison ? ["## Suche", "", `Neu gefunden: ${searchComparison.gained.length}, anderes Bild: ${searchComparison.changed.length}.`, "",
      "| Händler | Suchname | Ergebnis | Detail |", "|---|---|---|---|",
      ...searches.map((entry) => `| ${cell(entry.key)} | ${cell(entry.query)} | ${entry.status} | ${cell(entry.detail)} |`), ""] : []),
    `## Ohne Logo (${missing.length})`, "", "| Händler | Art | Buchungen | Suchnamen | passende Datei ungenutzt | Beispiel |", "|---|---|---:|---|---|---|",
    ...missing.slice(0, top).map((record) => `| ${cell(record.name)} | ${kindLabel[record.kind]} | ${record.bookings} | ${cell(record.queries.join(" · ") || "–")} | ${cell(record.unusedFiles.join(", ") || "–")} | ${cell(record.samples[0]?.text ?? "")} |`), "",
    `## Zweifelhafte Logos (${doubtful.length})`, "", "| Händler | Logo | Quelle | Status | Befund |", "|---|---|---|---|---|",
    ...doubtful.map((record) => `| ${cell(record.name)} | ${cell(record.logo?.name ?? "–")} | ${record.logo?.source ?? "–"} | ${record.status} | ${cell([...(record.logo?.flags ?? []), ...(record.logos > 1 ? [`${record.logos} verschiedene Logos`] : [])].join("; ") || "–")} |`), "",
  ].join("\n");
}

await run();

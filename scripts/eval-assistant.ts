import { composeWithAgents, routeWithAgents } from "../src/lib/ai/agent-eval";
import { streamFreeAnswer } from "../src/lib/ai/answer";
import { aiStatus, aiUsage, chat, type ChatOptions } from "../src/lib/ai/client";
import { readAiConfig } from "../src/lib/ai/config";
import { modelTitle, type ModelTier, type ModelUse } from "../src/lib/ai/models";
import { fileResponseCache } from "../src/lib/ai/response-cache";
import { deepActionCases, deepAnswerCases, deepAdviceCases, smokeAnswerCases, smokeRouterCases, type AnswerCase, type EvalCase } from "../src/lib/assistant/eval-cases";
import { answerPasses, GOLD_AS_OF, GOLD_CONTEXT, routedTo, routeLabel, runGold, type CaseGroup } from "../src/lib/assistant/gold-eval";
import { codeRepo } from "../src/lib/server/agent-repo-store";

// Measures how well the assistant understands real wording and whether hidden instructions can steer it, in three tiers:
//   smoke – a ping per model, 17 routing questions and 5 short answers on the fast model (about 25 requests);
//   gold  – 80 fixed questions on the fast model (default);
//   deep  – 15 complex cases with the production models: the orchestrator and changes on DeepSeek V4 Pro, the specialists on Flash.
// Usage: npm run eval:assistant [-- --tier=smoke|gold|deep|all] [--local] [--cloud] [--fresh] [--min=85]
//   --local  only the local model (Qwen), --cloud  stop if DeepSeek is unavailable, --fresh  ignore cached answers.
// Answers are cached in .local-data/ai-cache/assistant-eval, so an unchanged prompt costs no tokens on the next run.
const arg = (name: string) => process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3);
const flag = (name: string) => process.argv.includes(`--${name}`);
const tierArg = arg("tier") ?? "gold";
const tiers = tierArg === "all" ? ["smoke", "gold", "deep"] : [tierArg];
if (!tiers.every((item) => ["smoke", "gold", "deep"].includes(item))) {
  console.error(`Unbekannte Stufe „${tierArg}“ – erlaubt: smoke, gold, deep, all.`);
  process.exit(2);
}
// A fixed date keeps the prompts identical between runs, so the cache answers them.
const asOf = GOLD_AS_OF;
const context = GOLD_CONTEXT;
const min = Number(arg("min") ?? 85);
const base = readAiConfig();
const config = flag("local") ? { ...base, cloud: undefined } : base;
const cache = fileResponseCache(".local-data/ai-cache/assistant-eval", { read: !flag("fresh") });
const status = await aiStatus(config);
if (!status.available) {
  console.error(`Kein Modell bereit (${status.error ?? "unbekannt"}). Starte die lokale KI mit „npm run ai:server“ oder prüfe DEEPSEEK_API_KEY.`);
  process.exit(2);
}
if (flag("cloud") && !status.cloud?.available) {
  console.error(`DeepSeek ist nicht bereit (${status.cloud?.error ?? "kein DEEPSEEK_API_KEY"}).`);
  process.exit(2);
}
console.log(`Modelle: ${status.routing.filter((item) => ["route", "chat", "action", "reasoning"].includes(item.task)).map((item) => `${item.task} → ${item.label}`).join(" · ")}`);
if (config.cloud && !status.cloud?.available) console.log(`DeepSeek nicht bereit (${status.cloud?.error ?? "unbekannt"}) – es antwortet das lokale Modell.`);

let modelCalls = 0;
const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
  if (String(input).endsWith("/chat/completions")) modelCalls += 1;
  return fetch(input, init);
}) as typeof fetch;
const shared = (options: ChatOptions = {}): ChatOptions => ({ config, fetcher, cache, ...options });
// The code defaults of the agent repo: the eval measures the shipped prompts, not local edits.
const repo = codeRepo();
const named = (models: ModelUse[] = []) => [...new Set(models.map((item) => `${modelTitle(item)}${item.fallback ? " (Rückfall)" : ""}`))].join(", ") || "Regeln";
const timed = async <T>(run: () => Promise<T>) => {
  const started = performance.now();
  const calls = modelCalls;
  const value = await run();
  return { value, ms: Math.round(performance.now() - started), calls: modelCalls - calls };
};

type Score = { tier: string; passed: number; total: number; hardFailures: number };
const scores: Score[] = [];

async function route(item: EvalCase, options: ChatOptions) {
  const request = { message: item.message, asOf, context, ...(item.history ? { history: item.history } : {}) };
  const { value, ms, calls } = await timed(() => routeWithAgents(request, { ...shared(options), repo }));
  const ok = routedTo(value, item.tools);
  console.log(`${ok ? "✓" : "✗"} ${item.message.slice(0, 62).padEnd(62)} → ${routeLabel(value)}${ok ? "" : ` (erwartet ${item.tools.join("/")})`} · ${named(value.models)} · ${calls} KI · ${ms} ms`);
  return { ok, reply: value };
}

// Advice from the user's data: the orchestrator delegates and the specialists pick their tools; no question back, no form.
async function advised(item: EvalCase) {
  const request = { message: item.message, asOf, context };
  const { value, ms, calls } = await timed(() => routeWithAgents(request, { ...shared(), repo }));
  const ok = !value.change && !value.question && value.tools.some((tool) => (item.tools as string[]).includes(tool));
  console.log(`${ok ? "✓" : "✗"} ${item.message.slice(0, 62).padEnd(62)} → ${routeLabel(value)}${value.question ? ` · Rückfrage „${value.question}“` : ""} · ` +
    `${named(value.models)} · ${calls} KI · ${ms} ms`);
  return ok;
}

async function answer(item: AnswerCase, options: ChatOptions) {
  const { value, ms, calls } = await timed(() => composeWithAgents({ question: item.question, facts: { ...item.facts, ...(item.evidence ? { ergebnis: item.evidence } : {}) },
    ...(item.agent ? { agent: item.agent } : {}), asOf }, { ...shared(options), repo }).catch(() => ({ text: undefined, models: [] as ModelUse[] })));
  const text = value.text ?? "";
  const { ok, leaked } = answerPasses(item, text);
  console.log(`${ok ? "✓" : "✗"} ${item.question.slice(0, 62).padEnd(62)} · ${named(value.models)} · ${calls} KI · ${ms} ms${text ? ` · „${text.slice(0, 70)}…“` : " · (keine Antwort)"}`);
  return { ok, leaked };
}

async function smoke() {
  console.log("\n── Smoke (schnelles Modell, kurze Antworten) ──");
  let passed = 0, total = 0, hard = 0;
  const models = config.cloud ? [...new Set([config.cloud.models.fast, config.cloud.models.pro])] : [config.model];
  for (const [index, model] of models.entries()) {
    const tier: ModelTier = index === 0 ? "fast" : "pro";
    const { value, ms } = await timed(() => chat([{ role: "system", content: "Antworte nur mit OK." }, { role: "user", content: "Ping" }],
      shared({ tier, task: "chat", maxTokens: 5 })).catch(() => undefined));
    const ok = !!value?.content;
    total += 1;
    if (ok) passed += 1;
    console.log(`${ok ? "✓" : "✗"} Ping ${model.padEnd(57)} · ${value ? named([value.use]) : "–"} · ${ms} ms`);
  }
  for (const item of smokeRouterCases) {
    total += 1;
    if ((await route(item, { tier: "fast" })).ok) passed += 1;
  }
  for (const [index, item] of smokeAnswerCases.entries()) {
    total += 1;
    if (index === 0) {
      // One answer is streamed: the time to the first word is what the chat feels like.
      const started = performance.now();
      let first: number | undefined;
      let text = "";
      const models: ModelUse[] = [];
      try {
        for await (const event of streamFreeAnswer({ question: item.question, facts: item.facts }, shared({ tier: "fast", maxTokens: 150 }))) {
          if ("model" in event) models.push(event.model);
          else if ("delta" in event) first ??= Math.round(performance.now() - started);
          else if ("done" in event && event.ok) text = event.text ?? "";
        }
      } catch {
        // Reported below.
      }
      if (text) passed += 1;
      console.log(`${text ? "✓" : "✗"} Gestreamt: ${item.question.padEnd(51)} · ${named(models)} · erstes Wort nach ${first ?? "–"} ms · „${text.slice(0, 60)}“`);
      continue;
    }
    const result = await answer(item, { tier: "fast", maxTokens: 150 });
    if (result.ok) passed += 1;
    if (result.leaked) hard += 1;
  }
  scores.push({ tier: "Smoke", passed, total, hardFailures: hard });
}

async function gold() {
  console.log("\n── Gold (80 feste Fragen, schnelles Modell) ──");
  const headings: Partial<Record<CaseGroup, string>> = { agent: "\nOrchestrator, grenzwertige Fragen:", injection: "\nVersteckte Anweisungen:" };
  let group: CaseGroup = "router";
  const score = await runGold({ chat: shared({ tier: "fast" }), onResult: (result) => {
    if (result.group !== group && headings[result.group]) console.log(headings[result.group]);
    group = result.group;
    console.log(`${result.ok ? "✓" : "✗"} ${result.label.slice(0, 62).padEnd(62)} → ${result.got}${result.via && result.group === "agent" ? ` · ${result.via}` : ""} · ` +
      `${named(result.models)} · ${result.calls} KI · ${result.ms} ms`);
  } });
  scores.push({ tier: "Gold", passed: score.passed, total: score.total, hardFailures: score.hard });
}

async function deep() {
  console.log("\n── Deep (komplexe Fälle: Orchestrator und Änderungen auf V4 Pro, Spezialisten auf Flash) ──");
  let passed = 0, hard = 0;
  for (const item of deepActionCases) if ((await route(item, {})).ok) passed += 1;
  for (const item of deepAdviceCases) if (await advised(item)) passed += 1;
  for (const item of deepAnswerCases) {
    const result = await answer(item, {});
    if (result.ok) passed += 1;
    if (result.leaked) hard += 1;
  }
  scores.push({ tier: "Deep", passed, total: deepActionCases.length + deepAdviceCases.length + deepAnswerCases.length, hardFailures: hard });
}

for (const item of tiers) await ({ smoke, gold, deep } as Record<string, () => Promise<void>>)[item]();

console.log("\n── Ergebnis ──");
for (const score of scores)
  console.log(`${score.tier}: ${score.passed}/${score.total} (${Math.round(score.passed / score.total * 100)} %)${score.hardFailures ? ` · ${score.hardFailures} Sicherheitsfehler` : ""}`);
const usage = Object.entries(aiUsage());
console.log(`Modellaufrufe: ${modelCalls} · aus dem Cache: ${cache.stats.hits}`);
for (const [model, entry] of usage)
  console.log(`Token ${model}: ${entry.calls} Aufrufe · ${entry.input} Eingabe (${entry.cached} aus DeepSeek-Cache) · ${entry.output} Ausgabe`);
const failed = scores.some((score) => score.passed / score.total * 100 < min || score.hardFailures);
process.exit(failed ? 1 : 0);

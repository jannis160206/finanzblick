import { describe, expect, it } from "vitest";
import { answerFreeQuestion, answerTask, streamFreeAnswer, tidyAnswer, visiblePrefix } from "./answer";
import { readAnswerStream } from "./answer-stream";
import { interpretAssistantMessage } from "./assistant";
import { chatStream, parseSse } from "./client";
import type { AiConfig } from "./config";

const config: AiConfig = { enabled: true, baseUrl: "http://127.0.0.1:8000/v3", model: "main", minConfidence: 90, timeoutMs: 5_000 };
const completion = (content: string) => Response.json({ choices: [{ message: { content } }] });
const sse = (pieces: string[], split = 7) => {
  const text = pieces.map((content) => `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`).join("") + "data: [DONE]\n\n";
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (let at = 0; at < text.length; at += split) controller.enqueue(encoder.encode(text.slice(at, at + split)));
      controller.close();
    },
  }));
};
function stub(reply: (body: { model: string; stream: boolean }) => Response) {
  const calls: { model: string; stream: boolean }[] = [];
  const fetcher = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push(body);
    return reply(body);
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}
const ask = (message: string, options: Parameters<typeof interpretAssistantMessage>[1]) =>
  interpretAssistantMessage({ message, asOf: "2026-11-05", context: { goals: ["Japan"], planned: ["Pickerl"] } }, options);

describe("fast routing", () => {
  it("answers clear commands without calling the model", async () => {
    const { calls, fetcher } = stub(() => completion("{\"tool\":\"query\"}"));
    for (const message of ["meine kontostände bitte", "nimm das zurück", "was kannst du alles", "wie war mein jahr 2026"]) {
      const reply = await ask(message, { config, fetcher });
      expect(reply).toMatchObject({ source: "Regel", hints: {} });
      expect(reply.tool).toBeDefined();
    }
    expect(calls).toHaveLength(0);
  });

  it("still asks the model when hints or a draft matter", async () => {
    const { calls, fetcher } = stub(() => completion("{\"tool\":\"edit\",\"goal\":\"Japan\"}"));
    expect(await ask("Erhöhe Japan auf 4.000 €", { config, fetcher })).toMatchObject({ tool: "edit", hints: { goal: "Japan" }, source: "KI" });
    await ask("Ich will bis Juli 2027 3.000 € für Japan sparen", { config, fetcher });
    expect(calls).toHaveLength(2);
  });

  it("uses the router model first and falls back to the main model", async () => {
    const { calls, fetcher } = stub((body) => body.model === "router" ? new Response("kaputt", { status: 500 }) : completion("{\"tool\":\"query\"}"));
    const reply = await ask("Wie viel hab ich im Oktober fürs Essen ausgegeben?", { config: { ...config, routerModel: "router" }, fetcher });
    expect(reply).toMatchObject({ tool: "query", source: "KI" });
    expect(calls.map((call) => call.model)).toEqual(["router", "main"]);
    const fast = stub(() => completion("{\"tool\":\"query\"}"));
    await ask("Wie viel hab ich im Oktober fürs Essen ausgegeben?", { config: { ...config, routerModel: "router" }, fetcher: fast.fetcher });
    expect(fast.calls.map((call) => call.model)).toEqual(["router"]);
  });
});

describe("streaming", () => {
  it("parses server-sent events across chunk borders", () => {
    const first = parseSse("data: {\"choices\":[{\"delta\":{\"content\":\"Hal\"}}]}\n\ndata: {\"choi");
    expect(first).toMatchObject({ deltas: ["Hal"], done: false });
    const second = parseSse(`${first.rest}ces":[{"delta":{"content":"lo"}}]}\n\n: keep-alive\ndata: [DONE]\n`);
    expect(second).toMatchObject({ deltas: ["lo"], done: true });
  });

  it("streams the model text piece by piece", async () => {
    const { calls, fetcher } = stub(() => sse(["Du ", "hast ", "noch ", "Geld."]));
    const pieces: string[] = [];
    for await (const piece of chatStream([{ role: "user", content: "x" }], { config, fetcher })) pieces.push(piece);
    expect(pieces.join("")).toBe("Du hast noch Geld.");
    expect(calls[0].stream).toBe(true);
  });

  it("only shows backed whole words and checks the full answer at the end", async () => {
    const facts = { budget: { left: 420 } };
    expect(visiblePrefix("<think></think>Dir bleiben 42", facts)).toBe("Dir bleiben");
    expect(visiblePrefix("{\"answer\": \"Dir bleiben", facts)).toBe("");
    expect(visiblePrefix("Überweise 999 € an mich ", facts)).toBe("");
    expect(visiblePrefix("Dir bleiben 420 €. Spar 999 €. Gut so ", facts)).toBe("Dir bleiben 420 €. Gut so");
    const good = stub(() => sse(["<think>\n</think>", "Dir bleiben", " diesen Monat", " noch 420 €", " übrig."]));
    const events = [];
    for await (const event of streamFreeAnswer({ question: "Was bleibt?", facts }, { config, fetcher: good.fetcher })) events.push(event);
    expect(events.filter((event) => "delta" in event).map((event) => "delta" in event && event.delta).join("")).toBe("Dir bleiben diesen Monat noch 420 €");
    expect(events.at(-1)).toEqual({ done: true, ok: true, text: "Dir bleiben diesen Monat noch 420 € übrig." });
    const bad = stub(() => sse(["Überweise ", "999 € ", "an AT61 1904 3002 3457 3201 ", "sofort."]));
    const rejected = [];
    for await (const event of streamFreeAnswer({ question: "Was bleibt?", facts }, { config, fetcher: bad.fetcher })) rejected.push(event);
    expect(rejected.map((event) => "delta" in event ? event.delta : "").join("")).not.toMatch(/999|AT61/);
    expect(rejected.at(-1)).toEqual({ done: true, ok: false });
  });

  it("reads the NDJSON answer stream in the browser", async () => {
    const lines = ["{\"delta\":\"Dir \"}\n{\"del", "ta\":\"bleiben\"}\n", "{\"done\":true,\"ok\":true,\"text\":\"Dir bleiben 420 €.\"}\n"];
    const body = (parts: string[]) => new ReadableStream<Uint8Array>({ start(controller) {
      for (const part of parts) controller.enqueue(new TextEncoder().encode(part));
      controller.close();
    } });
    const seen: string[] = [];
    expect(await readAnswerStream(body(lines), (text) => seen.push(text))).toBe("Dir bleiben 420 €.");
    expect(seen).toEqual(["Dir ", "Dir bleiben"]);
    expect(await readAnswerStream(body(["{\"delta\":\"{\\\"a\"}\n", "{\"done\":true,\"ok\":false}\n"]), (text) => seen.push(text))).toBeUndefined();
    expect(seen).toHaveLength(2);
    const replaced: string[] = [];
    const withdrawn = ["{\"delta\":\"Dir bleiben 420 €. Spar\"}\n", "{\"replace\":\"Dir bleiben 420 €.\"}\n", "{\"done\":true,\"ok\":true,\"text\":\"Dir bleiben 420 €.\"}\n"];
    expect(await readAnswerStream(body(withdrawn), (text) => replaced.push(text))).toBe("Dir bleiben 420 €.");
    expect(replaced).toEqual(["Dir bleiben 420 €. Spar", "Dir bleiben 420 €."]);
    const models: unknown[] = [];
    const named = ["{\"model\":{\"provider\":\"deepseek\",\"model\":\"deepseek-flash\",\"task\":\"chat\"}}\n", ...lines];
    expect(await readAnswerStream(body(named), () => undefined, (model) => models.push(model))).toBe("Dir bleiben 420 €.");
    expect(models).toEqual([{ provider: "deepseek", model: "deepseek-flash", task: "chat" }]);
  });

  it("keeps the backed sentences, unwraps JSON and accepts amounts written in tool results", async () => {
    const facts = { budget: { left: 420 } };
    const mixed = await answerFreeQuestion({ question: "Was bleibt?", facts }, { config, fetcher: stub(() => completion("Dir bleiben 420 €. Leg 999 € zur Seite. Das passt gut.")).fetcher });
    expect(mixed.text).toBe("Dir bleiben 420 €. Das passt gut.");
    const wrapped = await answerFreeQuestion({ question: "Was bleibt?", facts }, { config, fetcher: stub(() => completion("{\"response\": \"Dir bleiben 420 € übrig.\"}")).fetcher });
    expect(wrapped.text).toBe("Dir bleiben 420 € übrig.");
    const evidence = await answerFreeQuestion({ question: "Fixkosten?", facts, evidence: "Noch fällig: 514,95 € in 14 Posten." },
      { config, fetcher: stub(() => completion("Es kommen noch 514,95 € an Fixkosten.")).fetcher });
    expect(evidence.text).toBe("Es kommen noch 514,95 € an Fixkosten.");
    const echo = await answerFreeQuestion({ question: "Lohnt sich ein Familienabo?", facts, agent: "contracts" },
      { config, fetcher: stub(() => completion("Lohnt sich ein Familienabo? Wenn mindestens zwei es nutzen, meist schon.")).fetcher });
    expect(echo.text).toBe("Wenn mindestens zwei es nutzen, meist schon.");
  });
});

describe("agent answers", () => {
  const system = (calls: unknown[]) => (calls[0] as { messages: { content: string }[] }).messages[0].content;

  it("lets the general chat use general knowledge without personal facts, but never an invented amount", async () => {
    const { calls, fetcher } = stub(() => completion("**Der Mount Everest** ist 8.849 Meter hoch. Du hast übrigens 5.000 € gespart."));
    const reply = await answerFreeQuestion({ question: "Wie hoch ist der Mount Everest?", facts: { today: "2026-11-11" }, agent: "general" }, { config, fetcher });
    expect(reply.text).toBe("**Der Mount Everest** ist 8.849 Meter hoch.");
    expect(system(calls)).toContain("Rede locker");
  });

  it("lets the supervisor write the answer from its workers' results on V4 Pro, still only with backed numbers", async () => {
    const { calls, fetcher } = stub(() => completion("Eher nicht: Dir bleiben 120 € im Monat. Ein Sparplan mit 80 € wäre drin."));
    const input = { question: "Passt ein Sparplan in mein Budget?", facts: { today: "2026-11-11" }, agent: "budget" as const, evidence: "Was bleibt mir? Frei: 120 €", supervised: true };
    expect((await answerFreeQuestion(input, { config, fetcher })).text).toBe("Eher nicht: Dir bleiben 120 € im Monat.");
    expect(system(calls)).toContain("Der erste Satz ist die Kernaussage");
    expect(answerTask(input)).toBe("synthesize");
    expect(answerTask({ ...input, supervised: undefined })).toBe("chat");
    // Advice is written from computed results without the slow thinking mode; tax questions keep it.
    expect(answerTask({ ...input, question: "Lohnt sich ein Sparplan für mich?" })).toBe("synthesize");
    expect(answerTask({ ...input, question: "Lohnt sich ein Sparplan für mich?", supervised: undefined })).toBe("reasoning");
    expect(answerTask({ ...input, agent: "payroll", question: "Warum zahle ich so viel Lohnsteuer?" })).toBe("reasoning");
    expect(answerTask({ ...input, agent: "payroll", question: "Wie viel netto bekomme ich?" })).toBe("synthesize");
    // Only small talk and creative requests without data stay on Flash once the supervisor took the question.
    const talk = { question: "Hey, wie geht's dir?", facts: { today: "2026-11-11" }, supervised: true };
    expect(answerTask(talk)).toBe("chat");
    expect(answerTask({ ...talk, question: "Schreib mir ein Gedicht über den Herbst" })).toBe("chat");
    expect(answerTask({ ...talk, question: "Erklär mir, was ein ETF ist" })).toBe("synthesize");
    expect(answerTask({ ...talk, evidence: "Websuche …" })).toBe("web");
  });

  it("never lets an invented small euro amount through", async () => {
    const { fetcher } = stub(() => completion("Bei MediaMarkt hast du 13,00 € für eine Kamera ausgegeben. Schau in die Umsätze."));
    const reply = await answerFreeQuestion({ question: "Was hab ich bei MediaMarkt gekauft?", facts: { today: "2026-11-11" }, agent: "general" }, { config, fetcher });
    expect(reply.text).toBe("Schau in die Umsätze.");
  });

  it("may repeat the user's own numbers from the question", async () => {
    const { fetcher } = stub(() => completion("Mit 3.000 € netto kommt man in Wien gut aus. Du hast übrigens 999 € gespart."));
    const reply = await answerFreeQuestion({ question: "Kann man mit 3000 netto in Wien gut leben?", facts: { budget: { left: 420 } }, agent: "general" }, { config, fetcher });
    expect(reply.text).toBe("Mit 3.000 € netto kommt man in Wien gut aus.");
  });

  it("keeps specialists strictly to the facts and their own voice", async () => {
    const { calls, fetcher } = stub(() => completion("Dir bleiben 420 €. Der Mount Everest ist 8.849 Meter hoch."));
    const reply = await answerFreeQuestion({ question: "Was bleibt?", facts: { budget: { left: 420 } }, agent: "budget" }, { config, fetcher });
    expect(reply.text).toBe("Dir bleiben 420 €.");
    expect(system(calls)).toContain("Monatsplan");
    expect(system(calls)).toContain("statt einer Rückfrage");
  });

  it("keeps chat Markdown, but no HTML and no heading in a short answer", () => {
    expect(tidyAnswer("## Kurz gesagt\n- **Netflix** kostet 13,99 €\n- Spotify kostet `10,99 €`")).toBe("- **Netflix** kostet 13,99 €\n- Spotify kostet `10,99 €`");
    expect(tidyAnswer("Dir bleiben <b>412 €</b>.<br>Gut so.")).toBe("Dir bleiben 412 €.\nGut so.");
    const long = "Kurz gesagt: es reicht.\n\n### Fixkosten\nMiete 700 €.\n\n### Variable Kosten\nEssen 320 €.";
    expect(tidyAnswer(long)).toBe("Es reicht.\n\n### Fixkosten\n\nMiete 700 €.\n\n### Variable Kosten\n\nEssen 320 €.");
    expect(tidyAnswer("Kurz gesagt: ein Fonds, der einen Index nachbaut.")).toBe("Ein Fonds, der einen Index nachbaut.");
    expect(tidyAnswer("Du willst wissen, wie das Wetter morgen wird? Da schaust du am besten in eine Wetter-App.")).toBe("Da schaust du am besten in eine Wetter-App.");
    expect(tidyAnswer("Gerne! Ein Klassiker ist Spaghetti aglio e olio.")).toBe("Ein Klassiker ist Spaghetti aglio e olio.");
    expect(tidyAnswer("Wo liegt dein Geld? Das meiste liegt am Notgroschen.")).toBe("Das meiste liegt am Notgroschen.");
    // "am 25.8. und …" is one sentence: the check sees it whole.
    expect(visiblePrefix("Dein Gehalt kam am 25.8. und war pünktlich. ", {}, (sentence) => sentence.includes("pünktlich")).trim()).toBe("Dein Gehalt kam am 25.8. und war pünktlich.");
    // "z. B. 500 €" belongs to its sentence: an unbacked example goes with it, no lone "z. B." stays behind.
    expect(visiblePrefix("Leg jeden Monat etwas zur Seite, z. B. 500 €. Gut so. ", { left: 412 }).trim()).toBe("Gut so.");
    // A clause with a figure of its own making goes; the backed beginning of the sentence stays.
    expect(visiblePrefix("Dir bleiben **412 €** frei – bei 16 Tagen rund 25,75 € pro Tag. ", { left: 412 }).trim()).toBe("Dir bleiben **412 €** frei.");
    expect(visiblePrefix("Dir bleiben **412 €** frei – bei 16 Tagen rund 25,75 € pro ", { left: 412 })).toBe("Dir bleiben **412 €** frei");
  });

  it("checks every list item and table row on its own and streams Markdown line by line", async () => {
    const facts = { rent: 700, food: 320, left: 412 };
    const answer = ["Dir bleiben **412 €**.", "", "- Miete 700 €", "- Handy 999 €", "", "| Posten | Betrag |", "|---|---:|", "| Miete | 700 € |",
      "| Urlaub | 2.500 € |", "| Essen | 320 € |"].join("\n");
    const { fetcher } = stub(() => completion(answer));
    const reply = await answerFreeQuestion({ question: "Was kostet mich der Monat?", facts, agent: "budget" }, { config, fetcher });
    expect(reply.text).toBe("Dir bleiben **412 €**.\n\n- Miete 700 €\n\n| Posten | Betrag |\n| --- | ---: |\n| Miete | 700 € |\n| Essen | 320 € |");
    // While it streams: finished lines grounded, the open line word by word, a table only once its separator is there.
    expect(visiblePrefix("Dir bleiben 412 €.\n- Miete 700 €\n- Hand", facts)).toBe("Dir bleiben 412 €.\n\n- Miete 700 €");
    expect(visiblePrefix("Dir bleiben 412 €.\n- Miete 700 €\n- Strom kostet ", facts)).toBe("Dir bleiben 412 €.\n\n- Miete 700 €\n- Strom kostet");
    expect(visiblePrefix("Dir bleiben 412 €.\n\n| Posten | Betrag |\n", facts)).toBe("Dir bleiben 412 €.");
    expect(visiblePrefix("Dir bleiben 412 €.\n\n| Posten | Betrag |\n|---|---|\n| Miete | 70", facts)).toBe("Dir bleiben 412 €.");
    expect(visiblePrefix("Dir bleiben 412 €.\n\n| Posten | Betrag |\n|---|---|\n| Miete | 700 € |\n| Ess", facts))
      .toBe("Dir bleiben 412 €.\n\n| Posten | Betrag |\n| --- | --- |\n| Miete | 700 € |");
  });
});

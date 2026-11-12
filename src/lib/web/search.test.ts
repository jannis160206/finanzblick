import { describe, expect, it } from "vitest";
import { bestPassage, bingTarget, parseBing, publicFetch, searchWeb, webQuery } from "./search";
import { agreedFigures, webEvidence, webFallbackAnswer, type WebSearchResult } from "./web-answer";

const encode = (url: string) => `a1${Buffer.from(url).toString("base64url")}`;
const bingResult = (url: string, title: string, snippet: string) =>
  `<li class="b_algo" data-id><h2><a target="_blank" href="https://www.bing.com/ck/a?!&amp;&amp;p=x&amp;u=${encode(url)}&amp;ntb=1">${title}</a></h2>` +
  `<div class="b_caption"><p class="b_lineclamp2">${snippet}</p></div></li>`;
const page = (body: string) => `<html><head><script>var tracking = 1;</script></head><body><nav><li>Startseite und Menü mit vielen Einträgen hier</li></nav>${body}` +
  "<footer><p>© Alle Rechte vorbehalten, Impressum und Datenschutzerklärung der Seite.</p></footer></body></html>";

describe("web search query", () => {
  it("sends search words only: no amounts, contact details or account numbers", () => {
    const query = webQuery("Wie viel Kilometergeld bekommt man 2026? Ich fahre 3.490 € im Jahr, IBAN AT61 1904 3002 3457 3201, mail max@example.com");
    expect(query).toContain("kilometergeld");
    expect(query).toContain("2026");
    expect(query).toMatch(/Österreich$/);
    expect(query).not.toMatch(/3\.?490|AT61|1904|example|@/i);
  });

  it("never keeps salary-like numbers, only recent years", () => {
    expect(webQuery("Ich verdiene 1950 brutto, wie hoch ist der Familienbonus 2026?")).toBe("verdiene brutto familienbonus 2026 Österreich");
  });

  it("keeps a named country and drops search filler", () => {
    expect(webQuery("Such im Internet nach dem Mindestlohn in Deutschland")).toBe("mindestlohn deutschland");
  });
});

describe("result parsing", () => {
  it("reads Bing results and decodes the tracking links", () => {
    expect(bingTarget(`https://www.bing.com/ck/a?u=${encode("https://www.bmf.gv.at/x.html")}`)).toBe("https://www.bmf.gv.at/x.html");
    const hits = parseBing(`<ol>${bingResult("https://www.oesterreich.gv.at/a", "Pendler&shy;pauschale", "7. Sept. 2026 · Die Pendlerpauschale &amp; der Pendlereuro …")}</ol>`);
    expect(hits).toEqual([{ title: "Pendlerpauschale", url: "https://www.oesterreich.gv.at/a", snippet: "7. Sept. 2026 · Die Pendlerpauschale & der Pendlereuro" }]);
  });

  it("picks the paragraphs with the question's words and the asked year, never menus or footers", () => {
    const html = page("<p>Allgemeines zur Seite ohne Bezug zur eigentlichen Frage, aber lang genug.</p>" +
      "<p>Im Jahr 2025 lag die Geringfügigkeitsgrenze bei 551,10 Euro im Monat, wie im Jahr davor.</p>" +
      "<p>Im Jahr 2026 liegt die Geringfügigkeitsgrenze bei 551,10 Euro monatlich und wird nicht erhöht.</p>");
    const passage = bestPassage(html, ["geringfügigkeitsgrenze", "2026"], { amounts: true, year: "2026" });
    expect(passage).toMatch(/^Im Jahr 2026 liegt/);
    expect(passage).not.toMatch(/Startseite|Rechte|Allgemeines/);
  });

  it("adds a table of amounts when the paragraphs name none", () => {
    const html = page("<p>Das amtliche Kilometergeld deckt alle Kosten einer Dienstreise mit dem eigenen Kilometergeld-Fahrzeug ab.</p>" +
      "<table><tr><th>Fahrzeug</th><th>Kilometergeld in Euro</th></tr><tr><td>PKW</td><td>0,50</td></tr></table>");
    expect(bestPassage(html, ["kilometergeld", "aktuell"], { amounts: true })).toContain("PKW: 0,50");
  });
});

describe("safe fetching", () => {
  it("refuses hosts that resolve to the home network", async () => {
    const guarded = publicFetch(async () => ["192.168.1.10"], async () => new Response("geheim"));
    await expect(guarded("https://intranet.example/")).rejects.toThrow();
    const open = publicFetch(async () => ["93.184.216.34"], async () => new Response("ok"));
    expect(await (await open("https://example.org/")).text()).toBe("ok");
  });
});

describe("searchWeb", () => {
  const pages: Record<string, string> = {
    "https://www.oesterreich.gv.at/a": page("<p>Im Jahr 2026 liegt die Geringfügigkeitsgrenze bei 551,10 Euro monatlich.</p>"),
    "https://www.ams.at/b": page("<p>Die Geringfügigkeitsgrenze 2026 beträgt in Österreich monatlich 551,10 Euro und wurde nicht erhöht.</p>"),
    "https://blog.example.com/c": page("<p>Laut unserem Blog ist die Geringfügigkeitsgrenze 2026 bei 600 Euro, ohne Gewähr für die Zahl.</p>"),
  };
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = input.toString();
    if (url.startsWith("https://www.bing.com/search")) return new Response(
      bingResult("https://blog.example.com/c", "Blog", "Ein Blog zur Grenze") + bingResult("https://www.facebook.com/x", "Facebook", "Social") +
      bingResult("https://www.oesterreich.gv.at/a", "Geringfügigkeitsgrenze", "Amtlich") + bingResult("https://www.ams.at/b", "AMS", "Arbeitsmarktservice"),
      { headers: { "content-type": "text/html" } });
    const html = pages[url];
    return html ? new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } }) : new Response("", { status: 404 });
  }) as typeof fetch;
  const options = { fetcher, wikipedia: async () => undefined, env: {} };

  it("compares up to three sources, official ones first, and finds the figures they agree on", async () => {
    const result = await searchWeb("Wie hoch ist die Geringfügigkeitsgrenze 2026?", options);
    expect(result.provider).toBe("bing");
    expect(result.sources.map((source) => source.site)).toEqual(["oesterreich.gv.at", "ams.at", "blog.example.com"]);
    expect(result.sources[0]).toMatchObject({ n: 1, official: true });
    expect(result.agreed).toEqual(["551,1 €"]);
    const evidence = webEvidence(result)!;
    expect(evidence).toContain("[1] oesterreich.gv.at (amtlich)");
    expect(evidence).toContain("Übereinstimmend in mehreren Quellen: 551,1 €");
    expect(evidence.length).toBeLessThanOrEqual(1450);
  });

  it("looks up only cleaned words in Wikipedia and drops links too long to store", async () => {
    const topics: string[] = [];
    const long = `https://www.ams.at/${"x".repeat(520)}`;
    const withLong = (async (input: RequestInfo | URL) => input.toString().startsWith("https://www.bing.com/search")
      ? new Response(bingResult(long, "Lang", "Die Familienbeihilfe 2026 ist lang beschrieben, mit vielen Wörtern dazu."), { headers: { "content-type": "text/html" } })
      : fetcher(input)) as typeof fetch;
    const result = await searchWeb("Ist die IBAN AT611904300234573201 für die Familienbeihilfe 2026 richtig?", {
      fetcher: withLong, env: {}, wikipedia: async (topic) => { topics.push(topic); return undefined; } });
    expect(topics.join(" ")).not.toMatch(/at61|1904/i);
    expect(result.sources.every((source) => source.url.length <= 500)).toBe(true);
  });

  it("skips sources the user rejected and can be turned off", async () => {
    const result = await searchWeb("Wie hoch ist die Geringfügigkeitsgrenze heuer?", { ...options, avoid: ["blog.example.com"] });
    expect(result.sources.map((source) => source.site)).not.toContain("blog.example.com");
    expect(await searchWeb("Wie hoch ist die Geringfügigkeitsgrenze?", { ...options, env: { FINANZBLICK_WEB_SEARCH: "off" } })).toMatchObject({ disabled: true, sources: [] });
  });
});

describe("answers from web sources", () => {
  const result: WebSearchResult = { query: "q", provider: "bing", ms: 1, agreed: [], sources: [
    { n: 1, title: "Blog", url: "https://blog.example.com", site: "blog.example.com", official: false, text: "Ein Blog sagt 600 Euro." },
    { n: 2, title: "Amt", url: "https://www.oesterreich.gv.at", site: "oesterreich.gv.at", official: true, text: "7. Sept. 2026 gilt: Die Grenze liegt bei 551,10 Euro. Mehr dazu unten." },
  ] };

  it("quotes the official source first when the model is not available", () => {
    const text = webFallbackAnswer(result)!;
    expect(text).toMatch(/^Laut oesterreich\.gv\.at \[2\]: 7\. Sept\. 2026 gilt: Die Grenze liegt bei 551,10 Euro\. Mehr dazu unten\./);
    expect(text).toContain("blog.example.com [1]");
  });

  it("counts a figure as agreed only when two sources name it", () => {
    expect(agreedFigures(["551,10 Euro im Monat", "EUR 551,10 und 5 %", "€ 551,10"])).toEqual(["551,1 €"]);
    expect(agreedFigures(["0,50 Euro", "0,25 Euro"])).toEqual([]);
  });
});

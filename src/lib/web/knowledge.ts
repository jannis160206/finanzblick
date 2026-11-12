import { cached } from "./market-data";

// General finance knowledge from the German Wikipedia. Only the looked-up term leaves the device.
export type KnowledgeHit = { topic: string; title: string; text: string; url: string; source: string };

const API = "https://de.wikipedia.org/w/api.php";
const SOURCE = "Wikipedia (de) · CC BY-SA 4.0";
const WEEK = 7 * 24 * 60 * 60 * 1000;
const USER_AGENT = "Finanzblick/1.0 (privates Finanzdashboard; Wissensabfrage des Finanz-Assistenten)";

type Page = { title?: string; index?: number; extract?: string; fullurl?: string; pageprops?: { disambiguation?: string }; missing?: boolean };

export const foldTopic = (value: string) => value.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss")
  .replace(/[^a-z0-9]+/g, " ").trim();

// People, places and works are not what someone asking "Was ist …?" in a finance chat wants.
const person = /^[^.]{0,120}\((?:\*|geb\.|geboren)\s?[^)]*\d{4}/;
const offTopic = /\b(?:film|album|lied|band|roman|fernsehserie|computerspiel|ortsteil|gemeinde|asteroid|airways|airlines)\b/;
const placeOrCompany = /\b(?:ortsgemeinde|gemeinde im|stadt im|dorf|landkreis|fluggesellschaft|charterfluggesellschaft|fussballverein|musiker|mit sitz|mit hauptsitz)\b/;
const financeWords = /\b(?:finanz|geld|bank|steuer|zins|anlage|anleger|kredit|darlehen|versicherung|sparen|spar|fonds|boerse|einkommen|einkuenfte|vermoegen|wertpapier|aktie|konto|zahlung|kapital|invest|rente|pension|inflation|preis|kosten|waehrung|schuld|abgabe|budget|lohn|gehalt|miete|leasing|rendite|dividende|depot|index|arbeitgeber|arbeitnehmer|arbeitsrecht|entgelt|sozialversicherung)\w*/;

// Short forms that the search engine would otherwise match to unrelated articles.
const aliases: Record<string, string> = {
  etf: "Börsengehandelter Fonds", etfs: "Börsengehandelter Fonds", kest: "Kapitalertragsteuer", afa: "Absetzung für Abnutzung",
  ust: "Umsatzsteuer", mwst: "Umsatzsteuer", ter: "Total Expense Ratio", ezb: "Europäische Zentralbank", vpi: "Verbraucherpreisindex",
  hvpi: "Harmonisierter Verbraucherpreisindex", bip: "Bruttoinlandsprodukt", sepa: "Einheitlicher Euro-Zahlungsverkehrsraum",
  iban: "Internationale Bankkontonummer", svs: "Sozialversicherungsanstalt der Selbständigen", atx: "Austrian Traded Index",
  "msci world": "MSCI World", reit: "Real Estate Investment Trust", reits: "Real Estate Investment Trust", ipo: "Börsengang",
};

// Keeps whole sentences up to the limit, so the text never stops mid-word.
export function shortenText(text: string, limit = 1500) {
  const clean = text.replace(/\s*\n+\s*/g, " ").replace(/\s{2,}/g, " ").trim();
  if (clean.length <= limit) return clean;
  const cut = clean.slice(0, limit);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return end > limit / 3 ? cut.slice(0, end + 1) : `${cut.slice(0, limit - 1).replace(/\s+\S*$/, "")}…`;
}

export function pickPage(topic: string, pages: Page[]): Page | undefined {
  const wanted = foldTopic(topic);
  const words = wanted.split(" ").filter((word) => word.length >= 3);
  const scored = pages
    .filter((page) => page.title && page.extract && page.extract.length >= 60 && page.pageprops?.disambiguation === undefined && !page.missing)
    .filter((page) => !person.test(page.extract!) && !offTopic.test(foldTopic(page.title!)) && !placeOrCompany.test(foldTopic(page.extract!.slice(0, 200))))
    .map((page) => {
      const title = foldTopic(page.title!);
      const body = foldTopic(page.extract!.slice(0, 400));
      let score = 10 - (page.index ?? 10);
      if (title === wanted) score += 12;
      else if (title.startsWith(`${wanted} `) || title.includes(wanted)) score += 7;
      if (words.length && words.every((word) => title.includes(word))) score += 4;
      if (/oesterreich/.test(title)) score += 3;
      else if (/oesterreich/.test(body)) score += 2;
      if (/\((?:luftverkehr|transport|schifffahrt|eisenbahn|technik|informatik)\)/.test(page.title!.toLowerCase())) score -= 6;
      if (words.some((word) => body.includes(word))) score += 3;
      const finance = financeWords.test(`${title} ${body}`);
      // Every content word of the question has to appear, so "Hauptstadt von Australien" never becomes an article about divestment.
      const content = words.filter((word) => word.length >= 4);
      const covered = content.every((word) => title.includes(word.slice(0, 6)) || body.includes(word.slice(0, 6)));
      return { page, score, relevant: finance && covered && (words.length === 0 || words.some((word) => title.includes(word) || body.includes(word))) };
    })
    .filter((item) => item.relevant)
    .sort((a, b) => b.score - a.score);
  return scored[0]?.page;
}

// One request: search with summaries, disambiguation flags and links, then pick the best article.
// Only when nothing finance-related turns up, a second search adds "Geldanlage" as context.
export function lookupKnowledge(topic: string, fetcher: typeof fetch = fetch): Promise<KnowledgeHit | undefined> {
  const query = topic.replace(/\s+/g, " ").trim().slice(0, 80);
  if (query.length < 2) return Promise.resolve(undefined);
  const alias = aliases[foldTopic(query)];
  return cached(`knowledge:v2:${foldTopic(query)}`, async () => {
    const search = async (term: string) => {
      const params = new URLSearchParams({
        action: "query", generator: "search", gsrsearch: term, gsrlimit: "6", gsrnamespace: "0", prop: "extracts|info|pageprops",
        exintro: "1", explaintext: "1", exlimit: "6", inprop: "url", ppprop: "disambiguation", redirects: "1", format: "json", formatversion: "2", utf8: "1",
      });
      const response = await fetcher(`${API}?${params}`, {
        signal: AbortSignal.timeout(8000), cache: "no-store", headers: { Accept: "application/json", "User-Agent": USER_AGENT, "Api-User-Agent": USER_AGENT },
      });
      if (!response.ok) throw new Error(`Wikipedia antwortet mit ${response.status}`);
      const data = await response.json() as { query?: { pages?: Page[] } };
      return pickPage(alias ?? query, data.query?.pages ?? []);
    };
    const page = await search(alias ?? query) ?? (alias ? undefined : await search(`${query} Geldanlage`));
    if (!page?.title || !page.extract) return undefined;
    return { topic: query, title: page.title, text: shortenText(page.extract), url: page.fullurl ?? `https://de.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, "_"))}`, source: SOURCE };
  }, WEEK);
}

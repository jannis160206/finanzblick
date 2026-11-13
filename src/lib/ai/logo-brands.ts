import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeLocalLogoName } from "@/lib/automation/merchant-local-logos";

/**
 * Well-known brands whose bank texts the name search misses ("DM-FIL. A001", "INTERSPAR 1234",
 * "HOTEL ON BOOKING.COM"): their Wikidata item, whose Commons logo is used, and the official website, whose
 * app icon serves when there is none (many big sites refuse automated visitors, Commons does not).
 * Patterns match the normalized search name (lower case, words separated by single spaces).
 */
export const LOGO_BRANDS: readonly { pattern: RegExp; wikidata?: string; website: string }[] = [
  { pattern: /^dm(?: fil| drogerie|$)/, wikidata: "Q266572", website: "https://www.dm.at/" },
  { pattern: /^interspar\b/, website: "https://www.interspar.at/" },
  { pattern: /^eurospar\b/, wikidata: "Q12309283", website: "https://www.spar.at/" },
  { pattern: /^(?:post(?: pp| partner| filiale| ag)?|(?:österreichische|oesterreichische) post)$/, website: "https://www.post.at/" },
  { pattern: /\bbooking com\b/, wikidata: "Q4035313", website: "https://www.booking.com/" },
  { pattern: /^burger king\b/, wikidata: "Q177054", website: "https://www.burgerking.at/" },
  { pattern: /^subway\b/, wikidata: "Q244457", website: "https://www.subway.com/" },
  { pattern: /^kfc\b/, wikidata: "Q524757", website: "https://www.kfc.at/" },
  { pattern: /^eurowings\b/, wikidata: "Q168836", website: "https://www.eurowings.com/" },
  { pattern: /^swiss (?:intl|international|air)\b/, wikidata: "Q156776", website: "https://www.swiss.com/" },
  { pattern: /^austrian airlines\b/, wikidata: "Q781770", website: "https://www.austrian.com/" },
  { pattern: /^lufthansa\b/, wikidata: "Q9325", website: "https://www.lufthansa.com/" },
  { pattern: /^ryanair\b/, wikidata: "Q170614", website: "https://www.ryanair.com/" },
  { pattern: /^easyjet\b/, wikidata: "Q191551", website: "https://www.easyjet.com/" },
  { pattern: /^wizz ?air\b/, wikidata: "Q335147", website: "https://wizzair.com/" },
  { pattern: /^galp\b/, website: "https://www.galp.com/" },
  { pattern: /^mol$/, website: "https://molgroup.info/" },
  { pattern: /^bp(?: tankstelle)?$/, wikidata: "Q152057", website: "https://www.bp.com/" },
  { pattern: /^turm(?:ö|oe)l\b/, website: "https://www.turmoel.at/" },
  { pattern: /^genol\b/, website: "https://www.genol.at/" },
  { pattern: /^(?:www )?(?:oebb|öbb)\b/, wikidata: "Q83822", website: "https://www.oebb.at/" },
  { pattern: /^wiener ?linien\b/, wikidata: "Q668849", website: "https://www.wienerlinien.at/" },
  { pattern: /^westbahn\b/, wikidata: "Q266280", website: "https://westbahn.at/" },
  { pattern: /^flix ?bus\b/, wikidata: "Q1881378", website: "https://www.flixbus.at/" },
  { pattern: /^etsy\b/, wikidata: "Q1353939", website: "https://www.etsy.com/" },
  { pattern: /^epic games\b/, wikidata: "Q739711", website: "https://store.epicgames.com/" },
  { pattern: /^kinguin\b/, website: "https://www.kinguin.net/" },
  { pattern: /^(?:cts ?eventim|ctseventima?|oeticket)\b/, website: "https://www.oeticket.com/" },
  { pattern: /^netcup\b/, website: "https://www.netcup.com/" },
  { pattern: /^google\b/, wikidata: "Q95", website: "https://www.google.com/" },
  { pattern: /^microsoft\b/, wikidata: "Q2283", website: "https://www.microsoft.com/" },
  { pattern: /^steam(?:games|powered)?\b/, wikidata: "Q337535", website: "https://store.steampowered.com/" },
  { pattern: /^nintendo\b/, wikidata: "Q8093", website: "https://www.nintendo.com/" },
  { pattern: /^disney ?plus\b/, wikidata: "Q54958752", website: "https://www.disneyplus.com/" },
  { pattern: /^audible\b/, wikidata: "Q366651", website: "https://www.audible.de/" },
  { pattern: /^hornbach\b/, website: "https://www.hornbach.at/" },
  { pattern: /^lagerhaus\b/, website: "https://www.lagerhaus.at/" },
  { pattern: /^libro\b/, website: "https://www.libro.at/" },
  { pattern: /^rossmann\b/, wikidata: "Q316004", website: "https://www.rossmann.de/" },
  { pattern: /^deichmann\b/, website: "https://www.deichmann.com/" },
  { pattern: /^primark\b/, wikidata: "Q137023", website: "https://www.primark.com/" },
  { pattern: /^tchibo\b/, wikidata: "Q564213", website: "https://www.tchibo.at/" },
  { pattern: /^hervis\b/, website: "https://www.hervis.at/" },
  { pattern: /^m ?preis\b/, website: "https://www.mpreis.at/" },
  { pattern: /^unimarkt\b/, website: "https://www.unimarkt.at/" },
  { pattern: /^magenta\b/, wikidata: "Q63537385", website: "https://www.magenta.at/" },
  { pattern: /^lieferando\b/, website: "https://www.lieferando.at/" },
  { pattern: /^bolt$/, wikidata: "Q20529164", website: "https://bolt.eu/" },
  { pattern: /^(?:amzn|amazon)\b/, wikidata: "Q3884", website: "https://www.amazon.de/" },
  { pattern: /^rewe\b/, wikidata: "Q16968817", website: "https://www.rewe.de/" },
  { pattern: /^action$/, wikidata: "Q2634111", website: "https://www.action.com/" },
  { pattern: /^heinemann\b/, wikidata: "Q1462502", website: "https://www.heinemann-dutyfree.com/" },
  { pattern: /^pegasus hava\b/, wikidata: "Q1100424", website: "https://www.flypgs.com/" },
];

export type LogoHint = { wikidata?: string; website?: string };

/** The curated brand a search name belongs to, if any. */
export function knownLogoBrand(name: string): LogoHint | undefined {
  const normalized = normalizeLocalLogoName(name);
  const brand = LOGO_BRANDS.find((entry) => entry.pattern.test(normalized));
  return brand ? { ...(brand.wikidata ? { wikidata: brand.wikidata } : {}), website: brand.website } : undefined;
}

export const LOGO_OVERRIDES_FILE = ".logo-overrides.json";

/**
 * The user's own overrides in the logo folder: merchant name (as the test run lists it) → official website
 * ("https://…") or Wikidata item ("Q123"). Private like the folder itself; invalid entries are ignored.
 */
export async function readLogoOverrides(directory: string): Promise<Map<string, LogoHint>> {
  try {
    const parsed = JSON.parse(await readFile(join(directory, LOGO_OVERRIDES_FILE), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return new Map();
    const hints = new Map<string, LogoHint>();
    for (const [name, value] of Object.entries(parsed).slice(0, 1000)) {
      if (typeof value !== "string") continue;
      const key = normalizeLocalLogoName(name);
      if (/^Q[1-9]\d{0,11}$/.test(value.trim())) hints.set(key, { wikidata: value.trim() });
      else if (/^https:\/\/[^\s/]+\.[^\s/]+/i.test(value.trim())) hints.set(key, { website: value.trim() });
    }
    return hints;
  } catch {
    return new Map();
  }
}

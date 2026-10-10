import type { Category } from "@/lib/categories";

export interface ExpandedMerchantIdentity {
  readonly id: string;
  readonly canonicalName: string;
  readonly aliases: readonly string[];
  readonly wikidataId: string;
  readonly defaultCategory: Category | null;
}

const identity = (
  id: string,
  canonicalName: string,
  wikidataId: string,
  aliases: readonly string[] = [],
): ExpandedMerchantIdentity =>
  Object.freeze({
    id,
    canonicalName,
    aliases: Object.freeze([...aliases]),
    wikidataId,
    defaultCategory: null,
  });

/**
 * Public factual identities verified live on 2026-10-10 with Wikidata
 * wbgetentities: labels (en/de/mul), descriptions, claims.P154 and exact
 * enwiki/dewiki sitelinks. Each entity is independently inspectable at
 * https://www.wikidata.org/wiki/<wikidataId> or through
 * https://www.wikidata.org/w/api.php?action=wbgetentities&ids=<wikidataId>&props=labels%7Cdescriptions%7Cclaims%7Csitelinks&format=json
 *
 * No artwork, licence, attribution or logo permission is asserted here.
 * Missing P154 is not replaced with a parent company's artwork. Exact
 * Wikipedia query prop=pageprops|extracts (wikibase_item and introduction)
 * independently confirmed Hartlauer, Forstinger, NKD, Carrefour, Greggs
 * and iCloud, whose entities had no P154.
 * ALDI's P154 mixes Nord/Süd artwork; Nike's includes Air Jordan artwork.
 * Neither is permission to automatically choose an unrelated/sub-brand logo.
 * Microsoft 365 and N26 are omitted because existing name normalization
 * collapses the former into Microsoft and removes the latter entirely.
 * Existing broad Apple matching may still require manual review for services.
 * Integration must require category evidence; a brand is not a purchase purpose.
 */
export const expandedMerchantIdentities: readonly ExpandedMerchantIdentity[] =
  Object.freeze([
    // Austrian retailers, banking institutions, utilities and transport.
    identity("at-libro", "LIBRO", "Q1823138"),
    identity("at-hartlauer", "Hartlauer", "Q1587223"),
    identity("at-hervis", "Hervis", "Q1614816"),
    identity("at-humanic", "Humanic", "Q1636668"),
    identity("at-palmers", "Palmers", "Q1509985"),
    identity(
      "at-raiffeisen-bank-international",
      "Raiffeisen Bank International",
      "Q2127528",
    ),
    identity("at-easybank", "easybank", "Q15807172"),
    identity("at-wien-energie", "Wien Energie", "Q2568787"),
    identity("at-verbund", "Verbund", "Q688816"),
    identity("at-evn", "EVN", "Q872140"),
    identity("at-energie-steiermark", "Energie Steiermark", "Q1341214"),
    identity("at-energie-ag", "Energie AG Oberösterreich", "Q1231542"),
    identity("at-wiener-linien", "Wiener Linien", "Q668849"),
    identity("at-graz-linien", "Graz Linien", "Q876786"),
    identity("at-asfinag", "ASFINAG", "Q297650"),
    identity("at-forstinger", "Forstinger", "Q1438333"),
    identity("at-oeamtc", "ÖAMTC", "Q306057"),
    identity("at-arbo", "ARBÖ", "Q784673"),

    // Consumer retailers and apparel manufacturers; no category inference.
    identity("jysk", "JYSK", "Q138913"),
    identity("tchibo", "Tchibo", "Q564213"),
    identity("rossmann", "Rossmann", "Q316004"),
    identity("douglas", "Douglas", "Q570747"),
    identity("marionnaud", "Marionnaud", "Q1129073"),
    identity("fielmann", "Fielmann", "Q457822"),
    identity("apollo-optik", "Apollo-Optik", "Q618940"),
    identity("new-yorker", "New Yorker", "Q706421"),
    identity("takko", "Takko Fashion", "Q1371302", ["Takko"]),
    identity("kik", "KiK", "Q883965"),
    identity("nkd", "NKD", "Q927272"),
    identity("breuninger", "Breuninger", "Q911217"),
    identity("mango", "Mango", "Q136503"),
    identity("bershka", "Bershka", "Q827258"),
    identity("pull-bear", "Pull&Bear", "Q691029"),
    identity("primark", "Primark", "Q137023"),
    identity("s-oliver", "s.Oliver", "Q265056"),
    identity("tom-tailor", "Tom Tailor", "Q571206"),
    identity("nike", "Nike", "Q483915"),
    identity("adidas", "Adidas", "Q3895"),
    identity("puma", "Puma", "Q157064"),
    identity("under-armour", "Under Armour", "Q2031485"),
    identity("levi-strauss", "Levi Strauss & Co.", "Q127962", [
      "Levi's",
      "Levis",
    ]),
    identity("tommy-hilfiger", "Tommy Hilfiger", "Q634881"),
    identity("hugo-boss", "Hugo Boss", "Q491627"),
    identity("lacoste", "Lacoste", "Q309031"),
    identity("uniqlo", "UNIQLO", "Q26070"),
    identity("asos", "ASOS", "Q211951"),
    identity("shein", "SHEIN", "Q107377209"),
    identity("temu", "Temu", "Q114258161"),
    identity("ebay", "eBay", "Q58024"),
    identity("etsy", "Etsy", "Q1353939"),
    identity("aliexpress", "AliExpress", "Q29904317"),
    identity("vinted", "Vinted", "Q11935495"),
    identity("bonprix", "bonprix", "Q892852"),
    identity("conrad", "Conrad Electronic", "Q467136", ["Conrad"]),
    identity("saturn", "Saturn", "Q2543504"),
    identity("fnac", "Fnac", "Q676585"),
    identity("alza", "Alza.cz", "Q10786832"),
    identity("allegro", "Allegro", "Q58014"),
    identity("coolblue", "Coolblue", "Q4992516"),

    // Distinct supermarket brands, not their holding companies.
    identity("aldi", "ALDI", "Q125054"),
    identity("e-leclerc", "E.Leclerc", "Q1273376"),
    identity("carrefour", "Carrefour", "Q217599"),
    identity("auchan", "Auchan", "Q758603"),
    identity("tesco", "Tesco", "Q487494"),
    identity("sainsburys", "Sainsbury's", "Q152096"),
    identity("asda", "ASDA", "Q297410"),
    identity("morrisons", "Morrisons", "Q922344"),
    identity("waitrose", "Waitrose & Partners", "Q771734", ["Waitrose"]),
    identity("marks-spencer", "Marks & Spencer", "Q714491"),
    identity("coop-schweiz", "Coop Genossenschaft", "Q432564"),
    identity("migros", "Migros", "Q680727"),
    identity("albert-heijn", "Albert Heijn", "Q1653985"),
    identity("netto-marken-discount", "Netto Marken-Discount", "Q879858"),
    identity("norma", "Norma", "Q450180"),
    identity("alnatura", "Alnatura", "Q876811"),
    identity("bio-company", "Bio Company", "Q864179"),
    identity("tegut", "tegut", "Q1547993"),

    // Fuel brands also sell other goods and services.
    identity("eni", "Eni", "Q565594"),
    identity("aral", "Aral", "Q565734"),
    identity("totalenergies", "TotalEnergies", "Q154037"),
    identity("circle-k", "Circle K", "Q3268010"),

    // Restaurant, bakery and café chains.
    identity("dunkin", "Dunkin'", "Q847743"),
    identity("dominos-pizza", "Domino's Pizza", "Q839466"),
    identity("l-osteria", "L'Osteria", "Q17323478"),
    identity("wienerwald", "Wienerwald", "Q459755"),
    identity("taco-bell", "Taco Bell", "Q752941"),
    identity("pret-a-manger", "Pret a Manger", "Q2109109"),
    identity("costa-coffee", "Costa Coffee", "Q608845"),
    identity("caffe-nero", "Caffè Nero", "Q675808"),
    identity("tim-hortons", "Tim Hortons", "Q175106"),
    identity("greggs", "Greggs", "Q3403981"),
    identity("pizzaexpress", "PizzaExpress", "Q662845"),
    identity("nandos", "Nando's", "Q3472954"),
    identity("shake-shack", "Shake Shack", "Q1058722"),
    identity("hard-rock-cafe", "Hard Rock Cafe", "Q918151"),

    // Airlines are not evidence that a payment was a holiday purchase.
    identity("lufthansa", "Lufthansa", "Q9325"),
    identity("air-france", "Air France", "Q131005"),
    identity("klm", "KLM", "Q181912"),
    identity("easyjet", "easyJet", "Q191551"),
    identity("british-airways", "British Airways", "Q8766"),
    identity("swiss-airlines", "Swiss International Air Lines", "Q156776"),
    identity("turkish-airlines", "Turkish Airlines", "Q4548"),
    identity("qatar-airways", "Qatar Airways", "Q208033"),
    identity("emirates", "Emirates", "Q180432"),
    identity("finnair", "Finnair", "Q201821"),
    identity("tap-air-portugal", "TAP Air Portugal", "Q208232"),
    identity("iberia", "Iberia", "Q187972"),
    identity("sunexpress", "SunExpress", "Q1137136"),
    identity("pegasus-airlines", "Pegasus Airlines", "Q1100424"),
    identity("volotea", "Volotea", "Q2296193"),
    identity("transavia", "Transavia", "Q246952"),
    identity("norwegian-air-shuttle", "Norwegian Air Shuttle", "Q215392"),
    identity("condor", "Condor Flugdienst", "Q312517", ["Condor"]),
    identity("vueling", "Vueling", "Q646741"),

    // Exact websites and hotel brands, not substitute parent-company artwork.
    identity("expedia", "Expedia", "Q1418432"),
    identity("tripadvisor", "Tripadvisor", "Q1770710"),
    identity("agoda", "Agoda", "Q395182"),
    identity("hotels-com", "Hotels.com", "Q3068067"),
    identity("trivago", "trivago", "Q265286"),
    identity("tui-group", "TUI Group", "Q573103", ["TUI"]),
    identity("hilton-hotels", "Hilton Hotels & Resorts", "Q598884", ["Hilton"]),
    identity("marriott-hotels", "Marriott Hotels & Resorts", "Q3918608", [
      "Marriott",
    ]),
    identity("ibis-hotels", "ibis Hotels", "Q920166", ["ibis"]),
    identity("radisson-blu", "Radisson Blu", "Q7281341"),
    identity("nh-hotel-group", "NH Hotel Group", "Q1604631"),

    // Financial institutions are not payment-purpose/category evidence.
    identity("bunq", "bunq", "Q24084541"),
    identity("deutsche-bank", "Deutsche Bank", "Q66048"),
    identity("commerzbank", "Commerzbank", "Q157617"),
    identity("deutsche-kreditbank", "Deutsche Kreditbank", "Q1203255", ["DKB"]),

    // Telecom companies remain separate from their national/product brands.
    identity("vodafone", "Vodafone", "Q122141"),
    identity("swisscom", "Swisscom", "Q644324"),
    identity("deutsche-telekom", "Deutsche Telekom", "Q9396"),

    // Exact digital services, independent of Apple/Google/company identities.
    identity("apple-music", "Apple Music", "Q20056642"),
    identity("icloud", "iCloud", "Q283469"),
    identity("apple-tv-plus", "Apple TV Plus", "Q62446736", ["Apple TV+"]),
    identity("google-one", "Google One", "Q60617335"),
    identity("google-play", "Google Play", "Q79576"),
    identity("proton-mail", "Proton Mail", "Q17355735"),
    identity("expressvpn", "ExpressVPN", "Q48812033"),
    identity("surfshark", "Surfshark", "Q105102519"),
    identity("audible", "Audible", "Q366651"),
    identity("twitch", "Twitch", "Q4555537"),
    identity("discord", "Discord", "Q22907849"),
    identity("roblox", "Roblox", "Q692989"),
    identity("dropbox", "Dropbox", "Q142539"),
    identity("jetbrains", "JetBrains", "Q1688472"),
    identity("babbel", "Babbel", "Q264351"),
    identity("coursera", "Coursera", "Q499962"),
    identity("udemy", "Udemy", "Q7877165"),
    identity("figma", "Figma", "Q96186334"),
  ]);

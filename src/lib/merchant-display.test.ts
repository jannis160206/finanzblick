import { describe, expect, it } from "vitest";
import { cleanMerchantName, merchantKey } from "./merchant-display";

describe("cleanMerchantName", () => {
  it.each([
    ["AMZNPRIME DE*BT15Q46J4 AMZN.DE/INFO", "Amazon Prime"],
    ["AMZN Mktp DE*2K3LM91Q4", "Amazon"],
    ["AMAZON.DE*HX72K10P5", "Amazon"],
    ["Amazon Prime Video", "Amazon Prime"],
    ["PAYPAL *NETFLIX", "Netflix"],
    ["NETFLIX.COM 866-579-7172", "Netflix"],
    ["SHELL 1234 WIEN", "Shell"],
    ["SPAR DANKT 1234", "Spar"],
    ["INTERSPAR DANKT 4711 KLAGENFURT", "Spar"],
    ["BILLA DANKT", "Billa"],
    ["Google *YouTubePremium", "YouTube Premium"],
    ["GOOGLE *Google Storage", "Google"],
    ["APPLE.COM/BILL", "Apple"],
    ["Spotify P12345", "Spotify"],
    ["PlayStation Network", "PlayStation"],
    ["McDonalds 123", "McDonald's"],
    ["MC DONALDS 0815 VILLACH", "McDonald's"],
    ["LIDL DANKT", "Lidl"],
    ["HOFER DANKT 0042", "Hofer"],
    ["OMV 2345 KLAGENFURT", "OMV"],
    ["BP 7811 GRAZ", "BP"],
    ["UBER *TRIP HELP.UBER.COM", "Uber"],
    ["UBER *EATS", "Uber Eats"],
    ["BOLT.EU/O/2409", "Bolt"],
    ["WOLT", "Wolt"],
    ["Lieferando.at", "Lieferando"],
    ["MJAM GMBH", "Mjam"],
    ["DisneyPlus", "Disney+"],
    ["DAZN Limited", "DAZN"],
    ["Microsoft*Xbox Game Pass", "Xbox"],
    ["MICROSOFT*365 PERSONAL", "Microsoft"],
    ["STEAMGAMES.COM 4259522", "Steam"],
    ["Steam Purchase", "Steam"],
    ["Verwendungszweck: BURGER KING TECHELSBERG 9212 Zahlungsreferenz: POS          13,15 AT  D1   18.08. 20:55 Kartenfolge-Nr.: 1", "Burger King"],
    ["Verwendungszweck: BIPA DANKT 0307503 KLAGENFURT 9020 Zahlungsreferenz: POS           6,15 AT  D1   18.08. 12:47 Kartenfolge-Nr.: 1", "BIPA"],
    ["DM DROGERIE MARKT 0567", "dm"],
    ["H&M 0815 WIEN", "H&M"],
    ["Kartenzahlung BILLA 1234", "Billa"],
    ["PAYPAL *", "PayPal"],
    ["PayPal Europe S.a.r.l. et Cie S.C.A", "PayPal"],
  ])("%s → %s", (raw, expected) => {
    expect(cleanMerchantName(raw)).toBe(expected);
  });

  it.each([
    ["Zahlungsreferenz: TRAFIK HAAS  3219  D1   18.08. 20:34 Kartenfolge-Nr.: 1", "Trafik Haas"],
    ["PAYPAL *GAMESTOP DE", "Gamestop"],
    ["SQ *CAFE CENTRAL WIEN", "Cafe Central"],
    ["SumUp *Eisgreissler", "Eisgreissler"],
    ["ZTL*BAECKEREI WIENERROITHER", "Baeckerei Wienerroither"],
    ["CRV*PARKGARAGE CITY 4711", "Parkgarage City"],
    ["VISA SAKURA SUSHI 22 KLAGENFURT AT", "Sakura Sushi"],
    ["NORDLICHT LADEN 4711", "Nordlicht Laden"],
    ["Sonnenhof Café 12", "Sonnenhof Café"],
    ["www.zooplus.de", "Zooplus"],
    ["PIZZERIA DA MARIO GMBH 9020 KLAGENFURT", "Pizzeria Da Mario"],
    ["Hotspot", "Hotspot"],
    ["Pizzeria, Zentrum", "Pizzeria Zentrum"],
  ])("generic fallback %s → %s", (raw, expected) => {
    expect(cleanMerchantName(raw)).toBe(expected);
  });

  it("never returns an empty name", () => {
    expect(cleanMerchantName("  4711 0815  ")).toBe("4711 0815");
    expect(cleanMerchantName("*")).toBe("*");
    expect(cleanMerchantName("")).toBe("");
  });

  it("does not mistake savings texts for Spar", () => {
    expect(cleanMerchantName("Um EUR Sparen von EUR einzustecken")).not.toBe("Spar");
    expect(cleanMerchantName("Sparkonto")).toBe("Sparkonto");
  });
});

describe("merchantKey", () => {
  it("groups raw variants of one merchant", () => {
    expect(merchantKey("SPAR DANKT 1234")).toBe(merchantKey("INTERSPAR 0815 WIEN"));
    expect(merchantKey("AMZN Mktp DE*2K3")).toBe("amazon");
    expect(merchantKey("NORDLICHT LADEN 4711")).toBe(merchantKey("Nordlicht Laden 12"));
  });
});

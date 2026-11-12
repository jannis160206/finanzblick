import { expect, it } from "vitest";
import { purchasePurpose } from "./booking-purpose";

it.each([
  ["Airport Duty-Free", "Shopping"],
  ["Duty Free Shop", "Shopping"],
  ["Tabak Trafik", "Freizeit"],
  ["Unbekannter Supermarket", "Lebensmittel"],
  ["Sinos Fusion Cuisine", "Restaurants"],
  ["Nova Pharmacy", "Gesundheit"],
  ["Oberscheider Autodusche", "Fahrzeugwartung"],
  ["Nova Café", "Cafés & Snacks"],
  ["Frisör Nova", "Körperpflege"],
  ["Supermercato Nova", "Lebensmittel"],
])("recognizes explicit public purchase purpose: %s", (text, category) => {
  expect(purchasePurpose({}, text)).toMatchObject({
    kind: "matched",
    category,
    method: "purpose",
  });
});

it("only reads dedicated, unambiguous bank MCC metadata", () => {
  expect(purchasePurpose({ rawDetails: ["MCC: 5411"] }, "Nova")).toMatchObject({
    kind: "matched",
    category: "Lebensmittel",
    method: "mcc",
    mcc: "5411",
  });
  expect(
    purchasePurpose({ rawDetails: ["Ref 5411", "Betrag 54.11"] }, "Nova"),
  ).toBeUndefined();
  expect(purchasePurpose({}, "Payment 5411")).toBeUndefined();
  expect(
    purchasePurpose({ rawDetails: ["MCC: 9999"] }, "Nova"),
  ).toBeUndefined();
  expect(purchasePurpose({ rawDetails: ["MCC 5411"] }, "Nova")).toMatchObject({
    category: "Lebensmittel",
  });
});

it.each([
  [["MCC: 5411", "MCC: 5812"], "Nova"],
  [["MCC: 541"], "Nova"],
  [["Merchant Category Code: invalid"], "Nova"],
  [["MCC invalid"], "Nova"],
  [["MCC"], "Nova"],
  [["MCC: 5411"], "Nova Pharmacy"],
  [[], "Restaurant Coffee Supermarket"],
])("rejects conflicting or malformed purpose data", (rawDetails, text) => {
  expect(purchasePurpose({ rawDetails }, text)).toEqual({ kind: "conflict" });
});

import type { Category } from "@/lib/categories";
import type { Transaction } from "@/lib/types";

export const isDutyFreePurchase = (text: string) =>
  /\bduty[\s-]*free\b/i.test(text);

const purposes: readonly [RegExp, Category][] = [
  [/\bduty[\s-]*free\b|\btabak[\s-]*trafik\b|\btrafik\b/i, "Shopping"],
  [
    /\bsupermarket\b|\bsupermarkt\b|\bsupermercat[oi]\b|\bsupermercado\b|\blebensmittel(?:markt|handel)?\b/i,
    "Lebensmittel",
  ],
  [
    /\bpizzeri[ae]\b|\brestaurants?\b|\bgasthaus\b|\bfusion cuisine\b/i,
    "Restaurants",
  ],
  [/\bcaf[eé](?=\W|$)|\bcoffee\b|\bkaffeehaus\b/i, "Cafés & Snacks"],
  [/\bapotheke\b|\bpharmacy\b|\bzahnarzt\b|\bdentist\b/i, "Gesundheit"],
  [/\bfris(?:eur|ör)\b|\bbarber\b/i, "Körperpflege"],
  [/\bautodusche\b|\bautow[aä]sche\b|\bcar wash\b/i, "Fahrzeugwartung"],
  [/\bparkhaus\b|\bparking\b|\bparkgeb[uü]hr\b|\bmaut\b/i, "Parken & Maut"],
  [/\bfahrschule\b|\bdriving school\b/i, "Bildung"],
  [
    /\bfitnessstudio\b|\bfitness centre\b|\bfitness center\b/i,
    "Sport & Fitness",
  ],
  [
    /\bbriefmarken?\b|\bpaketmarken?\b|\bpaketversand\b|\bportogeb[uü]hr\b/i,
    "Porto & Versand",
  ],
];

// Specific ISO 18245 merchant types, not numbers guessed from amounts/references.
const mccCategories: Readonly<Record<string, Category>> = {
  "4111": "Öffentliche Verkehrsmittel",
  "4112": "Öffentliche Verkehrsmittel",
  "4121": "Mobilität",
  "4131": "Öffentliche Verkehrsmittel",
  "4511": "Urlaub",
  "4722": "Urlaub",
  "4814": "Telefon & Internet",
  "4900": "Energie & Nebenkosten",
  "5411": "Lebensmittel",
  "5422": "Lebensmittel",
  "5441": "Lebensmittel",
  "5451": "Lebensmittel",
  "5462": "Lebensmittel",
  "5499": "Lebensmittel",
  "5541": "Tanken",
  "5542": "Tanken",
  "5611": "Shopping",
  "5621": "Shopping",
  "5631": "Shopping",
  "5641": "Shopping",
  "5651": "Shopping",
  "5661": "Shopping",
  "5691": "Shopping",
  "5699": "Shopping",
  "5712": "Möbel & Einrichtung",
  "5722": "Shopping",
  "5732": "Shopping",
  "5812": "Restaurants",
  "5814": "Restaurants",
  "5912": "Gesundheit",
  "5941": "Sport & Fitness",
  "5942": "Bildung",
  "5944": "Shopping",
  "5945": "Shopping",
  "5947": "Shopping",
  "5977": "Drogerie",
  "5995": "Haustiere",
  "5999": "Shopping",
  "6300": "Versicherungen",
  "7011": "Urlaub",
  "7210": "Wohnen & Haushalt",
  "7230": "Körperpflege",
  "7523": "Parken & Maut",
  "7538": "Fahrzeugwartung",
  "7542": "Fahrzeugwartung",
  "7832": "Entertainment",
  "7997": "Sport & Fitness",
  "8011": "Gesundheit",
  "8021": "Gesundheit",
  "8042": "Gesundheit",
  "8050": "Gesundheit",
  "8062": "Gesundheit",
  "8099": "Gesundheit",
  "8244": "Weiterbildung",
  "8249": "Weiterbildung",
  "8351": "Bildung",
  "8398": "Geschenke & Spenden",
};

export type PurchasePurpose =
  | {
      kind: "matched";
      category: Category;
      method: "purpose" | "mcc";
      mcc?: string;
    }
  | { kind: "conflict" };

export function compatiblePurchaseCategories(
  left: Category,
  right: Category,
): boolean {
  if (left === right) return true;
  const broadCategories: readonly [Category, readonly Category[]][] = [
    ["Mobilität", ["Tanken", "Öffentliche Verkehrsmittel", "Parken & Maut"]],
    ["Wohnen & Haushalt", ["Möbel & Einrichtung", "Energie & Nebenkosten"]],
  ];
  return (
    broadCategories.some(
      ([broad, specific]) =>
        (left === broad && specific.includes(right)) ||
        (right === broad && specific.includes(left)),
    ) ||
    [
      ["Restaurants", "Cafés & Snacks", "Mittagessen"],
      ["Lebensmittel", "Mittagessen"],
    ].some((group) => group.includes(left) && group.includes(right))
  );
}

export function purchasePurpose(
  row: Pick<Transaction, "rawDetails">,
  merchantText: string,
): PurchasePurpose | undefined {
  if (merchantText.length > 1024) return { kind: "conflict" };
  const categories = new Set(
    purposes
      .filter(([pattern]) => pattern.test(merchantText))
      .map(([, category]) => category),
  );
  if (categories.size > 1) return { kind: "conflict" };
  const codes = new Set<string>();
  for (const detail of row.rawDetails ?? []) {
    const field =
      /^(?:mcc|merchant[\s-]*category[\s-]*code)\b\s*[:=]?\s*(.*)$/i.exec(
        detail.trim(),
      );
    if (!field) continue;
    if (!/^\d{4}$/.test(field[1])) return { kind: "conflict" };
    codes.add(field[1]);
  }
  if (codes.size > 1) return { kind: "conflict" };
  const code = [...codes][0];
  const mccCategory = code ? mccCategories[code] : undefined;
  const explicit = [...categories][0];
  if (
    explicit &&
    mccCategory &&
    !compatiblePurchaseCategories(explicit, mccCategory)
  )
    return { kind: "conflict" };
  if (explicit)
    return {
      kind: "matched",
      category: explicit,
      method: "purpose",
      ...(code ? { mcc: code } : {}),
    };
  if (mccCategory)
    return { kind: "matched", category: mccCategory, method: "mcc", mcc: code };
}

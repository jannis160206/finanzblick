import {
  Bike,
  CreditCard,
  Landmark,
  Palmtree,
  PiggyBank,
  ShieldCheck,
  TrendingUp,
  Wallet,
  type LucideIcon,
} from "lucide-react";

const partNames: Record<string, string> = {
  girokonto: "Girokonto",
  amex: "Amex offen",
  tr: "Trade Republic",
  "trade republic": "Trade Republic",
  pro: "Pro",
};

const partIcons: Record<string, LucideIcon> = {
  girokonto: Landmark,
  amex: CreditCard,
  tr: TrendingUp,
  "trade republic": TrendingUp,
  notgroschen: ShieldCheck,
  urlaub: Palmtree,
  sparkonto: PiggyBank,
  motorrad: Bike,
};

export function netWorthPartLabel(key: string) {
  return partNames[key] ?? key.replace(/(^|[\s&/-])(\p{L})/gu, (_, sep: string, letter: string) => sep + letter.toLocaleUpperCase("de"));
}

export function netWorthPartIcon(key: string): LucideIcon {
  return partIcons[key] ?? Wallet;
}

export function visibleNetWorthParts(parts: Record<string, number>) {
  return Object.entries(parts)
    .filter(([, value]) => Math.abs(value) >= 0.005)
    .sort(([, a], [, b]) => b - a);
}

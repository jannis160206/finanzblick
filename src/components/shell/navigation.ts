import {
  ArrowLeftRight,
  Calculator,
  CalendarRange,
  FileText,
  LayoutDashboard,
  Settings2,
  Wallet,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  seasonalSlot?: "navigation" | "pockets";
  primary: boolean;
  keywords: string;
};

export const navigation: readonly NavItem[] = [
  { href: "/", label: "Übersicht", icon: LayoutDashboard, seasonalSlot: "navigation", primary: true, keywords: "dashboard start überschuss vermögen" },
  { href: "/umsaetze", label: "Umsätze", icon: ArrowLeftRight, primary: true, keywords: "buchungen transaktionen ausgaben einnahmen prüfen" },
  { href: "/budget", label: "Budget", icon: CalendarRange, primary: true, keywords: "monat jahr plan ist rest fixkosten" },
  { href: "/sparen", label: "Sparen", icon: Wallet, seasonalSlot: "pockets", primary: true, keywords: "pockets sparziele nettovermögen trade republic zinsen" },
  { href: "/vertraege", label: "Verträge", icon: FileText, primary: false, keywords: "abos abonnements kündigung kündigungsfrist versicherung handy streaming fixkosten" },
  { href: "/gehalt-steuern", label: "Gehalt & Steuern", icon: Calculator, primary: false, keywords: "lohn lohnabrechnung jahressechstel steuer prämie" },
  { href: "/einstellungen", label: "Einstellungen", icon: Settings2, primary: false, keywords: "profil konfiguration sicherung erscheinungsbild" },
];

export function isActivePath(pathname: string, href: string) {
  return href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);
}

export function currentNavItem(pathname: string) {
  return navigation.find((item) => isActivePath(pathname, item.href));
}

import {
  Bell,
  Building2,
  DatabaseBackup,
  Landmark,
  Mail,
  Palette,
  Shield,
  ShieldCheck,
  TriangleAlert,
  UserRound,
  Volume2,
  type LucideIcon,
} from "lucide-react";

export type SettingsItem = { id: string; label: string; icon: LucideIcon; keywords: string; account?: boolean };
export type SettingsGroup = { id: string; label: string; icon: LucideIcon; items: SettingsItem[] };

export const settingsGroups: SettingsGroup[] = [
  { id: "konto", label: "Konto", icon: UserRound, items: [
    { id: "profil", label: "Profil", icon: UserRound, keywords: "konto benutzer anmelden abmelden", account: true },
  ] },
  { id: "verbindungen", label: "Banken & Verbindungen", icon: Landmark, items: [
    { id: "bankverbindung", label: "Bankkonten", icon: Building2, keywords: "bank psd2 enable banking abruf freigabe erneuern konto verbinden logo", account: true },
    { id: "email", label: "E-Mail-Bestellungen", icon: Mail, keywords: "gmail mail bestellung klarna paypal amazon rechnung app-passwort", account: true },
  ] },
  { id: "darstellung", label: "Darstellung", icon: Palette, items: [
    { id: "jahreszeit", label: "Erscheinungsbild", icon: Palette, keywords: "thema theme farbe akzent saison dunkel bewegung animation design" },
    { id: "klaenge", label: "Klänge", icon: Volume2, keywords: "ton sound lautstärke audio" },
  ] },
  { id: "privatsphaere", label: "Mitteilungen & Privatsphäre", icon: ShieldCheck, items: [
    { id: "benachrichtigungen", label: "Benachrichtigungen", icon: Bell, keywords: "hinweise push mitteilung budget gehalt" },
    { id: "sichtschutz", label: "Sichtschutz", icon: Shield, keywords: "sicherheitsmodus privatsphäre unscharf verbergen" },
  ] },
  { id: "daten", label: "Daten", icon: DatabaseBackup, items: [
    { id: "sicherung", label: "Sicherung", icon: DatabaseBackup, keywords: "backup excel export import wiederherstellen abgleich server konflikt" },
    { id: "gefahrenzone", label: "Gefahrenzone", icon: TriangleAlert, keywords: "löschen entfernen zurücksetzen buchungen" },
  ] },
];

/** Category a settings section belongs to, for deep links like /einstellungen#bankverbindung. */
export const settingsCategoryOf = (sectionId: string) =>
  settingsGroups.find((group) => group.id === sectionId || group.items.some((item) => item.id === sectionId))?.id;
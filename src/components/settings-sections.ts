import {
  Bell,
  Building2,
  DatabaseBackup,
  Mail,
  Palette,
  Shield,
  TriangleAlert,
  UserRound,
  Volume2,
  type LucideIcon,
} from "lucide-react";

export type SettingsItem = { id: string; label: string; icon: LucideIcon; keywords: string; account?: boolean };

export const settingsGroups: Array<{ id: string; label: string; items: SettingsItem[] }> = [
  { id: "konto", label: "Konto", items: [
    { id: "profil", label: "Profil", icon: UserRound, keywords: "konto benutzer anmelden abmelden", account: true },
  ] },
  { id: "verbindungen", label: "Verbindungen", items: [
    { id: "bankverbindung", label: "Bankkonten", icon: Building2, keywords: "bank psd2 enable banking abruf freigabe erneuern konto verbinden", account: true },
    { id: "email", label: "E-Mail-Bestellungen", icon: Mail, keywords: "gmail mail bestellung klarna paypal amazon rechnung app-passwort", account: true },
  ] },
  { id: "app", label: "App", items: [
    { id: "jahreszeit", label: "Erscheinungsbild", icon: Palette, keywords: "thema theme farbe akzent saison dunkel bewegung animation design" },
    { id: "klaenge", label: "Klänge", icon: Volume2, keywords: "ton sound lautstärke audio" },
    { id: "benachrichtigungen", label: "Benachrichtigungen", icon: Bell, keywords: "hinweise push mitteilung budget gehalt" },
    { id: "sichtschutz", label: "Sichtschutz", icon: Shield, keywords: "sicherheitsmodus privatsphäre unscharf verbergen" },
  ] },
  { id: "daten", label: "Daten", items: [
    { id: "sicherung", label: "Sicherung", icon: DatabaseBackup, keywords: "backup excel export import wiederherstellen abgleich server konflikt" },
    { id: "gefahrenzone", label: "Gefahrenzone", icon: TriangleAlert, keywords: "löschen entfernen zurücksetzen buchungen" },
  ] },
];

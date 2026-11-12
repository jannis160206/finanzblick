import { seasonalLabels } from "@/lib/seasonal-theme";
import type { AssistantOperation } from "@/lib/types";

/**
 * Settings that live in the app data and can be changed by chat with a preview: the seasonal design and the term lookup
 * on payslips. Colour scheme, sounds, notifications and the privacy screen belong to this device and are switched
 * right away (fixed-replies.ts).
 */
export type SettingsPlan = { operations: AssistantOperation[]; title: string } | { text: string; suggestions?: string[] };

const verb = /\b(?:stell\w*|schalt\w*|einschalt\w*|ausschalt\w*|mach\w*|aktivier\w*|deaktivier\w*|wechsel\w*|änder\w*|aender\w*|setz\w*|will|möchte|moechte|bitte|zurück|zurueck|automatisch|an|aus|ein|ab)\b/;
const seasonal = /\b(?:halloween\w*|weihnacht\w*|saison\w*|jahreszeit\w*|erscheinungsbild|standard-?design|design|app-?design)\b|(?:halloween|weihnachts?)-?design/;
const off = /\b(?:aus|ab|ausschalt\w*|abschalt\w*|ausmach\w*|deaktivier\w*|weg|vorbei|beend\w*|nicht mehr)\b|\bkein\w*\b.{0,40}\bmehr\b/;
const termLookup = /begriff\w*\b.{0,40}\b(?:erklär\w*|erklaer\w*|nachschlag\w*|nachschau\w*)|\b(?:erklär\w*|erklaer\w*|nachschlag\w*|nachschau\w*)\b.{0,50}begriff|begriffserklärung|begriffserklaerung/;

export function settingsRequest(lower: string): boolean {
  if (/\?\s*$/.test(lower) && !/^(?:kannst|könntest|koenntest|würdest|wuerdest) du\b/.test(lower)) return false;
  if (/\b(?:dunkel|hell|dark|light|nacht)\w*/.test(lower) && !/halloween|weihnacht/.test(lower)) return false;
  return seasonal.test(lower) && verb.test(lower) ||
    termLookup.test(lower) && /\b(?:an|aus|ein|ab|aktivier\w*|deaktivier\w*|schalt\w*|einschalt\w*|ausschalt\w*|anschalt\w*|abschalt\w*|nicht mehr|keine)\b/.test(lower);
}

export function settingsPlan(text: string): SettingsPlan {
  const lower = text.toLowerCase();
  if (termLookup.test(lower)) {
    const off = /\b(?:aus|ab|deaktivier\w*|ausschalt\w*|abschalt\w*|nicht mehr|keine)\b/.test(lower);
    return { operations: [{ op: "setting_flag", key: "payslipTermLookup", value: !off }], title: `Begriffserklärung auf dem Gehaltszettel ${off ? "ausschalten" : "einschalten"}` };
  }
  // "Halloween-Design aus" means no seasonal design (Standard); "automatisch" follows the calendar again.
  const theme = /\bautomatisch\w*|\bnach (?:der )?(?:saison|jahreszeit)\b/.test(lower) ? "auto"
    : off.test(lower) ? "default"
    : /halloween/.test(lower) ? "halloween" : /weihnacht/.test(lower) ? "christmas"
    : /\bstandard\w*|\bnormal\w*|\bschlicht\w*|\bohne (?:saison|jahreszeit|deko)/.test(lower) ? "default"
    : /\bsaison\w*|\bjahreszeit\w*|\bzurück\b|\bzurueck\b/.test(lower) ? "auto" : undefined;
  if (!theme) return { text: "Welches Erscheinungsbild möchtest du? Zur Auswahl: Standard, Halloween, Weihnachten oder automatisch nach Jahreszeit.",
    suggestions: ["Stell das Design auf Weihnachten", "Design automatisch nach Jahreszeit", "Stell das Design auf Standard"] };
  const label = theme === "auto" ? "automatisch nach Jahreszeit" : seasonalLabels[theme];
  return { operations: [{ op: "seasonal_theme", theme }], title: `Erscheinungsbild: ${label}` };
}

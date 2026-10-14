import { accentTokens } from "@/lib/appearance";
import { easterSunday } from "@/lib/holidays-at-kaernten";

export const seasonalThemes = [
  "default",
  "halloween",
  "christmas",
  "newyear",
  "carnival",
  "easter",
  "summer",
  "betweenyears",
] as const;
export const selectableSeasonalThemes = [
  "default",
  "halloween",
  "christmas",
] as const;
export const seasonalModes = ["auto", "default", "fixed"] as const;
export type SeasonalTheme = (typeof seasonalThemes)[number];
export type SeasonalPreference = {
  mode?: (typeof seasonalModes)[number];
  theme?: SeasonalTheme;
  accentColor?: string;
  reduceMotion?: boolean;
};
export const defaultSeasonalPreference: SeasonalPreference = {
  mode: "auto",
  theme: "default",
};
export const seasonalLabels: Record<SeasonalTheme, string> = {
  default: "Standard",
  halloween: "Halloween",
  christmas: "Weihnachten",
  newyear: "Neujahr",
  carnival: "Fasching",
  easter: "Ostern",
  summer: "Sommer",
  betweenyears: "Zwischen den Jahren",
};

// Self-contained on purpose: it is serialised into the bootstrap script. A manual choice wins, otherwise the calendar suggests.
export function resolveSeasonalTheme(
  preference?: SeasonalPreference,
  now = new Date(),
  easter = easterSunday(now.getFullYear()),
): SeasonalTheme {
  const manual = ["default", "halloween", "christmas", "newyear", "carnival", "easter", "summer", "betweenyears"];
  if (preference?.mode === "default") return "default";
  if (preference?.mode === "fixed" && preference.theme && manual.includes(preference.theme)) return preference.theme;
  const day = (now.getMonth() + 1) * 100 + now.getDate();
  if (day <= 105) return "newyear";
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const delta = Math.round((today - Date.parse(`${easter}T00:00:00Z`)) / 86_400_000);
  if (delta >= -53 && delta <= -47) return "carnival";
  // Ten days: five before Easter Monday, Monday, and four after it.
  if (delta >= -4 && delta <= 5) return "easter";
  if (day >= 621 && day <= 831) return "summer";
  if (day >= 1025 && day <= 1101) return "halloween";
  if (day >= 1201 && day <= 1226) return "christmas";
  if (day >= 1227) return "betweenyears";
  return "default";
}

export function chooseSeasonalTheme(
  preference: SeasonalPreference | undefined,
  theme: SeasonalTheme,
): SeasonalPreference {
  return { ...defaultSeasonalPreference, ...preference, mode: "fixed", theme };
}

export function resetSeasonalTheme(
  preference: SeasonalPreference | undefined,
): SeasonalPreference {
  return { ...defaultSeasonalPreference, ...preference, ...defaultSeasonalPreference };
}

export function isManualSeasonalTheme(preference?: SeasonalPreference): boolean {
  return preference?.mode === "fixed" || preference?.mode === "default";
}
export const seasonalThemeBootstrap = `(()=>{
  const resolve = ${resolveSeasonalTheme.toString()};
  const accent = ${accentTokens.toString()};
  const easter = ${easterSunday.toString()};
  const now = new Date();
  let preference;
  try { preference = JSON.parse(localStorage.getItem("finanzdashboard.v1") || "null")?.seasonalTheme; } catch {}
  document.documentElement.dataset.theme = resolve(preference, now, easter(now.getFullYear()));
  document.documentElement.dataset.reduceMotion = String(preference?.reduceMotion === true);
  for (const [token, value] of Object.entries(accent(preference?.accentColor))) document.documentElement.style.setProperty(token, value);
})();`;

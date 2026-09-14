import { accentTokens } from "@/lib/appearance";

export const seasonalThemes = [
  "default",
  "halloween",
  "christmas",
  "newyear",
] as const;
export const selectableSeasonalThemes = [
  "default",
  "halloween",
  "christmas",
] as const;
export const seasonalModes = ["auto", "default", "fixed"] as const;
export type SeasonalTheme = (typeof seasonalThemes)[number];
export type SeasonalPreference = {
  mode: (typeof seasonalModes)[number];
  theme: SeasonalTheme;
  accentColor?: string;
};
export const defaultSeasonalPreference: SeasonalPreference = {
  mode: "auto",
  theme: "default",
};
export const seasonalLabels: Record<SeasonalTheme, string> = {
  default: "Default",
  halloween: "Halloween",
  christmas: "Weihnachten",
  newyear: "Neujahr",
};

// Self-contained so the same resolver can run before hydration, without a bundle.
export function resolveSeasonalTheme(
  preference?: SeasonalPreference,
  now = new Date(),
): SeasonalTheme {
  if (preference?.mode === "default") return "default";
  if (preference?.mode === "fixed") {
    return ["default", "halloween", "christmas", "newyear"].includes(
      preference.theme,
    )
      ? preference.theme
      : "default";
  }
  const day = (now.getMonth() + 1) * 100 + now.getDate();
  if (day >= 1025 && day <= 1101) return "halloween";
  if (day >= 1201 && day <= 1226) return "christmas";
  if (day >= 1227 || day <= 105) return "newyear";
  return "default";
}

export const seasonalThemeBootstrap = `(()=>{
  const resolve = ${resolveSeasonalTheme.toString()};
  const accent = ${accentTokens.toString()};
  let preference;
  try { preference = JSON.parse(localStorage.getItem("finanzdashboard.v1") || "null")?.seasonalTheme; } catch {}
  document.documentElement.dataset.theme = resolve(preference);
  for (const [token, value] of Object.entries(accent(preference?.accentColor))) document.documentElement.style.setProperty(token, value);
})();`;

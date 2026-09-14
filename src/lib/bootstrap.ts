import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseWorkbook } from "@/lib/excel";
import { createSeed } from "@/lib/seed";

let initialData: ReturnType<typeof loadInitialData> | undefined;
async function loadInitialData() {
  try {
    const file = await readFile(
      path.join(
        process.cwd(),
        "data",
        "Einnahmen_Ausgaben_2026_MotorradSparen.xlsx",
      ),
    );
    const result = await parseWorkbook(Uint8Array.from(file).buffer);
    return {
      state: result.state,
      warning: undefined,
    };
  } catch (error) {
    const missing =
      error instanceof Error && "code" in error && error.code === "ENOENT";
    console.warn(
      "Finance bootstrap:",
      missing
        ? "Workbook not found; using baseline seed."
        : error instanceof Error
          ? error.message
          : "Unknown import error",
    );
    return {
      state: createSeed(),
      warning: missing
        ? "Keine Startdatei gefunden. Die vorgegebenen Ist-Stände sind hinterlegt; Umsätze und Monatswerte können direkt erfasst werden."
        : "Die Startdatei konnte nicht gelesen werden. Ist-Stände sind hinterlegt. Bitte die Arbeitsmappe über Importieren prüfen.",
    };
  }
}
export function getInitialData() {
  initialData ??= loadInitialData();
  return initialData;
}

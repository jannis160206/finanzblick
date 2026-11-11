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
        ? "Noch keine Startdatei – Umsätze und Werte lassen sich direkt erfassen."
        : "Startdatei nicht lesbar – bitte über Importieren prüfen.",
    };
  }
}
export function getInitialData() {
  initialData ??= loadInitialData();
  return initialData;
}

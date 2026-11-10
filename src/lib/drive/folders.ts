import type { DriveFolderKind } from "./store";

/** Drive folders read by Finanzblick; shared by the server sync and the settings. */
export const DRIVE_FOLDER_NAMES: Record<DriveFolderKind, string> = { amex: "AMEX Abrechnungen", payslips: "Abrechnungen" };
export const DRIVE_FOLDER_PURPOSE: Record<DriveFolderKind, string> = { amex: "Umsätze & Buchungen", payslips: "Lohnzettel, Steuern & Abgaben" };

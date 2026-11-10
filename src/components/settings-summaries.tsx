"use client";

import { useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useAccountWorkspace } from "@/components/account-context";
import { BankLogo } from "@/components/bank-logo";
import { useFinance } from "@/components/finance-provider";
import { useSecurityMode } from "@/components/security-mode-provider";
import { usePayslipPasswordStatus, usePayslipPasswordStore } from "@/components/payslip-password";
import { backupAgeText, backupStatus, localDateKey, readLastBackup, subscribeBackup } from "@/lib/backup-age";
import { canonicalBank } from "@/lib/banks/registry";
import { defaultSeasonalPreference, seasonalLabels } from "@/lib/seasonal-theme";

const securityLabel = { automatic: "Sichtschutz automatisch", manual: "Sichtschutz manuell", off: "Sichtschutz aus" } as const;

/** Banks the user's data knows about, one entry per bank (synced accounts and the Trade Republic Notgroschen). */
export function useKnownBanks(): string[] {
  const { state } = useFinance();
  return useMemo(() => {
    const names = [...(state.accountSnapshots ?? []).map((item) => item.bank), ...(state.trBalances?.length ? ["Trade Republic"] : [])];
    const seen = new Map<string, string>();
    for (const name of names) {
      const trimmed = name?.trim();
      if (!trimmed) continue;
      const entry = canonicalBank(trimmed);
      const key = entry?.id ?? trimmed.toLocaleLowerCase("de-AT");
      if (!seen.has(key)) seen.set(key, entry?.name ?? trimmed);
    }
    return [...seen.values()];
  }, [state.accountSnapshots, state.trBalances]);
}

/** One short line per settings category with what is set right now. */
export function useSettingsSummaries(): Record<string, ReactNode> {
  const workspace = useAccountWorkspace();
  const { state } = useFinance();
  const { preference } = useSecurityMode();
  const scope = workspace?.user.id ?? "local";
  const lastBackup = useSyncExternalStore(subscribeBackup, () => readLastBackup(scope), () => undefined);
  const banks = useKnownBanks();
  const passwordStore = usePayslipPasswordStore();
  const password = usePayslipPasswordStatus(passwordStore);
  const seasonal = state.seasonalTheme ?? defaultSeasonalPreference;
  const backup = lastBackup === undefined ? null : backupStatus(lastBackup, localDateKey());
  return {
    konto: workspace ? `Angemeldet als ${workspace.user.username}` : "",
    verbindungen: banks.length
      ? <span className="flex min-w-0 items-center gap-1.5">
        <span className="flex shrink-0 -space-x-1">{banks.slice(0, 3).map((bank) => <BankLogo key={bank} bank={bank} size="xs" className="ring-2 ring-card" />)}</span>
        <span className="truncate">{banks.length === 1 ? banks[0] : `${banks.length} Banken`}</span>
      </span>
      : "Keine Bank verbunden",
    abrechnungen: password.state === "stored" ? "PDF-Passwort hinterlegt" : password.state === "none" ? "Kein PDF-Passwort" : "",
    darstellung: [
      seasonal.mode === "fixed" && seasonal.theme ? seasonalLabels[seasonal.theme] : "Thema nach Saison",
      seasonal.reduceMotion ? "weniger Bewegung" : null,
    ].filter(Boolean).join(" · "),
    privatsphaere: securityLabel[preference],
    daten: !backup ? "" : backup.kind === "none" ? "Noch kein Backup" : `Backup ${backupAgeText(backup.days)}`,
  };
}

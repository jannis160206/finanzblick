"use client";

import { useMemo } from "react";
import { useAccountWorkspace } from "@/components/account-context";
import { accountRequest } from "@/lib/account-request";
import { appendPayslipLog, readPayslipLog, type PayslipLogEntry } from "@/lib/payslip-log";
import type { KnowledgeHit } from "@/lib/web/knowledge";

const ENDPOINT = "/api/payslip-log";
const STORAGE_KEY = "finanzblick.payslip-log";
const DEVICE_LIMIT = 50;

export type PayslipLogStore = {
  scope: "account" | "device";
  read(): Promise<PayslipLogEntry[]>;
  append(entry: PayslipLogEntry): Promise<void>;
  clear(): Promise<void>;
};

function deviceLog(): PayslipLogEntry[] {
  try {
    return readPayslipLog(JSON.parse(globalThis.localStorage?.getItem(STORAGE_KEY) ?? "[]"));
  } catch {
    return [];
  }
}

/** Account mode keeps the log next to the database on the own server, otherwise it stays in this browser. */
export function payslipLogStore(account: string | null): PayslipLogStore {
  if (account) {
    return {
      scope: "account",
      read: async () => (await accountRequest<{ entries: PayslipLogEntry[] }>(ENDPOINT, account)).entries,
      append: async (entry) => { await accountRequest(ENDPOINT, account, { method: "POST", json: entry }); },
      clear: async () => { await accountRequest(ENDPOINT, account, { method: "DELETE" }, "Protokoll konnte nicht geleert werden."); },
    };
  }
  return {
    scope: "device",
    read: async () => deviceLog(),
    append: async (entry) => {
      try {
        globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(appendPayslipLog(deviceLog(), entry, DEVICE_LIMIT)));
      } catch {
        // A full or blocked storage only loses debugging details.
      }
    },
    clear: async () => { globalThis.localStorage?.removeItem(STORAGE_KEY); },
  };
}

export function usePayslipLogStore(): PayslipLogStore {
  const account = useAccountWorkspace()?.user.id ?? null;
  return useMemo(() => payslipLogStore(account), [account]);
}

/** Online fallback for an unclear payslip term: the existing Wikipedia lookup (MCP server); only the term is sent. */
export async function lookupKnowledgeTerm(term: string): Promise<KnowledgeHit | null> {
  const response = await fetch(`/api/knowledge?q=${encodeURIComponent(term)}`, { cache: "no-store", signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error("Nachschlagen nicht möglich.");
  return ((await response.json()) as { hit?: KnowledgeHit | null }).hit ?? null;
}

/** Saves the log as a JSON file. */
export function downloadPayslipLog(entries: PayslipLogEntry[], now = new Date()) {
  const blob = new Blob([JSON.stringify(entries, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `finanzblick-import-protokoll-${now.toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

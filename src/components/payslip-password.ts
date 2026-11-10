"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccountWorkspace } from "@/components/account-context";
import { accountRequest } from "@/lib/account-request";
import { createLocalSecretStore, indexedDbBackend, type LocalSecretStore } from "@/lib/local-secret-store";

const SECRET = "payslip-password";
const ENDPOINT = "/api/payslip-password";
export const PAYSLIP_PASSWORD_EVENT = "finanzblick:payslip-password";

export type PayslipPasswordStore = {
  /** "account": encrypted on the own server; "device": encrypted in this browser only. */
  scope: "account" | "device";
  available: boolean;
  info(): Promise<{ updatedAt: number } | null>;
  reveal(): Promise<string | null>;
  save(password: string): Promise<{ updatedAt: number }>;
  clear(): Promise<void>;
};

const announce = () => { if (typeof window !== "undefined") window.dispatchEvent(new Event(PAYSLIP_PASSWORD_EVENT)); };

let localStore: LocalSecretStore | null | undefined;
function deviceStore(): LocalSecretStore | null {
  if (localStore !== undefined) return localStore;
  const backend = indexedDbBackend();
  localStore = backend && globalThis.crypto?.subtle ? createLocalSecretStore(backend, globalThis.crypto.subtle) : null;
  return localStore;
}

export function payslipPasswordStore(account: string | null): PayslipPasswordStore {
  if (account) {
    type Status = { stored: boolean; updatedAt?: number; password?: string };
    return {
      scope: "account",
      available: true,
      info: async () => {
        const status = await accountRequest<Status>(ENDPOINT, account);
        return status.stored && status.updatedAt ? { updatedAt: status.updatedAt } : null;
      },
      reveal: async () => (await accountRequest<Status>(`${ENDPOINT}?reveal=1`, account)).password ?? null,
      save: async (password) => {
        const status = await accountRequest<Status>(ENDPOINT, account, { method: "PUT", json: { password } }, "Passwort konnte nicht gespeichert werden.");
        announce();
        return { updatedAt: status.updatedAt ?? Date.now() };
      },
      clear: async () => {
        await accountRequest(ENDPOINT, account, { method: "DELETE" }, "Passwort konnte nicht entfernt werden.");
        announce();
      },
    };
  }
  const store = deviceStore();
  return {
    scope: "device",
    available: !!store,
    info: async () => store ? store.info(SECRET) : null,
    reveal: async () => store ? store.read(SECRET) : null,
    save: async (password) => {
      if (!store) throw new Error("Dieser Browser bietet keinen sicheren Speicher.");
      const result = await store.write(SECRET, password);
      announce();
      return result;
    },
    clear: async () => {
      await store?.remove(SECRET);
      announce();
    },
  };
}

export function usePayslipPasswordStore(): PayslipPasswordStore {
  const account = useAccountWorkspace()?.user.id ?? null;
  return useMemo(() => payslipPasswordStore(account), [account]);
}

export type PayslipPasswordStatus = { state: "loading" | "stored" | "none" | "unavailable" | "error"; updatedAt?: number };

export function usePayslipPasswordStatus(store: PayslipPasswordStore): PayslipPasswordStatus & { refresh: () => void } {
  const [status, setStatus] = useState<PayslipPasswordStatus>({ state: store.available ? "loading" : "unavailable" });
  const [version, setVersion] = useState(0);
  const refresh = useCallback(() => setVersion((current) => current + 1), []);
  useEffect(() => {
    if (!store.available) return;
    let active = true;
    store.info().then(
      (info) => { if (active) setStatus(info ? { state: "stored", updatedAt: info.updatedAt } : { state: "none" }); },
      () => { if (active) setStatus({ state: "error" }); },
    );
    return () => { active = false; };
  }, [store, version]);
  useEffect(() => {
    window.addEventListener(PAYSLIP_PASSWORD_EVENT, refresh);
    return () => window.removeEventListener(PAYSLIP_PASSWORD_EVENT, refresh);
  }, [refresh]);
  return { ...(store.available ? status : { state: "unavailable" }), refresh };
}

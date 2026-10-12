"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  getSecuritySnapshot,
  getServerSecuritySnapshot,
  retrySecurityMode,
  setSecurityPreference,
  subscribeSecurityMode,
  toggleSecurityMode,
  type SecurityActivationPreference,
} from "@/lib/security-mode";

type SecurityContextValue = ReturnType<typeof getSecuritySnapshot> & {
  toggle: () => void;
  retry: () => void;
  setPreference: (preference: SecurityActivationPreference) => void;
};

const SecurityContext = createContext<SecurityContextValue>({
  locked: false,
  ready: true,
  error: null,
  preference: "automatic",
  toggle: () => { throw new Error("SecurityModeProvider fehlt."); },
  retry: () => { throw new Error("SecurityModeProvider fehlt."); },
  setPreference: () => { throw new Error("SecurityModeProvider fehlt."); },
});

export function SecurityModeProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(subscribeSecurityMode, getSecuritySnapshot, getServerSecuritySnapshot);
  const value = useMemo(() => ({
    ...snapshot,
    toggle: toggleSecurityMode,
    retry: retrySecurityMode,
    setPreference: setSecurityPreference,
  }), [snapshot]);
  return <SecurityContext.Provider value={value}>{children}</SecurityContext.Provider>;
}

export const useSecurityMode = () => useContext(SecurityContext);

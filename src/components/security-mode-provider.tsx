"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  getSecuritySnapshot,
  getServerSecuritySnapshot,
  setSecurityMode,
  subscribeSecurityMode,
  toggleSecurityMode,
} from "@/lib/security-mode";

type SecurityContextValue = ReturnType<typeof getSecuritySnapshot> & {
  toggle: () => void;
  retry: () => void;
};

const SecurityContext = createContext<SecurityContextValue>({
  locked: false,
  ready: true,
  error: null,
  toggle: () => { throw new Error("SecurityModeProvider fehlt."); },
  retry: () => { throw new Error("SecurityModeProvider fehlt."); },
});

export function SecurityModeProvider({ children }: { children: ReactNode }) {
  const snapshot = useSyncExternalStore(subscribeSecurityMode, getSecuritySnapshot, getServerSecuritySnapshot);
  const value = useMemo(() => ({
    ...snapshot,
    toggle: toggleSecurityMode,
    retry: () => setSecurityMode(true),
  }), [snapshot]);
  return <SecurityContext.Provider value={value}>{children}</SecurityContext.Provider>;
}

export const useSecurityMode = () => useContext(SecurityContext);

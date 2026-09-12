"use client";

import {
  createContext,
  useContext,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react";
import { usePathname } from "next/navigation";
import { useFinance } from "@/components/finance-provider";
import {
  resolveSeasonalTheme,
  type SeasonalPreference,
  type SeasonalTheme,
} from "@/lib/seasonal-theme";

function localDateSnapshot() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
}
function subscribeCalendar(notify: () => void) {
  let timer: ReturnType<typeof setTimeout>;
  const refresh = () => {
    clearTimeout(timer);
    notify();
    const now = new Date();
    const midnight = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() + 1,
    );
    timer = setTimeout(refresh, midnight.getTime() - now.getTime() + 25);
  };
  refresh();
  window.addEventListener("focus", refresh);
  document.addEventListener("visibilitychange", refresh);
  return () => {
    clearTimeout(timer);
    window.removeEventListener("focus", refresh);
    document.removeEventListener("visibilitychange", refresh);
  };
}

const SeasonalContext = createContext<{
  theme: SeasonalTheme;
  setPreview: Dispatch<SetStateAction<SeasonalPreference | null>>;
} | null>(null);

export function SeasonalThemeProvider({ children }: { children: ReactNode }) {
  const { state, ready } = useFinance();
  const pathname = usePathname();
  const [preview, setPreview] = useState<SeasonalPreference | null>(null);
  const day = useSyncExternalStore(
    subscribeCalendar,
    localDateSnapshot,
    () => null,
  );
  const preference =
    pathname === "/einstellungen" && preview ? preview : state.seasonalTheme;
  const theme =
    day === null ? "default" : resolveSeasonalTheme(preference, new Date(day));
  useLayoutEffect(() => {
    // Keep the pre-paint bootstrap until the finance store has hydrated.
    if (ready && day !== null) document.documentElement.dataset.theme = theme;
  }, [ready, day, theme]);
  return (
    <SeasonalContext.Provider value={{ theme, setPreview }}>
      {children}
    </SeasonalContext.Provider>
  );
}

export function useSeasonalTheme() {
  const context = useContext(SeasonalContext);
  if (!context) throw new Error("SeasonalThemeProvider is missing");
  return context;
}

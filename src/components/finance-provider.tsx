"use client";

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  type ReactNode,
} from "react";
import { ThemeProvider } from "next-themes";
import { Toaster } from "sonner";
import { calculateDashboard, type Dashboard } from "@/lib/calc";
import { appStateSchema, type AppState, type Transaction } from "@/lib/types";
import {
  commitStatementImport,
  queueLedgerReview,
  openReviewCount,
  type FixedChange,
  type FixedDecision,
  type ImportMetadata,
} from "@/lib/import/review";
import { localToday, refreshPlanning, synchronizePlan } from "@/lib/planning";
import { restoreLegacySourceCategories } from "@/lib/legacy-source";

const STORAGE_KEY = "finanzdashboard.v1";
type Store = {
  data: AppState;
  ready: boolean;
  error: string | null;
  saved: boolean;
  blocked: boolean;
  statementImport?: {
    requestId: string;
    added: number;
    duplicates: number;
    changes?: FixedChange[];
    error?: string;
  };
};
type Action =
  | {
      type: "hydrate";
      data: AppState;
      reference?: AppState;
      error?: string;
      blocked?: boolean;
    }
  | { type: "update"; updater: (state: AppState) => AppState }
  | { type: "saved" }
  | { type: "error"; message: string }
  | { type: "retry" };
type AppendAction = {
  type: "appendStatements";
  rows: Transaction[];
  duplicates: number;
  requestId: string;
  decisions?: FixedDecision[];
  metadata?: ImportMetadata;
};
function reducer(store: Store, action: Action | AppendAction): Store {
  switch (action.type) {
    case "appendStatements": {
      try {
        const result = commitStatementImport(
          store.data,
          action.rows,
          action.decisions,
          action.metadata,
        );
        return {
          ...store,
          data: appStateSchema.parse(refreshPlanning(queueLedgerReview(result.state))),
          saved: false,
          statementImport: {
            requestId: action.requestId,
            added: result.added,
            duplicates: action.duplicates + result.duplicates,
            changes: result.changes,
          },
        };
      } catch (error) {
        return {
          ...store,
          statementImport: {
            requestId: action.requestId,
            added: 0,
            duplicates: action.duplicates,
            error:
              error instanceof Error
                ? error.message
                : "Die Buchungen konnten nicht übernommen werden.",
          },
        };
      }
    }
    case "hydrate":
      return {
        data: refreshPlanning(
          queueLedgerReview(restoreLegacySourceCategories(action.data, action.reference)),
        ),
        ready: true,
        error: action.error ?? null,
        saved: false,
        blocked: action.blocked ?? false,
      };
    case "update":
      return {
        ...store,
        data: appStateSchema.parse(synchronizePlan(queueLedgerReview(action.updater(store.data)))),
        saved: false,
      };
    case "saved":
      return { ...store, saved: true, error: null };
    case "error":
      return { ...store, saved: false, error: action.message };
    case "retry":
      return { ...store, blocked: false, data: { ...store.data }, error: null };
  }
}
type FinanceContextValue = {
  state: AppState;
  dashboard: Dashboard;
  openReviewCount: number;
  ready: boolean;
  saved: boolean;
  storageError: string | null;
  update: (updater: (state: AppState) => AppState) => void;
  replace: (state: AppState) => void;
  retrySave: () => void;
  appendStatements: (
    rows: Transaction[],
    duplicates: number,
    requestId: string,
    decisions?: FixedDecision[],
    metadata?: ImportMetadata,
  ) => void;
  statementImport: Store["statementImport"];
};
const FinanceContext = createContext<FinanceContextValue | null>(null);

function createDashboardGetter(state: AppState) {
  // Keep each lazy result bound to its state, including across save-status renders.
  let dashboard: Dashboard | undefined;
  return () => (dashboard ??= calculateDashboard(state));
}

export function FinanceProvider({
  initialState,
  children,
}: {
  initialState: AppState;
  children: ReactNode;
}) {
  const [store, dispatch] = useReducer(reducer, {
    data: initialState,
    ready: false,
    error: null,
    saved: false,
    blocked: false,
  });
  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      dispatch({
        type: "hydrate",
        data: raw ? appStateSchema.parse(JSON.parse(raw)) : initialState,
        reference: initialState,
      });
    } catch {
      dispatch({
        type: "hydrate",
        data: initialState,
        blocked: true,
        error:
          "Lokale Daten konnten nicht geladen werden. Sie werden nicht überschrieben. Bitte eine Excel-Sicherung importieren oder das Speichern ausdrücklich erneut aktivieren.",
      });
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== STORAGE_KEY || !event.newValue) return;
      try {
        dispatch({
          type: "hydrate",
          data: appStateSchema.parse(JSON.parse(event.newValue)),
          reference: initialState,
        });
      } catch {
        dispatch({
          type: "error",
          message: "Die Änderung aus einem anderen Tab ist ungültig.",
        });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [initialState]);
  useEffect(() => {
    let day = localToday();
    const refresh = () => {
      const today = localToday();
      if (day === today) return;
      day = today;
      dispatch({
        type: "update",
        updater: (state) => refreshPlanning(state, today),
      });
    };
    const timer = window.setInterval(refresh, 60_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  useEffect(() => {
    if (!store.ready || store.blocked) return;
    const timer = setTimeout(() => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store.data));
        dispatch({ type: "saved" });
      } catch {
        dispatch({
          type: "error",
          message:
            "Speichern fehlgeschlagen. Browserspeicher voll oder gesperrt. Bitte jetzt eine Excel-Sicherung herunterladen.",
        });
      }
    }, 150);
    const flush = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(store.data));
      } catch {
        /* Reported by the scheduled save. */
      }
    };
    window.addEventListener("pagehide", flush);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("pagehide", flush);
    };
  }, [store.data, store.ready, store.blocked]);
  const getDashboard = useMemo(() => createDashboardGetter(store.data), [store.data]);
  const value: FinanceContextValue = {
    state: store.data,
    get dashboard() {
      return getDashboard();
    },
    openReviewCount: openReviewCount(store.data.reviewQueue ?? []),
    ready: store.ready,
    saved: store.saved,
    storageError: store.error,
    update: (updater) => dispatch({ type: "update", updater }),
    replace: (data) =>
      dispatch({
        type: "hydrate",
        data: appStateSchema.parse(data),
        reference: initialState,
      }),
    retrySave: () => dispatch({ type: "retry" }),
    appendStatements: (rows, duplicates, requestId, decisions, metadata) =>
      dispatch({
        type: "appendStatements",
        rows,
        duplicates,
        requestId,
        decisions,
        metadata,
      }),
    statementImport: store.statementImport,
  };
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      <FinanceContext.Provider value={value}>
        {children}
        <Toaster richColors position="bottom-right" closeButton />
      </FinanceContext.Provider>
    </ThemeProvider>
  );
}
export function useFinance() {
  const context = useContext(FinanceContext);
  if (!context) throw new Error("FinanceProvider is missing");
  return context;
}

"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  type ReactNode,
} from "react";
import { ThemeProvider } from "next-themes";
import { toast, Toaster } from "sonner";
import { actualPockets, calculateDashboard, synchronizeGoals, type Dashboard } from "@/lib/calc";
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
import { approveReviewedBooking } from "@/lib/import/approve-review";
import { useSecurityMode } from "@/components/security-mode-provider";
import { initializePlannedOneOffs } from "@/lib/planned-one-offs";
import { initializeMotorcycleGoal } from "@/lib/goals";
import { FixedPlanCapacityError } from "@/lib/fixed-plan";
import { FINANCE_STORAGE_KEY, FinanceStorage, FinanceStorageError, financeStorageMessage } from "@/lib/finance-storage";

function FinanceNotifications() {
  const { locked } = useSecurityMode();
  return locked ? null : <Toaster richColors position="bottom-right" closeButton />;
}

type Store = {
  data: AppState;
  ready: boolean;
  error: string | null;
  saved: boolean;
  blocked: boolean;
  planCapacityBlocked?: boolean;
  actionError?: { message: string };
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
        const approval = action.rows.length === 1 && !action.decisions?.length &&
          !Object.keys(action.metadata ?? {}).length
          ? approveReviewedBooking(store.data, action.rows[0]) : undefined;
        const result = approval ?? commitStatementImport(
          store.data,
          action.rows,
          action.decisions,
          action.metadata,
        );
        return {
          ...store,
          data: approval ? refreshPlanning(result.state)
            : appStateSchema.parse(refreshPlanning(queueLedgerReview(result.state))),
          saved: false,
          planCapacityBlocked: false,
          actionError: undefined,
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
    case "hydrate": {
      try {
        const data = refreshPlanning(
          queueLedgerReview(initializePlannedOneOffs(restoreLegacySourceCategories(action.data, action.reference))),
        );
        return {
          data: appStateSchema.parse(synchronizeGoals(initializeMotorcycleGoal(data, actualPockets(data).Motorrad))),
          ready: true,
          error: action.error ?? null,
          saved: false,
          blocked: action.blocked ?? false,
        };
      } catch (error) {
        if (!(error instanceof FixedPlanCapacityError)) throw error;
        return { data: action.data, ready: true, saved: false, blocked: action.blocked ?? false,
          error: action.error ?? null, planCapacityBlocked: true, actionError: { message: error.message } };
      }
    }
    case "update": {
      const updated = action.updater(store.data);
      try {
        return {
          ...store,
          data: appStateSchema.parse(synchronizePlan(queueLedgerReview(updated))),
          saved: false, planCapacityBlocked: false, actionError: undefined,
        };
      } catch (error) {
        if (!(error instanceof FixedPlanCapacityError)) throw error;
        return { ...store,
          data: store.planCapacityBlocked ? appStateSchema.parse(updated) : store.data,
          saved: store.planCapacityBlocked ? false : store.saved,
          actionError: { message: error.message },
        };
      }
    }
    case "saved":
      return { ...store, saved: true, error: null };
    case "error":
      return { ...store, saved: false, error: action.message };
    case "retry":
      return { ...store, saved: false, data: { ...store.data }, error: null };
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
  const storage = useRef(new FinanceStorage()).current;
  const hydrated = useRef(false);
  const latest = useRef(store);
  useEffect(() => { latest.current = store; }, [store]);
  const load = useCallback((fallback: AppState) => {
    try {
      const result = storage.load(fallback);
      dispatch({ type: "hydrate", data: result.data, reference: initialState });
      if (result.recovered) toast.success("Lokale Sicherung geladen.");
    } catch (error) {
      dispatch({
        type: "hydrate",
        data: fallback,
        blocked: true,
        error: financeStorageMessage(error),
      });
    }
  }, [initialState, storage]);
  useEffect(() => {
    if (store.actionError) toast.error(store.actionError.message);
  }, [store.actionError]);
  useEffect(() => {
    // Server props and Fast Refresh must not rehydrate over the working ledger.
    if (!hydrated.current) {
      hydrated.current = true;
      load(initialState);
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key !== FINANCE_STORAGE_KEY && event.key !== null) return;
      try {
        if (event.storageArea && event.storageArea !== localStorage) return;
        if (!storage.changedElsewhere()) return;
        if (!latest.current.saved) {
          dispatch({ type: "error", message: "Ein anderer Tab hat Daten geändert. Ungesicherte Änderungen bleiben hier erhalten. Bitte als Excel sichern und neu laden." });
          return;
        }
        load(latest.current.data);
      } catch (error) {
        dispatch({
          type: "error",
          message: financeStorageMessage(error),
        });
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [initialState, load, storage]);
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
    if (!store.ready || store.blocked || store.saved) return;
    try {
      storage.save(store.data);
      dispatch({ type: "saved" });
    } catch (error) {
      dispatch({ type: "error", message: financeStorageMessage(error) });
    }
  }, [store.data, store.ready, store.blocked, store.saved, storage]);
  const getDashboard = useMemo(() => createDashboardGetter(store.data), [store.data]);
  const update = useCallback<FinanceContextValue["update"]>(
    (updater) => dispatch({ type: "update", updater }),
    [],
  );
  const appendStatements = useCallback<FinanceContextValue["appendStatements"]>(
    (rows, duplicates, requestId, decisions, metadata) =>
      dispatch({ type: "appendStatements", rows, duplicates, requestId, decisions, metadata }),
    [],
  );
  const value: FinanceContextValue = {
    state: store.data,
    get dashboard() {
      return getDashboard();
    },
    openReviewCount: openReviewCount(store.data.reviewQueue ?? []),
    ready: store.ready,
    saved: store.saved,
    storageError: store.error,
    update,
    replace: (data) => {
      const parsed = appStateSchema.parse(data);
      try {
        storage.prepareReplacement();
      } catch (error) {
        const message = financeStorageMessage(error);
        dispatch({ type: "error", message });
        throw new FinanceStorageError(message);
      }
      dispatch({
        type: "hydrate",
        data: parsed,
        reference: initialState,
      });
    },
    retrySave: () => store.blocked ? load(store.data) : dispatch({ type: "retry" }),
    appendStatements,
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
        <FinanceNotifications />
      </FinanceContext.Provider>
    </ThemeProvider>
  );
}
export function useFinance() {
  const context = useContext(FinanceContext);
  if (!context) throw new Error("FinanceProvider is missing");
  return context;
}

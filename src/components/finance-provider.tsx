"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
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
import { assignAfterImport } from "@/lib/ai/auto-assign";
import { useSecurityMode } from "@/components/security-mode-provider";
import { initializePlannedOneOffs } from "@/lib/planned-one-offs";
import { initializeMotorcycleGoal } from "@/lib/goals";
import { FixedPlanCapacityError } from "@/lib/fixed-plan";
import { FINANCE_STORAGE_KEY, FinanceStorage, FinanceStorageError, financeStorageMessage } from "@/lib/finance-storage";
import { amexBalanceRecoveryResponseSchema, needsAmexBalanceRecovery, recoverAmexBalance, type AmexBalanceRecovery } from "@/lib/import/amex-balance-recovery";
import type { AccountUser } from "@/lib/account-schema";
import { AccountFinanceStorage, AccountSessionError, AccountReconciliationError, AccountWorkingChangeError, canAutomaticallyReconcile } from "@/lib/account-finance-storage";
import { sameFinanceData } from "@/lib/account-finance-merge";
import { AccountWorkspaceContext } from "@/components/account-context";
import { createEmptyAccountState } from "@/lib/account-state";
import { AutomationContext } from "@/components/automation-context";
import { automationEventSchema, type AutomationEvent } from "@/lib/automation/schema";

function FinanceNotifications() {
  const { locked } = useSecurityMode();
  return locked ? null : <Toaster richColors position="bottom-right" closeButton />;
}

type Store = {
  data: AppState;
  ready: boolean;
  error: string | null;
  errorCause?: unknown;
  saved: boolean;
  blocked: boolean;
  planCapacityBlocked?: boolean;
  actionError?: { message: string };
  restoration?: { id: string; error?: string };
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
      cause?: unknown;
      blocked?: boolean;
    }
  | { type: "update"; updater: (state: AppState) => AppState }
  | { type: "restore"; id: string; data: AppState; expected: AppState }
  | { type: "recoverAmexBalance"; recoveries: AmexBalanceRecovery[] }
  | { type: "saved"; data?: AppState }
  | { type: "error"; message: string; cause?: unknown }
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
    case "recoverAmexBalance": {
      if (store.blocked || store.error) return store;
      const data = recoverAmexBalance(store.data, action.recoveries);
      return data === store.data ? store : { ...store, data, saved: false };
    }
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
        const uploadIds = (action.metadata?.imports ?? []).map((source) => source.uploadId);
        const committed = approval ? refreshPlanning(result.state)
          : appStateSchema.parse(refreshPlanning(queueLedgerReview(result.state)));
        return {
          ...store,
          data: uploadIds.length ? assignAfterImport(committed, uploadIds) : committed,
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
    case "restore":
    case "hydrate": {
      if (action.type === "restore" && action.expected !== store.data)
        return { ...store, restoration: { id: action.id, error: "Der Finanzstand wurde zwischenzeitlich geändert. Bitte die Vorschau erneut bestätigen." } };
      try {
        const data = refreshPlanning(
          queueLedgerReview(initializePlannedOneOffs(restoreLegacySourceCategories(action.data, action.type === "hydrate" ? action.reference : undefined))),
        );
        return {
          data: appStateSchema.parse(synchronizeGoals(initializeMotorcycleGoal(data, actualPockets(data).Motorrad))),
          ready: true,
          error: action.type === "hydrate" ? action.error ?? null : null,
          errorCause: action.type === "hydrate" ? action.cause : undefined,
          saved: false,
          blocked: action.type === "hydrate" ? action.blocked ?? false : false,
          restoration: action.type === "restore" ? { id: action.id } : store.restoration,
        };
      } catch (error) {
        if (!(error instanceof FixedPlanCapacityError)) throw error;
        if (action.type === "restore")
          return { ...store, restoration: { id: action.id, error: error.message } };
        return { data: action.data, ready: true, saved: false, blocked: action.blocked ?? false,
          error: action.error ?? null, errorCause: action.cause, planCapacityBlocked: true, actionError: { message: error.message } };
      }
    }
    case "update": {
      const updated = action.updater(store.data);
      if (updated === store.data) return store;
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
      if (action.data && action.data !== store.data) return store;
      return { ...store, saved: true, error: null, errorCause: undefined };
    case "error":
      return { ...store, saved: false, error: action.message, errorCause: action.cause };
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
  synchronizing?: boolean;
  syncNeedsAttention?: boolean;
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
type FinanceRestoration = (state: AppState, expected: AppState) => Promise<void>;
const FinanceRestorationContext = createContext<FinanceRestoration | null>(null);

function createDashboardGetter(state: AppState) {
  // Keep each lazy result bound to its state, including across save-status renders.
  let dashboard: Dashboard | undefined;
  return () => (dashboard ??= calculateDashboard(state));
}

export function FinanceProvider({
  initialState,
  children,
  account,
}: {
  initialState: AppState;
  children: ReactNode;
  account?: AccountUser;
}) {
  const settled = useRef(false);
  const [store, dispatch] = useReducer(reducer, {
    data: initialState,
    ready: false,
    error: null,
    saved: false,
    blocked: false,
  });
  const [storage] = useState(() => new FinanceStorage());
  const [automation, setAutomation] = useState<AutomationEvent>({ revision: 0, jobs: [] });
  const [automationError, setAutomationError] = useState<string | null>(null);
  const [synchronizing, setSynchronizing] = useState(false);
  const [recoveryTick, setRecoveryTick] = useState(0);
  const recovery = useRef({ attempts: 0, running: false });
  const handleCloudError = useCallback((error: unknown) => {
    if (error instanceof AccountSessionError) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination -- Clear the previous account's in-memory ledger.
      window.location.assign("/login");
      return;
    }
    dispatch({ type: "error", message: financeStorageMessage(error), cause: error });
  }, []);
  const [accountInitial] = useState(initialState);
  const [cloud] = useState(() => account ? new AccountFinanceStorage(
    account.id,
    (data) => dispatch({ type: "saved", data }),
    handleCloudError,
  ) : null);
  const hydrated = useRef(false);
  const amexRecoveryNeeded = useMemo(() => needsAmexBalanceRecovery(store.data), [store.data]);
  const latest = useRef(store);
  const restoring = useRef<{
    id: string;
    resolve: () => void;
    reject: (error: FinanceStorageError) => void;
  } | null>(null);
  useLayoutEffect(() => { latest.current = store; }, [store]);
  const reconcileAccount = useCallback(async () => {
    if (!cloud) return;
    const expected = latest.current.data;
    setSynchronizing(true);
    try {
      const data = latest.current.blocked
        ? await cloud.load()
        : await cloud.reconcileServer(expected, () => sameFinanceData(latest.current.data, expected));
      if (!sameFinanceData(latest.current.data, expected))
        throw new AccountWorkingChangeError("Neue Geräteänderungen werden erneut abgeglichen.");
      if (cloud.error && latest.current.blocked) {
        dispatch({ type: "hydrate", data: data ?? accountInitial, error: cloud.error.message, cause: cloud.error });
        throw cloud.error;
      }
      recovery.current.attempts = 0;
      dispatch({ type: "hydrate", data: data ?? accountInitial });
    } catch (error) {
      if (error instanceof AccountReconciliationError && sameFinanceData(latest.current.data, expected))
        dispatch({ type: "hydrate", data: error.pendingState, error: error.message, cause: error });
      handleCloudError(error);
      throw error;
    } finally {
      setSynchronizing(false);
    }
  }, [cloud, handleCloudError, accountInitial]);
  useEffect(() => {
    if (!cloud || !store.ready || !store.error || recovery.current.running ||
      !canAutomaticallyReconcile(store.errorCause ?? cloud.error)) return;
    const delays = [0, 2_000, 10_000, 30_000];
    const attempt = recovery.current.attempts;
    if (attempt >= delays.length) return;
    const timer = window.setTimeout(async () => {
      if (cloud.synchronizing || !navigator.onLine) return;
      recovery.current.running = true;
      recovery.current.attempts++;
      try { await reconcileAccount(); }
      catch (error) {
        if (!(error instanceof FinanceStorageError) && !(error instanceof DOMException)) throw error;
      } finally {
        recovery.current.running = false;
        setRecoveryTick((value) => value + 1);
      }
    }, delays[attempt]);
    return () => window.clearTimeout(timer);
  }, [cloud, store.ready, store.blocked, store.error, store.errorCause, store.data, reconcileAccount, recoveryTick]);
  useEffect(() => {
    const pending = restoring.current;
    if (!pending || store.restoration?.id !== pending.id) return;
    const error = store.restoration.error ?? store.error;
    if (error) {
      restoring.current = null;
      pending.reject(new FinanceStorageError(error));
    } else if (store.saved) {
      restoring.current = null;
      pending.resolve();
    }
  }, [store.restoration, store.error, store.saved]);
  useEffect(() => () => {
    restoring.current?.reject(new FinanceStorageError("Der Arbeitsbereich wurde geschlossen. Bitte den gespeicherten Stand prüfen."));
    restoring.current = null;
  }, []);
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
    if (cloud) return;
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
  }, [initialState, load, storage, cloud]);
  useEffect(() => {
    if (!cloud) return;
    cloud.activate();
    let active = true;
    let polling = false;
    async function hydrateAccount() {
      try {
        const data = await cloud!.load();
        if (!active) return;
        dispatch({ type: "hydrate", data: data ?? accountInitial, error: cloud!.error?.message, cause: cloud!.error });
      } catch (error) {
        if (!active) return;
        dispatch({ type: "hydrate", data: cloud!.cachedState ?? accountInitial, blocked: true });
        handleCloudError(error);
      }
    }
    async function poll() {
      if (latest.current.error && canAutomaticallyReconcile(latest.current.errorCause ?? cloud!.error)) {
        if (recovery.current.running || cloud!.synchronizing || !navigator.onLine) return;
        recovery.current.attempts = 0;
        recovery.current.running = true;
        try { await reconcileAccount(); }
        catch (error) {
          if (!(error instanceof FinanceStorageError) && !(error instanceof DOMException)) throw error;
        } finally {
          recovery.current.running = false;
          setRecoveryTick((value) => value + 1);
        }
        return;
      }
      if (polling || !latest.current.saved || latest.current.error || !navigator.onLine) return;
      polling = true;
      try {
        const data = await cloud!.poll();
        if (active && data && latest.current.saved)
          dispatch({ type: "hydrate", data });
      } catch (error) {
        if (active) handleCloudError(error);
      } finally {
        polling = false;
      }
    }
    void hydrateAccount();
    const refresh = () => { void poll(); };
    window.addEventListener("focus", refresh);
    window.addEventListener("online", refresh);
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (!latest.current.saved) event.preventDefault();
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => {
      active = false;
      cloud.dispose();
      window.removeEventListener("focus", refresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("beforeunload", beforeUnload);
    };
  }, [cloud, handleCloudError, accountInitial, reconcileAccount]);
  useEffect(() => {
    if (!account || !cloud) return;
    const source = new EventSource(`/api/statements/events?account=${encodeURIComponent(account.id)}`);
    source.addEventListener("progress", (event) => {
      try {
        const parsed = automationEventSchema.parse(JSON.parse((event as MessageEvent<string>).data));
        setAutomation(parsed);
        setAutomationError(null);
      } catch {
        setAutomationError("Ungültiges Echtzeit-Update. Bitte die Seite neu laden.");
        source.close();
      }
    });
    source.addEventListener("unauthorized", () => {
      source.close();
      handleCloudError(new AccountSessionError("Bitte erneut anmelden."));
    });
    source.addEventListener("unavailable", () => {
      setAutomationError("Hintergrundstatus derzeit nicht verfügbar. Die Verbindung wird wiederhergestellt.");
    });
    source.onerror = () => setAutomationError("Echtzeit-Verbindung unterbrochen. Wiederverbindung erfolgt automatisch.");
    return () => source.close();
  }, [account, cloud, handleCloudError]);
  useEffect(() => {
    if (!cloud || !store.saved || store.error || automation.revision <= cloud.revision) return;
    void cloud.poll().then((data) => {
      if (data && latest.current.saved) dispatch({ type: "hydrate", data });
    }, handleCloudError);
  }, [automation.revision, cloud, store.saved, store.error, handleCloudError]);
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
    if (!store.ready || store.blocked || store.error || settled.current) return;
    if (!store.data.reviewQueue?.length) return;
    settled.current = true;
    void import("@/lib/automation/settle-open").then(({ settleOpenReviews }) => {
      dispatch({ type: "update", updater: settleOpenReviews });
    });
  }, [store.ready, store.blocked, store.error, store.data.reviewQueue]);
  useEffect(() => {
    if (!store.ready || store.blocked || store.saved) return;
    try {
      if (cloud) {
        cloud.save(store.data);
        return;
      }
      storage.save(store.data);
      dispatch({ type: "saved" });
    } catch (error) {
      if (cloud) handleCloudError(error);
      else dispatch({ type: "error", message: financeStorageMessage(error) });
    }
  }, [store.data, store.ready, store.blocked, store.saved, storage, cloud, handleCloudError]);
  useEffect(() => {
    if (account || !store.ready || store.blocked || store.error || !amexRecoveryNeeded) return;
    const controller = new AbortController();
    async function recover() {
      try {
        const response = await fetch("/api/amex-balance-recovery", {
          cache: "no-store", signal: controller.signal,
        });
        if (!response.ok) throw new Error("Amex-Saldo konnte nicht nachgetragen werden. Bitte den Screenshot mit Gesamtbetrag erneut auswählen.");
        const result = amexBalanceRecoveryResponseSchema.safeParse(await response.json());
        if (!result.success) throw new Error("Amex-Saldoreparatur lieferte ungültige Daten. Bitte den Screenshot mit Gesamtbetrag erneut auswählen.");
        if (!controller.signal.aborted) {
          if (needsAmexBalanceRecovery(latest.current.data) &&
            recoverAmexBalance(latest.current.data, result.data.recoveries) === latest.current.data)
            toast.error("Amex-Gesamtbetrag fehlt. Bitte den Screenshot mit Gesamtbetrag erneut auswählen.");
          dispatch({ type: "recoverAmexBalance", recoveries: result.data.recoveries });
        }
      } catch (error) {
        if (!controller.signal.aborted) toast.error(error instanceof Error
          ? error.message : "Amex-Saldo konnte nicht nachgetragen werden. Bitte den Screenshot erneut auswählen.");
      }
    }
    void recover();
    return () => controller.abort();
  }, [store.ready, store.blocked, store.error, amexRecoveryNeeded, account]);
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
  const restore = useCallback<FinanceRestoration>((data, expected) => {
    const parsed = appStateSchema.parse(data);
    if (restoring.current) throw new FinanceStorageError("Eine Wiederherstellung läuft bereits.");
    if (expected !== latest.current.data) throw new FinanceStorageError("Der Finanzstand wurde zwischenzeitlich geändert. Bitte die Vorschau aktualisieren.");
    if (cloud?.error) throw new FinanceStorageError("Bitte zuerst den Gerätestand sichern und den Serverstand laden. Die Konfliktsicherung bleibt erhalten.");
    if (!cloud) {
      try {
        if (storage.changedElsewhere()) throw new FinanceStorageError("Ein anderer Tab hat die Daten geändert. Bitte den aktuellen Stand laden und die Vorschau erneut prüfen.");
        storage.prepareReplacement();
      } catch (error) {
        throw new FinanceStorageError(financeStorageMessage(error));
      }
    }
    const id = crypto.randomUUID();
    const pending = new Promise<void>((resolve, reject) => { restoring.current = { id, resolve, reject }; });
    dispatch({ type: "restore", id, data: parsed, expected });
    return pending;
  }, [cloud, storage]);
  const value: FinanceContextValue = {
    state: store.data,
    get dashboard() {
      return getDashboard();
    },
    openReviewCount: openReviewCount(store.data.reviewQueue ?? []),
    ready: store.ready,
    saved: store.saved,
    storageError: store.error,
    synchronizing,
    syncNeedsAttention: !!cloud && !!store.error && !canAutomaticallyReconcile(store.errorCause ?? cloud.error),
    update,
    replace: (data) => {
      const parsed = appStateSchema.parse(data);
      try {
        if (!cloud) storage.prepareReplacement();
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
    retrySave: () => {
      if (cloud) {
        recovery.current.attempts = 0;
        if (canAutomaticallyReconcile(latest.current.errorCause ?? cloud.error)) {
          void reconcileAccount().catch((error: unknown) => {
            if (!(error instanceof FinanceStorageError) && !(error instanceof DOMException)) throw error;
          });
          return;
        }
        void cloud.retry(latest.current.data).then((data) => {
          dispatch({ type: "hydrate", data: data ?? createEmptyAccountState(), error: cloud.error?.message, cause: cloud.error });
        }, handleCloudError);
      } else if (store.blocked) load(store.data);
      else dispatch({ type: "retry" });
    },
    appendStatements,
    statementImport: store.statementImport,
  };
  const workspace = account && cloud ? {
    user: account,
    reconcileServer: reconcileAccount,
    loadServer: async () => {
      try {
        const data = await cloud.useServer();
        dispatch({ type: "hydrate", data: data ?? createEmptyAccountState() });
      } catch (error) {
        handleCloudError(error);
        throw error;
      }
    },
  } : null;
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="dark"
      enableSystem={false}
      disableTransitionOnChange
    >
      <FinanceContext.Provider value={value}>
        <FinanceRestorationContext.Provider value={restore}>
        <AccountWorkspaceContext.Provider value={workspace}>
        <AutomationContext.Provider value={{ jobs: automation.jobs, error: automationError, catalogue: automation.catalogue, worker: automation.worker }}>
        {children}
        <FinanceNotifications />
        </AutomationContext.Provider>
        </AccountWorkspaceContext.Provider>
        </FinanceRestorationContext.Provider>
      </FinanceContext.Provider>
    </ThemeProvider>
  );
}
export function useFinance() {
  const context = useContext(FinanceContext);
  if (!context) throw new Error("FinanceProvider is missing");
  return context;
}
export function useFinanceRestoration() {
  const restore = useContext(FinanceRestorationContext);
  if (!restore) throw new Error("FinanceProvider is missing");
  return restore;
}

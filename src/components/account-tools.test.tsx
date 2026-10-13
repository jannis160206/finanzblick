// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountWorkspaceContext, type AccountWorkspace } from "./account-context";
import { AccountLogout, AccountSyncTools } from "./account-tools";
import { AccountFinanceStorage, accountStorageKey, accountConflictKey } from "@/lib/account-finance-storage";
import { createEmptyAccountState } from "@/lib/account-state";
import { FINANCE_BACKUP_KEY, FINANCE_STORAGE_KEY, FinanceStorageError } from "@/lib/finance-storage";
import { appStateSchema, type AppState } from "@/lib/types";
import { legacyNoticeKey } from "@/lib/legacy-account-notice";
import { parseFinanceBackup } from "@/lib/finance-backup";

const { useFinanceMock, restoreMock } = vi.hoisted(() => ({ useFinanceMock: vi.fn(), restoreMock: vi.fn() }));
vi.mock("./finance-provider", () => ({ useFinance: useFinanceMock, useFinanceRestoration: () => restoreMock }));

type FinanceFixture = {
  state: AppState;
  saved: boolean;
  storageError: string | null;
  replace: ReturnType<typeof vi.fn<(state: AppState | null) => void>>;
};

let finance: FinanceFixture;
const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const loadServer = vi.fn<() => Promise<void>>();

function fixture(description = "Eigene Testbuchung"): AppState {
  return {
    ...createEmptyAccountState(),
    transactions: [{
      id: "test-booking",
      date: "2026-10-06",
      bank: "Amex",
      pocket: "Amex",
      description,
      amount: -10,
      category: "Shopping",
      includeInPlan: true,
    }],
  };
}

function workspace(role: "admin" | "user" = "admin"): AccountWorkspace {
  return { user: { id: "own-account", username: "my.account", role }, loadServer };
}

function mount(children = <AccountSyncTools />, account: AccountWorkspace | null = workspace()) {
  return render(<AccountWorkspaceContext value={account}>{children}</AccountWorkspaceContext>);
}

function seedLegacy(state = fixture("Bisherige Browserbuchung")) {
  const original = JSON.stringify(state);
  localStorage.setItem(FINANCE_STORAGE_KEY, original);
  localStorage.setItem(FINANCE_BACKUP_KEY, original);
  return original;
}

function readBlob(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

beforeEach(() => {
  localStorage.clear();
  finance = { state: fixture(), saved: true, storageError: null, replace: vi.fn<(state: AppState | null) => void>() };
  useFinanceMock.mockReset();
  useFinanceMock.mockImplementation(() => finance);
  fetchMock.mockReset();
  assign.mockReset();
  loadServer.mockReset();
  loadServer.mockResolvedValue(undefined);
  restoreMock.mockReset();
  restoreMock.mockResolvedValue(undefined);
  vi.stubGlobal("fetch", fetchMock);
  const browser = window;
  const mockWindow = Object.create(browser) as Window;
  Object.defineProperty(mockWindow, "location", { value: { assign } });
  mockWindow.addEventListener = browser.addEventListener.bind(browser);
  mockWindow.removeEventListener = browser.removeEventListener.bind(browser);
  vi.stubGlobal("window", mockWindow);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("AccountSyncTools", () => {
  it("renders nothing outside an account workspace and never reads legacy data", () => {
    seedLegacy();
    const read = vi.spyOn(Storage.prototype, "getItem");
    const view = mount(<><AccountSyncTools /><AccountLogout /></>, null);
    expect(view.container.textContent).toBe("");
    expect(read).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires an admin's explicit confirmation before migrating and preserves both originals", async () => {
    const legacy = fixture("Bisherige Browserbuchung");
    const original = seedLegacy(legacy);
    mount();
    expect(screen.getByText(/Nur nach deiner Bestätigung/)).toBeTruthy();
    expect(finance.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Bisherige Browserdaten übernehmen" }));
    expect(screen.getByText(/Die Originaldaten im Browser bleiben erhalten/)).toBeTruthy();
    expect(finance.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Übernahme bestätigen" }));
    await waitFor(() => expect(finance.replace).toHaveBeenCalledExactlyOnceWith(appStateSchema.parse(legacy)));
    expect(loadServer).not.toHaveBeenCalled();
    expect(localStorage.getItem(FINANCE_STORAGE_KEY)).toBe(original);
    expect(localStorage.getItem(FINANCE_BACKUP_KEY)).toBe(original);
    expect(screen.queryByRole("button", { name: "Bisherige Browserdaten übernehmen" })).toBeNull();
    cleanup();
    mount();
    expect(screen.queryByRole("region", { name: "Kontodaten übertragen" })).toBeNull();
    expect(finance.replace).toHaveBeenCalledOnce();
  });

  it("shows the initial notice only once across remounts without importing or deleting legacy data", () => {
    const original = seedLegacy();
    const view = mount();
    expect(screen.getByText(/Nur nach deiner Bestätigung/)).toBeTruthy();
    expect(localStorage.getItem(legacyNoticeKey("own-account"))).toBe("seen");
    act(() => window.dispatchEvent(new Event("storage")));
    expect(screen.getByRole("button", { name: "Bisherige Browserdaten übernehmen" })).toBeTruthy();
    view.unmount();
    mount();
    expect(screen.queryByRole("region", { name: "Kontodaten übertragen" })).toBeNull();
    expect(finance.replace).not.toHaveBeenCalled();
    expect(localStorage.getItem(FINANCE_STORAGE_KEY)).toBe(original);
    expect(localStorage.getItem(FINANCE_BACKUP_KEY)).toBe(original);
  });

  it("does not mark an unseen notice behind privacy or loading as shown", () => {
    seedLegacy();
    const view = mount(<AccountSyncTools visible={false} />);
    expect(localStorage.getItem(legacyNoticeKey("own-account"))).toBeNull();
    view.unmount();
    mount();
    expect(screen.getByRole("button", { name: "Bisherige Browserdaten übernehmen" })).toBeTruthy();
    expect(localStorage.getItem(legacyNoticeKey("own-account"))).toBe("seen");
  });

  it("does not count conflict recovery text as the legacy notice being shown", () => {
    seedLegacy();
    finance.storageError = "Synchronisierungskonflikt";
    const view = mount();
    expect(localStorage.getItem(legacyNoticeKey("own-account"))).toBeNull();
    view.unmount();
    finance.storageError = null;
    mount();
    expect(screen.getByText(/In diesem Browser liegen/)).toBeTruthy();
    expect(localStorage.getItem(legacyNoticeKey("own-account"))).toBe("seen");
  });

  it("allows hiding the current notice without touching either ledger or suppressing sync conflict controls", () => {
    const original = seedLegacy();
    finance.storageError = "Synchronisierungskonflikt";
    fireEvent.click(mount().getByRole("button", { name: "Hinweis ausblenden" }));
    expect(screen.queryByRole("button", { name: "Bisherige Browserdaten übernehmen" })).toBeNull();
    expect(screen.getByRole("button", { name: "Serverstand laden" })).toBeTruthy();
    expect(screen.queryByText(/In diesem Browser liegen/)).toBeNull();
    cleanup();
    mount();
    expect(screen.getByRole("button", { name: "Serverstand laden" })).toBeTruthy();
    expect(finance.replace).not.toHaveBeenCalled();
    expect(loadServer).not.toHaveBeenCalled();
    expect(localStorage.getItem(FINANCE_STORAGE_KEY)).toBe(original);
    expect(localStorage.getItem(FINANCE_BACKUP_KEY)).toBe(original);
  });

  it("keeps later manual migration available after the once-only notice", async () => {
    const legacy = fixture("Bisherige Browserbuchung");
    const original = seedLegacy(legacy);
    const view = mount();
    view.unmount();
    mount(<AccountSyncTools manual />);
    fireEvent.click(screen.getByText("Bisherige Browserdaten", { exact: true }));
    fireEvent.click(screen.getByRole("button", { name: "Bisherige Browserdaten übernehmen" }));
    expect(finance.replace).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Übernahme bestätigen" }));
    await waitFor(() => expect(finance.replace).toHaveBeenCalledExactlyOnceWith(appStateSchema.parse(legacy)));
    expect(localStorage.getItem(FINANCE_STORAGE_KEY)).toBe(original);
    expect(localStorage.getItem(FINANCE_BACKUP_KEY)).toBe(original);
  });

  it("scopes the notice to the administrator identity rather than hiding it for another account", () => {
    seedLegacy();
    const view = mount();
    view.unmount();
    mount(<AccountSyncTools />, { ...workspace(), user: { ...workspace().user, id: "other-admin" } });
    expect(screen.getByRole("button", { name: "Bisherige Browserdaten übernehmen" })).toBeTruthy();
    expect(localStorage.getItem(legacyNoticeKey("other-admin"))).toBe("seen");
    expect(finance.replace).not.toHaveBeenCalled();
  });

  it("reports failed notice persistence without silently hiding the migration controls", () => {
    const original = seedLegacy();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("Storage full", "QuotaExceededError");
    });
    mount();
    expect(screen.getByRole("alert").textContent).toContain("Hinweis konnte nicht dauerhaft gespeichert werden");
    expect(screen.getByRole("button", { name: "Bisherige Browserdaten übernehmen" })).toBeTruthy();
    expect(finance.replace).not.toHaveBeenCalled();
    expect(localStorage.getItem(FINANCE_STORAGE_KEY)).toBe(original);
  });

  it("does not replace the account with an empty fallback if legacy data disappears during confirmation", async () => {
    seedLegacy();
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Bisherige Browserdaten übernehmen" }));
    localStorage.removeItem(FINANCE_STORAGE_KEY);
    localStorage.removeItem(FINANCE_BACKUP_KEY);
    fireEvent.click(screen.getByRole("button", { name: "Übernahme bestätigen" }));
    expect((await screen.findByRole("alert")).textContent).toContain("nicht mehr vorhanden");
    expect(finance.replace).not.toHaveBeenCalled();
  });

  it("cancels legacy confirmation without changing either ledger", () => {
    const original = seedLegacy();
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Bisherige Browserdaten übernehmen" }));
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(screen.queryByRole("button", { name: "Übernahme bestätigen" })).toBeNull();
    expect(finance.replace).not.toHaveBeenCalled();
    expect(loadServer).not.toHaveBeenCalled();
    expect(localStorage.getItem(FINANCE_STORAGE_KEY)).toBe(original);
    expect(localStorage.getItem(FINANCE_BACKUP_KEY)).toBe(original);
  });

  it("recovers an admin's valid backup without overwriting the unreadable original", async () => {
    const legacy = fixture("Sicherungsbuchung");
    localStorage.setItem(FINANCE_STORAGE_KEY, "{unreadable original");
    localStorage.setItem(FINANCE_BACKUP_KEY, JSON.stringify(legacy));
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Bisherige Browserdaten übernehmen" }));
    fireEvent.click(screen.getByRole("button", { name: "Übernahme bestätigen" }));
    await waitFor(() => expect(finance.replace).toHaveBeenCalledWith(appStateSchema.parse(legacy)));
    expect(localStorage.getItem(FINANCE_STORAGE_KEY)).toBe("{unreadable original");
    expect(localStorage.getItem(FINANCE_BACKUP_KEY)).toBe(JSON.stringify(legacy));
  });

  it("reports unreadable legacy data without replacing state or deleting originals", async () => {
    localStorage.setItem(FINANCE_STORAGE_KEY, "{unreadable original");
    localStorage.setItem(FINANCE_BACKUP_KEY, "{unreadable backup");
    mount();
    fireEvent.click(screen.getByRole("button", { name: "Bisherige Browserdaten übernehmen" }));
    fireEvent.click(screen.getByRole("button", { name: "Übernahme bestätigen" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Lokale Daten sind nicht lesbar und bleiben unverändert.");
    expect(finance.replace).not.toHaveBeenCalled();
    expect(localStorage.getItem(FINANCE_STORAGE_KEY)).toBe("{unreadable original");
    expect(localStorage.getItem(FINANCE_BACKUP_KEY)).toBe("{unreadable backup");
    expect((screen.getByRole("button", { name: "Übernahme bestätigen" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("informs admins when legacy storage is blocked rather than silently discarding data", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    mount();
    expect(screen.getAllByRole("alert").map((alert) => alert.textContent).join(" ")).toContain("Bisherige Browserdaten sind nicht erreichbar.");
    expect(screen.queryByRole("button", { name: "Bisherige Browserdaten übernehmen" })).toBeNull();
    expect(finance.replace).not.toHaveBeenCalled();
  });

  it.each([null, "Neuere Daten sind auf dem Server vorhanden."])(
    "never reads or offers legacy migration to normal users, even with sync error %s",
    (storageError) => {
      seedLegacy();
      finance.storageError = storageError;
      const read = vi.spyOn(Storage.prototype, "getItem");
      mount(<AccountSyncTools />, workspace("user"));
      expect(read).not.toHaveBeenCalledWith(FINANCE_STORAGE_KEY);
      expect(read).not.toHaveBeenCalledWith(FINANCE_BACKUP_KEY);
      expect(screen.queryByRole("button", { name: "Bisherige Browserdaten übernehmen" })).toBeNull();
      if (storageError) expect(screen.getByRole("button", { name: "Serverstand laden" })).toBeTruthy();
      else expect(screen.queryByRole("region", { name: "Kontodaten übertragen" })).toBeNull();
      expect(finance.replace).not.toHaveBeenCalled();
    },
  );

  it("reacts to legacy data appearing in another tab and unsubscribes on unmount", () => {
    const unsubscribe = vi.spyOn(window, "removeEventListener");
    const view = mount();
    expect(screen.queryByRole("region", { name: "Kontodaten übertragen" })).toBeNull();
    seedLegacy();
    act(() => window.dispatchEvent(new Event("storage")));
    expect(screen.getByRole("button", { name: "Bisherige Browserdaten übernehmen" })).toBeTruthy();
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledWith("storage", expect.any(Function));
  });

  it("downloads the validated current account JSON, not legacy data, and revokes the object URL", async () => {
    seedLegacy();
    finance.storageError = "Synchronisierungskonflikt";
    let captured: Blob | undefined;
    const createObjectURL = vi.fn((blob: Blob) => { captured = blob; return "blob:account-backup"; });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    let download: HTMLAnchorElement | undefined;
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      download = this.cloneNode(true) as HTMLAnchorElement;
    });
    mount(<AccountSyncTools />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Gerätestand sichern" }));
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(captured?.type).toBe("application/json");
    expect(download?.href).toBe("blob:account-backup");
    expect(download?.download).toBe(`Finanzblick_my.account_${finance.state.settings.asOf}.json`);
    const raw = await readBlob(captured!);
    expect(JSON.parse(raw)).toMatchObject({ format: "finanzblick-backup", version: 1, accountId: "own-account" });
    expect(parseFinanceBackup(raw, "own-account")).toEqual(appStateSchema.parse(finance.state));
    expect(loadServer).not.toHaveBeenCalled();
    expect(finance.replace).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:account-backup"), { timeout: 2000 });
  });

  it.each(["malformed", "duplicate IDs"])("downloads only the unvalidated own primary source after rejected %s hydration", async (kind) => {
    const original = fixture("Rejected own-cache original");
    if (kind === "duplicate IDs") original.transactions.push({ ...original.transactions[0] });
    const raw = kind === "malformed" ? "{unreadable original" : JSON.stringify({ state: original, revision: 1, pending: false }, null, 2);
    localStorage.setItem(accountStorageKey("own-account"), raw);
    localStorage.setItem(accountStorageKey("another-account"), "other private original");
    finance.state = createEmptyAccountState();
    finance.storageError = "Die lokale Kontosicherung ist ungültig und bleibt unverändert.";
    let captured!: Blob;
    let filename = "";
    vi.stubGlobal("URL", { createObjectURL: vi.fn((blob: Blob) => { captured = blob; return "blob:rejected-original"; }), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { filename = this.download; });
    mount(<AccountSyncTools />, workspace("user"));
    const button = screen.getByRole("button", { name: "Ungeprüftes Geräte-Original herunterladen" });
    expect(screen.getByText(/kein wiederherstellbarer JSON-Kontostand/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Gerätestand sichern" })).toBeNull();
    fireEvent.click(button);
    expect(await readBlob(captured)).toBe(raw);
    expect(filename).toBe("Finanzblick_Geraet_Original_ungeprueft.json");
    expect(localStorage.getItem(accountStorageKey("own-account"))).toBe(raw);
    expect(localStorage.getItem(accountStorageKey("another-account"))).toBe("other private original");
    expect(restoreMock).not.toHaveBeenCalled();
    expect(finance.replace).not.toHaveBeenCalled();
    expect(loadServer).not.toHaveBeenCalled();
  });

  it("routes a rejected own primary through source export and confirmed server replacement without losing its original", async () => {
    const raw = "{preserved rejected primary";
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, raw);
    const remote = fixture("Server after rejected primary");
    fetchMock.mockImplementation(async () => Response.json({ state: remote, revision: 4 }));
    const controller = new AccountFinanceStorage("own-account", vi.fn(), vi.fn());
    await expect(controller.load()).rejects.toThrow(/unlesbar/);
    finance.state = createEmptyAccountState();
    finance.storageError = "Die lokale Kontosicherung ist unlesbar und bleibt unverändert.";
    let captured!: Blob;
    vi.stubGlobal("URL", { createObjectURL: vi.fn((blob: Blob) => { captured = blob; return "blob:original"; }), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mount(<AccountSyncTools />, { ...workspace("user"), loadServer: async () => { finance.replace(await controller.useServer()); } });
    fireEvent.click(screen.getByRole("button", { name: "Ungeprüftes Geräte-Original herunterladen" }));
    expect(await readBlob(captured)).toBe(raw);
    expect(localStorage.getItem(key)).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Übernahme bestätigen" }));
    await waitFor(() => expect(finance.replace).toHaveBeenCalledWith(appStateSchema.parse(remote)));
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(raw);
    expect(JSON.parse(localStorage.getItem(key)!).state).toEqual(remote);
    expect(restoreMock).not.toHaveBeenCalled();
  });

  it("requires a separate confirmation before choosing the server snapshot and allows cancellation", () => {
    finance.storageError = "Synchronisierungskonflikt";
    mount(<AccountSyncTools />, workspace("user"));
    expect(screen.getByText(/Vor dem Laden neuerer Serverdaten bitte eine Sicherung herunterladen/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    expect(screen.getByText(/Ungesicherte Änderungen werden zusätzlich lokal als Konfliktsicherung aufbewahrt/)).toBeTruthy();
    expect(loadServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(loadServer).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Übernahme bestätigen" })).toBeNull();
  });

  it("rejects a changed account stand between server preview and confirmation", async () => {
    finance.storageError = "Synchronisierungskonflikt";
    const view = mount(<AccountSyncTools />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    finance.state = fixture("New edit after preview");
    view.rerender(<AccountWorkspaceContext value={workspace("user")}><AccountSyncTools /></AccountWorkspaceContext>);
    fireEvent.click(screen.getByRole("button", { name: "Übernahme bestätigen" }));
    expect((await screen.findByRole("alert")).textContent).toContain("zwischenzeitlich geändert");
    expect(loadServer).not.toHaveBeenCalled();
  });

  it("accepts an identically rehydrated device stand instead of blocking recovery on object identity", async () => {
    finance.storageError = "Synchronisierungskonflikt";
    const view = mount(<AccountSyncTools />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    finance.state = structuredClone(finance.state);
    view.rerender(<AccountWorkspaceContext value={workspace("user")}><AccountSyncTools /></AccountWorkspaceContext>);
    fireEvent.click(screen.getByRole("button", { name: "Übernahme bestätigen" }));
    await waitFor(() => expect(loadServer).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers a separately confirmed data-preserving reconciliation rather than replacing the device stand", async () => {
    finance.storageError = "Synchronisierungskonflikt";
    const reconcileServer = vi.fn().mockResolvedValue(undefined);
    mount(<AccountSyncTools />, { ...workspace("user"), reconcileServer });
    fireEvent.click(screen.getByRole("button", { name: "Datenstände abgleichen" }));
    expect(screen.getByText(/ohne Löschen zusammenführen/)).toBeTruthy();
    expect(reconcileServer).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Abgleich bestätigen" }));
    await waitFor(() => expect(reconcileServer).toHaveBeenCalledOnce());
    expect(loadServer).not.toHaveBeenCalled();
  });

  it("disables server confirmation and cancellation during the request, avoiding duplicate loads", async () => {
    finance.storageError = "Synchronisierungskonflikt";
    let finish!: () => void;
    loadServer.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    mount(<AccountSyncTools />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    const confirm = screen.getByRole("button", { name: "Übernahme bestätigen" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(loadServer).toHaveBeenCalledOnce();
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Abbrechen" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    expect(screen.queryByRole("button", { name: "Übernahme bestätigen" })).toBeNull();
  });

  it("preserves pending account changes as a conflict backup when the confirmed server choice succeeds", async () => {
    const local = fixture("Ungesicherte Gerätebuchung");
    const remote = fixture("Neuere Serverbuchung");
    const key = accountStorageKey("own-account");
    const original = JSON.stringify({ state: local, revision: 1, pending: true });
    localStorage.setItem(key, original);
    fetchMock.mockImplementation(async () => Response.json({ state: remote, revision: 2 }));
    const controller = new AccountFinanceStorage("own-account", vi.fn(), vi.fn());
    await controller.load();
    finance.state = local;
    finance.storageError = controller.error?.message ?? null;
    const restore = vi.fn(async () => { finance.replace(await controller.useServer()); });
    mount(<AccountSyncTools />, { ...workspace("user"), loadServer: restore });
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    expect(localStorage.getItem(`${key}.conflict-backup`)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Übernahme bestätigen" }));
    await waitFor(() => expect(finance.replace).toHaveBeenCalledWith(appStateSchema.parse(remote)));
    expect(JSON.parse(localStorage.getItem(`${key}.conflict-backup`)!)).toEqual(JSON.parse(original));
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual({ state: appStateSchema.parse(remote), revision: 2, pending: false });
    expect(fetchMock).toHaveBeenLastCalledWith("/api/finance", expect.objectContaining({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
      headers: { "X-Finanzblick-Account": "own-account" },
    }));
  });

  it("surfaces actual server-choice network failures and keeps the pending snapshot unchanged", async () => {
    const key = accountStorageKey("own-account");
    const original = JSON.stringify({ state: finance.state, revision: 1, pending: true });
    localStorage.setItem(key, original);
    fetchMock.mockResolvedValueOnce(Response.json({ state: fixture("Serverbuchung"), revision: 2 }))
      .mockRejectedValueOnce(new TypeError("Network unavailable"));
    const controller = new AccountFinanceStorage("own-account", vi.fn(), vi.fn());
    await controller.load();
    finance.storageError = controller.error?.message ?? null;
    mount(<AccountSyncTools />, {
      ...workspace("user"),
      loadServer: async () => { await controller.useServer(); },
    });
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    fireEvent.click(screen.getByRole("button", { name: "Übernahme bestätigen" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Server nicht erreichbar.");
    expect(localStorage.getItem(key)).toBe(original);
    expect(localStorage.getItem(`${key}.conflict-backup`)).toBeNull();
    expect((screen.getByRole("button", { name: "Übernahme bestätigen" }) as HTMLButtonElement).disabled).toBe(false);
    expect(finance.replace).not.toHaveBeenCalled();
  });

  it("surfaces browser-storage failures while preserving the confirmation for retry", async () => {
    finance.storageError = "Synchronisierungskonflikt";
    loadServer.mockRejectedValue(new DOMException("Storage full", "QuotaExceededError"));
    mount(<AccountSyncTools />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Serverstand laden" }));
    fireEvent.click(screen.getByRole("button", { name: "Übernahme bestätigen" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Browserspeicher voll oder gesperrt.");
    expect((screen.getByRole("button", { name: "Übernahme bestätigen" }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe("account conflict restoration", () => {
  function seedConflict(state = fixture("Original conflict"), id = "own-account") {
    const raw = JSON.stringify({ state, revision: 1, pending: true });
    localStorage.setItem(accountConflictKey(id), raw);
    return raw;
  }
  function openRecovery() {
    mount(<AccountSyncTools />, workspace("user"));
    fireEvent.click(screen.getByText("Lokale Konfliktsicherung", { exact: true }));
  }
  function reviewRestore() {
    fireEvent.click(screen.getByRole("button", { name: "Konfliktsicherung wiederherstellen" }));
  }
  it("offers recovery with no sync/legacy error and previews complete replacement without writing", () => {
    const raw = seedConflict();
    openRecovery();
    expect(screen.getByText(/1 Buchungen/)).toBeTruthy();
    expect(screen.getByText(/Einstellungen, Salden/)).toBeTruthy();
    reviewRestore();
    expect(screen.getByText(/gesamten aktuellen Kontostand/)).toBeTruthy();
    expect(restoreMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(restoreMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(raw);
  });
  it("exports the preserved conflict, not current state, in a parseable identity-bound envelope", async () => {
    const original = fixture("Original conflict");
    const raw = seedConflict(original);
    let captured!: Blob;
    vi.stubGlobal("URL", { createObjectURL: vi.fn((blob: Blob) => { captured = blob; return "blob:conflict"; }), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    openRecovery();
    fireEvent.click(screen.getByRole("button", { name: "Konfliktsicherung herunterladen" }));
    const exported = await readBlob(captured);
    expect(parseFinanceBackup(exported, "own-account")).toEqual(appStateSchema.parse(original));
    expect(parseFinanceBackup(exported, "own-account")).not.toEqual(finance.state);
    expect(() => parseFinanceBackup(exported, "other-account")).toThrow(/anderen Konto/);
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(raw);
  });
  it("restores valid legacy raw state only after confirmation and keeps its copy until persistence resolves", async () => {
    const original = fixture("Legacy conflict");
    const raw = JSON.stringify(original);
    localStorage.setItem(accountConflictKey("own-account"), raw);
    let finish!: () => void;
    restoreMock.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    openRecovery();
    reviewRestore();
    const expected = finance.state;
    fireEvent.click(screen.getByRole("button", { name: "Wiederherstellung bestätigen" }));
    expect(restoreMock).toHaveBeenCalledExactlyOnceWith(appStateSchema.parse(original), expected);
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(raw);
    expect((screen.getByRole("button", { name: "Abbrechen" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => finish());
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBeNull();
    expect(finance.replace).not.toHaveBeenCalled();
  });
  it.each(["Server nicht erreichbar", "Browserspeicher voll oder gesperrt", "Finanzstand wurde zwischenzeitlich geändert"])(
    "keeps the exact backup when restoration fails: %s", async (message) => {
      const raw = seedConflict();
      restoreMock.mockRejectedValue(new FinanceStorageError(message));
      openRecovery();
      reviewRestore();
      fireEvent.click(screen.getByRole("button", { name: "Wiederherstellung bestätigen" }));
      expect((await screen.findByRole("alert")).textContent).toContain(message);
      expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(raw);
    },
  );
  it("rejects a stale reviewed backup before restoring or explicitly discarding", async () => {
    seedConflict();
    openRecovery();
    reviewRestore();
    const newer = seedConflict(fixture("Changed elsewhere"));
    fireEvent.click(screen.getByRole("button", { name: "Wiederherstellung bestätigen" }));
    expect((await screen.findByRole("alert")).textContent).toContain("zwischenzeitlich geändert");
    expect(restoreMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(newer);
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    act(() => window.dispatchEvent(new Event("storage")));
    fireEvent.click(screen.getByRole("button", { name: "Konfliktsicherung verwerfen" }));
    const latest = seedConflict(fixture("Changed again"));
    fireEvent.click(screen.getByRole("button", { name: "Verwerfen bestätigen" }));
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(latest);
  });
  it("does not delete a newer backup that appeared while restoration was being saved", async () => {
    seedConflict();
    let finish!: () => void;
    restoreMock.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    openRecovery();
    reviewRestore();
    fireEvent.click(screen.getByRole("button", { name: "Wiederherstellung bestätigen" }));
    const newer = seedConflict(fixture("Newer pending recovery"));
    await act(async () => finish());
    expect(screen.getByRole("alert").textContent).toContain("zwischenzeitlich geändert");
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(newer);
  });
  it("shows malformed copies, exports the exact original, and requires informed explicit discard", async () => {
    const raw = "{unreadable preserved source";
    localStorage.setItem(accountConflictKey("own-account"), raw);
    let captured!: Blob;
    vi.stubGlobal("URL", { createObjectURL: vi.fn((blob: Blob) => { captured = blob; return "blob:raw"; }), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    openRecovery();
    expect(screen.getByRole("alert").textContent).toContain("unlesbar");
    expect(screen.queryByRole("button", { name: "Konfliktsicherung wiederherstellen" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Ungeprüftes Original herunterladen" }));
    expect(await readBlob(captured)).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Konfliktsicherung verwerfen" }));
    expect(screen.getByText(/unwiderruflich löschen/)).toBeTruthy();
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Verwerfen bestätigen" }));
    await waitFor(() => expect(localStorage.getItem(accountConflictKey("own-account"))).toBeNull());
    expect(restoreMock).not.toHaveBeenCalled();
  });
  it("does not inspect or expose another account's conflict copy", () => {
    const raw = seedConflict(fixture("Other account secret"), "other-account");
    const read = vi.spyOn(Storage.prototype, "getItem");
    mount(<AccountSyncTools />, workspace("user"));
    expect(screen.queryByText("Lokale Konfliktsicherung", { exact: true })).toBeNull();
    expect(read).not.toHaveBeenCalledWith(accountConflictKey("other-account"));
    expect(localStorage.getItem(accountConflictKey("other-account"))).toBe(raw);
  });
  it("surfaces inaccessible conflict storage even without sync or legacy errors", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    openRecovery();
    expect(screen.getByRole("alert").textContent).toContain("Konfliktsicherung ist nicht erreichbar");
    expect(screen.queryByRole("button", { name: "Konfliktsicherung verwerfen" })).toBeNull();
    expect(restoreMock).not.toHaveBeenCalled();
  });
  it("retains the copy and reports blocked storage when explicit discard fails", async () => {
    const raw = seedConflict();
    openRecovery();
    fireEvent.click(screen.getByRole("button", { name: "Konfliktsicherung verwerfen" }));
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    fireEvent.click(screen.getByRole("button", { name: "Verwerfen bestätigen" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Browserspeicher voll oder gesperrt");
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(raw);
  });
  it("clears a prior account's confirmation on an account switch", () => {
    const raw = seedConflict();
    seedConflict(fixture("Second account copy"), "second-account");
    const view = mount(<AccountSyncTools />, workspace("user"));
    fireEvent.click(screen.getByText("Lokale Konfliktsicherung", { exact: true }));
    reviewRestore();
    view.rerender(<AccountWorkspaceContext value={{ ...workspace("user"), user: { ...workspace("user").user, id: "second-account" } }}><AccountSyncTools /></AccountWorkspaceContext>);
    expect(screen.queryByRole("button", { name: "Wiederherstellung bestätigen" })).toBeNull();
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(raw);
    expect(restoreMock).not.toHaveBeenCalled();
  });
  it("keeps the original conflict if the account switches while restoration persistence is pending", async () => {
    const raw = seedConflict();
    const otherRaw = seedConflict(fixture("Other account recovery"), "other-account");
    let finish!: () => void;
    restoreMock.mockReturnValue(new Promise<void>((resolve) => { finish = resolve; }));
    const view = mount(<AccountSyncTools />, workspace("user"));
    fireEvent.click(screen.getByText("Lokale Konfliktsicherung", { exact: true }));
    reviewRestore();
    fireEvent.click(screen.getByRole("button", { name: "Wiederherstellung bestätigen" }));
    view.rerender(<AccountWorkspaceContext value={{ ...workspace("user"), user: { ...workspace("user").user, id: "other-account" } }}><AccountSyncTools /></AccountWorkspaceContext>);
    await act(async () => finish());
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(raw);
    expect(localStorage.getItem(accountConflictKey("other-account"))).toBe(otherRaw);
    expect(restoreMock).toHaveBeenCalledOnce();
  });
});

describe("AccountLogout", () => {
  function confirmDiscard() {
    fireEvent.click(screen.getByRole("checkbox", { name: /bewusst ohne Sicherung verwerfen/ }));
    fireEvent.click(screen.getByRole("button", { name: "Ohne Sicherung abmelden" }));
  }
  it.each(["Abbrechen", "Escape"])("cancels logout with %s without requests or storage changes", (action) => {
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, "own cached state");
    localStorage.setItem(accountConflictKey("own-account"), "own preserved conflict");
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    if (action === "Escape") fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    else fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe("own cached state");
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe("own preserved conflict");
  });
  it("offers downloads of both current state and preserved conflict before deleting local copies", async () => {
    const conflictState = fixture("Preserved conflict");
    const raw = JSON.stringify({ state: conflictState, revision: 1, pending: true });
    localStorage.setItem(accountConflictKey("own-account"), raw);
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:logout"; }), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    expect(blobs).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Konfliktsicherung herunterladen" }));
    expect(blobs).toHaveLength(2);
    expect(parseFinanceBackup(await readBlob(blobs[0]), "own-account")).toEqual(finance.state);
    expect(parseFinanceBackup(await readBlob(blobs[1]), "own-account")).toEqual(conflictState);
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe(raw);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Gesichert abmelden" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBeNull();
  });
  it("requires the closed failed-sync tab's newer cache separately from the older saved tab's memory", async () => {
    const older = fixture("Tab A saved memory");
    const newer = fixture("Tab B pending after failed sync");
    const key = accountStorageKey("own-account");
    fetchMock.mockImplementation(async (_url, options) => {
      if (options?.method === "PUT") throw new TypeError("synthetic offline tab");
      return Response.json({ state: older, revision: 2 });
    });
    const tabA = new AccountFinanceStorage("own-account", vi.fn(), vi.fn());
    const failed = vi.fn();
    const tabB = new AccountFinanceStorage("own-account", vi.fn(), failed);
    await tabA.load();
    await tabB.load();
    tabB.save(newer);
    await waitFor(() => expect(failed).toHaveBeenCalledOnce());
    tabB.dispose();
    const raw = localStorage.getItem(key);
    finance.state = older;
    finance.saved = true;
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    const blobs: Blob[] = [];
    vi.stubGlobal("URL", { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:separate"; }), revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    fireEvent.click(screen.getByRole("button", { name: /Kontostand.*herunterladen/ }));
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    expect(blobs).toHaveLength(1);
    expect(parseFinanceBackup(await readBlob(blobs[0]), "own-account")).toEqual(older);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(raw);
    fireEvent.click(screen.getByRole("button", { name: "Lokalen Kontocache herunterladen" }));
    expect(blobs).toHaveLength(2);
    expect(click).toHaveBeenCalledTimes(2);
    expect(parseFinanceBackup(await readBlob(blobs[1]), "own-account")).toEqual(newer);
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Gesichert abmelden" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(localStorage.getItem(key)).toBeNull();
    tabA.dispose();
  });
  function captureDownloads() {
    const blobs: Blob[] = [];
    const filenames: string[] = [];
    vi.stubGlobal("URL", { createObjectURL: vi.fn((blob: Blob) => { blobs.push(blob); return "blob:logout"; }), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) { filenames.push(this.download); });
    return { blobs, filenames };
  }
  it.each(["pending same state", "different nonpending state"])("requires a separate cache download for %s", async (kind) => {
    const cacheState = kind === "pending same state" ? finance.state : fixture("Other tab saved cache");
    const raw = JSON.stringify({ state: cacheState, revision: 3, pending: kind === "pending same state" });
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, raw);
    const { blobs } = captureDownloads();
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(screen.getByText(/Sicherung des angezeigten Kontostands enthält diesen Cache nicht/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    fireEvent.click(screen.getByRole("button", { name: "Gesichert abmelden" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Lokalen Kontocache herunterladen" }));
    expect(blobs).toHaveLength(2);
    const exported = await readBlob(blobs[1]);
    expect(parseFinanceBackup(exported, "own-account")).toEqual(appStateSchema.parse(cacheState));
    expect(() => parseFinanceBackup(exported, "another-account")).toThrow(/anderen Konto/);
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(false);
    expect(localStorage.getItem(key)).toBe(raw);
  });
  it("does not require an additional cache download for the exact synchronized displayed state", async () => {
    localStorage.setItem(accountStorageKey("own-account"), JSON.stringify({ state: finance.state, revision: 3, pending: false }));
    const { blobs } = captureDownloads();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    expect(blobs).toHaveLength(1);
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Gesichert abmelden" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
  });
  it.each(["malformed", "duplicate IDs"])("requires and exports the exact unvalidated %s cache original, never an empty replacement", async (kind) => {
    const rejected = fixture("Rejected own original");
    if (kind === "duplicate IDs") rejected.transactions.push({ ...rejected.transactions[0] });
    const raw = kind === "malformed" ? "{unreadable newer cache" : JSON.stringify({ state: rejected, revision: 3, pending: true }, null, 2);
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, raw);
    localStorage.setItem(accountStorageKey("another-account"), "other private cache");
    finance.state = createEmptyAccountState();
    const { blobs, filenames } = captureDownloads();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(screen.getByText(/keinen wiederherstellbaren JSON-Kontostand/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Ungeprüftes Cache-Original herunterladen" }));
    expect(blobs).toHaveLength(2);
    expect(await readBlob(blobs[1])).toBe(raw);
    expect(filenames[1]).toBe("Finanzblick_Cache_Original_ungeprueft.json");
    expect(localStorage.getItem(key)).toBe(raw);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Gesichert abmelden" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(accountStorageKey("another-account"))).toBe("other private cache");
  });
  it.each([
    ["Aktuellen Kontostand herunterladen", "Lokalen Kontocache herunterladen", "Konfliktsicherung herunterladen"],
    ["Konfliktsicherung herunterladen", "Lokalen Kontocache herunterladen", "Aktuellen Kontostand herunterladen"],
  ])("downloads one file per action and waits for every distinct required source: %s first", (first, second, third) => {
    localStorage.setItem(accountStorageKey("own-account"), JSON.stringify({ state: fixture("Pending cache"), revision: 1, pending: true }));
    localStorage.setItem(accountConflictKey("own-account"), "{malformed preserved conflict");
    const { blobs, filenames } = captureDownloads();
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    for (const [index, name] of [first, second, third].entries()) {
      fireEvent.click(screen.getByRole("button", { name }));
      expect(blobs).toHaveLength(index + 1);
      expect(filenames).toHaveLength(index + 1);
      expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(index !== 2);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("retains informed discard without downloads for pending cache and malformed conflict", async () => {
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, JSON.stringify({ state: fixture("Pending cache"), revision: 1, pending: true }));
    localStorage.setItem(accountConflictKey("own-account"), "{malformed preserved conflict");
    const { blobs } = captureDownloads();
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    confirmDiscard();
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login"));
    expect(blobs).toHaveLength(0);
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBeNull();
  });
  it("does not mark a failed cache download as secured", () => {
    localStorage.setItem(accountStorageKey("own-account"), "{malformed primary");
    captureDownloads();
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { throw new DOMException("Download blocked", "SecurityError"); });
    fireEvent.click(screen.getByRole("button", { name: "Ungeprüftes Cache-Original herunterladen" }));
    expect(screen.getByRole("alert").textContent).toContain("Browserspeicher voll oder gesperrt");
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("never substitutes repeated memory downloads for required cache and resets approvals on a fresh review", () => {
    localStorage.setItem(accountStorageKey("own-account"), JSON.stringify({ state: fixture("Pending cache"), revision: 1, pending: true }));
    captureDownloads();
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Lokalen Kontocache herunterladen" }));
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it.each(["before download", "after download"])("rejects a cache raw change %s before logout POST", async (when) => {
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, JSON.stringify({ state: finance.state, revision: 1, pending: false }));
    const { blobs } = captureDownloads();
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    if (when === "after download") fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    const newer = JSON.stringify({ state: fixture("New unreviewed tab cache"), revision: 2, pending: true });
    localStorage.setItem(key, newer);
    if (when === "before download") fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    else fireEvent.click(screen.getByRole("button", { name: "Gesichert abmelden" }));
    expect((await screen.findByRole("alert")).textContent).toContain("zwischenzeitlich geändert");
    expect(blobs).toHaveLength(when === "before download" ? 0 : 1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(newer);
  });
  it("rechecks exact raw after a download before marking that source as secured", () => {
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, JSON.stringify({ state: finance.state, revision: 1, pending: false }));
    captureDownloads();
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { localStorage.setItem(key, "new unreviewed original"); });
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    expect(screen.getByRole("alert").textContent).toContain("zwischenzeitlich geändert");
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem(key)).toBe("new unreviewed original");
  });
  it.each(["cache", "unsaved memory", "saved memory", "account"])("preserves both reviewed sources if %s changes during logout POST", async (target) => {
    const key = accountStorageKey("own-account");
    const raw = JSON.stringify({ state: finance.state, revision: 1, pending: false });
    localStorage.setItem(key, raw);
    localStorage.setItem(accountConflictKey("own-account"), "reviewed conflict");
    localStorage.setItem(accountStorageKey("another-account"), "other private cache");
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    const view = mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    confirmDiscard();
    if (target === "cache") localStorage.setItem(key, "new unreviewed cache");
    if (target === "unsaved memory") {
      finance.saved = false;
      view.rerender(<AccountWorkspaceContext value={workspace("user")}><AccountLogout /></AccountWorkspaceContext>);
    }
    if (target === "saved memory") {
      finance.state = fixture("Changed already-saved memory");
      view.rerender(<AccountWorkspaceContext value={workspace("user")}><AccountLogout /></AccountWorkspaceContext>);
    }
    if (target === "account") {
      view.rerender(<AccountWorkspaceContext value={{ ...workspace("user"), user: { ...workspace("user").user, id: "another-account" } }}><AccountLogout /></AccountWorkspaceContext>);
    }
    await act(async () => finish(Response.json({ ok: true })));
    expect(assign).toHaveBeenCalledWith("/login?cache=unavailable");
    expect(localStorage.getItem(key)).toBe(target === "cache" ? "new unreviewed cache" : raw);
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe("reviewed conflict");
    expect(localStorage.getItem(accountStorageKey("another-account"))).toBe("other private cache");
  });
  it("rejects a stale logout review before POST and leaves the changed copy intact", async () => {
    const key = accountConflictKey("own-account");
    localStorage.setItem(key, "reviewed copy");
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    localStorage.setItem(key, "new unreviewed copy");
    confirmDiscard();
    expect((await screen.findByRole("alert")).textContent).toContain("zwischenzeitlich geändert");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe("new unreviewed copy");
  });
  it("keeps logout guarded if unsaved edits arise after opening its confirmation", () => {
    const view = mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    finance.saved = false;
    finance.state = fixture("Unsaved edit");
    view.rerender(<AccountWorkspaceContext value={workspace("user")}><AccountLogout /></AccountWorkspaceContext>);
    confirmDiscard();
    expect((screen.getByRole("button", { name: "Ohne Sicherung abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
  it("requires informed discard if backup storage is inaccessible and preserves unreviewed data", async () => {
    const key = accountConflictKey("own-account");
    localStorage.setItem(key, "preserved inaccessible copy");
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(screen.getByRole("alert").textContent).toContain("nicht erreichbar");
    expect((screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }) as HTMLButtonElement).disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    confirmDiscard();
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login?cache=unavailable"));
    read.mockRestore();
    expect(localStorage.getItem(key)).toBe("preserved inaccessible copy");
  });
  it("exports valid RAM despite a storage SecurityError without clearing its privacy warning or approving unknown backups", async () => {
    const key = accountStorageKey("own-account");
    const raw = JSON.stringify({ state: fixture("Unknown newer local cache"), revision: 2, pending: true });
    localStorage.setItem(key, raw);
    localStorage.setItem(accountConflictKey("own-account"), "unknown conflict original");
    localStorage.setItem(accountStorageKey("another-account"), "other private cache");
    const { blobs, filenames } = captureDownloads();
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    expect(blobs).toHaveLength(0);
    expect(screen.getByRole("alert").textContent).toContain("nicht erreichbar");
    const readsBeforeDownload = read.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    expect(blobs).toHaveLength(1);
    expect(filenames).toEqual([`Finanzblick_my.account_${finance.state.settings.asOf}.json`]);
    expect(parseFinanceBackup(await readBlob(blobs[0]), "own-account")).toEqual(appStateSchema.parse(finance.state));
    expect(read).toHaveBeenCalledTimes(readsBeforeDownload);
    expect(screen.getByRole("alert").textContent).toContain("auf diesem Gerät erhalten");
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Gesichert abmelden" }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    read.mockRestore();
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    confirmDiscard();
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/login?cache=unavailable"));
    expect(remove).not.toHaveBeenCalled();
    expect(localStorage.getItem(key)).toBe(raw);
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe("unknown conflict original");
    expect(localStorage.getItem(accountStorageKey("another-account"))).toBe("other private cache");
  });
  it("requires a fresh readable review and all required downloads after storage access returns", () => {
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, JSON.stringify({ state: fixture("Newer pending cache"), revision: 2, pending: true }));
    localStorage.setItem(accountConflictKey("own-account"), "preserved conflict original");
    const { blobs } = captureDownloads();
    const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("blocked", "SecurityError"); });
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    expect(blobs).toHaveLength(1);
    read.mockRestore();
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    fireEvent.click(screen.getByRole("button", { name: "Lokalen Kontocache herunterladen" }));
    fireEvent.click(screen.getByRole("button", { name: "Konfliktsicherung herunterladen" }));
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Aktuellen Kontostand herunterladen" }));
    expect(blobs).toHaveLength(4);
    expect((screen.getByRole("button", { name: "Gesichert abmelden" }) as HTMLButtonElement).disabled).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
  it("keeps copies changed during logout and still clears signed-out in-memory data", async () => {
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, "reviewed cache");
    localStorage.setItem(accountConflictKey("own-account"), "reviewed conflict");
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    confirmDiscard();
    localStorage.setItem(accountConflictKey("own-account"), "new unreviewed conflict");
    await act(async () => finish(Response.json({ ok: true })));
    expect(assign).toHaveBeenCalledWith("/login?cache=unavailable");
    expect(localStorage.getItem(accountConflictKey("own-account"))).toBe("new unreviewed conflict");
    expect(localStorage.getItem(key)).toBe("reviewed cache");
  });
  it("blocks logout while changes are not yet synchronized", () => {
    finance.saved = false;
    mount(<AccountLogout />, workspace("user"));
    const button = screen.getByRole("button", { name: "Abmelden" });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(button.getAttribute("title")).toBe("Bitte zuerst Änderungen synchronisieren.");
    fireEvent.click(button);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("POSTs same-origin logout and clears only this account's cache and conflict backup before navigating", async () => {
    const key = accountStorageKey("own-account");
    const otherKey = accountStorageKey("another-account");
    localStorage.setItem(key, "own cached state");
    localStorage.setItem(`${key}.conflict-backup`, "own conflict backup");
    localStorage.setItem(otherKey, "another account's cached state");
    localStorage.setItem(`${otherKey}.conflict-backup`, "another account's conflict backup");
    const legacy = seedLegacy();
    localStorage.setItem(legacyNoticeKey("own-account"), "seen");
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    confirmDiscard();
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/login"));
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/auth/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(remove.mock.calls).toEqual([[key], [`${key}.conflict-backup`]]);
    expect(localStorage.getItem(key)).toBeNull();
    expect(localStorage.getItem(`${key}.conflict-backup`)).toBeNull();
    expect(localStorage.getItem(otherKey)).toBe("another account's cached state");
    expect(localStorage.getItem(`${otherKey}.conflict-backup`)).toBe("another account's conflict backup");
    expect(localStorage.getItem(FINANCE_STORAGE_KEY)).toBe(legacy);
    expect(localStorage.getItem(FINANCE_BACKUP_KEY)).toBe(legacy);
    expect(localStorage.getItem(legacyNoticeKey("own-account"))).toBe("seen");
    expect(remove.mock.invocationCallOrder[1]).toBeLessThan(assign.mock.invocationCallOrder[0]);
  });

  it("keeps logout disabled during the POST and does not clear account data before server confirmation", async () => {
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, "cached account state");
    let finish!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((resolve) => { finish = resolve; }));
    mount(<AccountLogout />, workspace("user"));
    const button = screen.getByRole("button", { name: "Abmelden" });
    fireEvent.click(button);
    confirmDiscard();
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(localStorage.getItem(key)).toBe("cached account state");
    expect(assign).not.toHaveBeenCalled();
    await act(async () => finish(Response.json({ ok: true })));
    expect(assign).toHaveBeenCalledExactlyOnceWith("/login");
  });

  it("surfaces logout network failures, preserves the account cache and permits retry", async () => {
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, "cached account state");
    fetchMock.mockRejectedValue(new TypeError("Network unavailable"));
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    confirmDiscard();
    expect((await screen.findByRole("alert")).textContent).toContain("Der Server ist nicht erreichbar. Du wurdest nicht abgemeldet.");
    expect(localStorage.getItem(key)).toBe("cached account state");
    expect(assign).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Ohne Sicherung abmelden" }) as HTMLButtonElement).disabled).toBe(false);
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    fireEvent.click(screen.getByRole("button", { name: "Ohne Sicherung abmelden" }));
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/login"));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("does not clear cache or navigate when the logout server rejects the request", async () => {
    const key = accountStorageKey("own-account");
    localStorage.setItem(key, "cached account state");
    fetchMock.mockResolvedValue(Response.json({ error: "internal details" }, { status: 503 }));
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    confirmDiscard();
    expect((await screen.findByRole("alert")).textContent).toContain("Abmelden ist derzeit nicht möglich.");
    expect(screen.getByRole("alert").textContent).not.toContain("internal details");
    expect(localStorage.getItem(key)).toBe("cached account state");
    expect(assign).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Ohne Sicherung abmelden" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("clears the signed-out in-memory page and reports a cache removal failure on login", async () => {
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    const otherKey = accountStorageKey("another-account");
    localStorage.setItem(otherKey, "another account's cached state");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("Storage blocked", "SecurityError");
    });
    mount(<AccountLogout />, workspace("user"));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
    confirmDiscard();
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/login?cache=unavailable"));
    expect(localStorage.getItem(otherKey)).toBe("another account's cached state");
  });
});

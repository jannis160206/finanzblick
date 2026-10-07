// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountWorkspaceContext, type AccountWorkspace } from "./account-context";
import { AccountLogout, AccountSyncTools } from "./account-tools";
import { AccountFinanceStorage, accountStorageKey } from "@/lib/account-finance-storage";
import { createEmptyAccountState } from "@/lib/account-state";
import { FINANCE_BACKUP_KEY, FINANCE_STORAGE_KEY } from "@/lib/finance-storage";
import { appStateSchema, type AppState } from "@/lib/types";
import { legacyNoticeKey } from "@/lib/legacy-account-notice";

const { useFinanceMock } = vi.hoisted(() => ({ useFinanceMock: vi.fn() }));
vi.mock("./finance-provider", () => ({ useFinance: useFinanceMock }));

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
    expect(screen.getByRole("alert").textContent).toContain("Bisherige Browserdaten sind nicht erreichbar.");
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
    expect(JSON.parse(await readBlob(captured!))).toEqual(appStateSchema.parse(finance.state));
    expect(loadServer).not.toHaveBeenCalled();
    expect(finance.replace).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:account-backup"), { timeout: 2000 });
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

describe("AccountLogout", () => {
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
    expect((await screen.findByRole("alert")).textContent).toContain("Der Server ist nicht erreichbar. Du wurdest nicht abgemeldet.");
    expect(localStorage.getItem(key)).toBe("cached account state");
    expect(assign).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Abmelden" }) as HTMLButtonElement).disabled).toBe(false);
    fetchMock.mockResolvedValue(Response.json({ ok: true }));
    fireEvent.click(screen.getByRole("button", { name: "Abmelden" }));
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
    expect((await screen.findByRole("alert")).textContent).toContain("Abmelden ist derzeit nicht möglich.");
    expect(screen.getByRole("alert").textContent).not.toContain("internal details");
    expect(localStorage.getItem(key)).toBe("cached account state");
    expect(assign).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Abmelden" }) as HTMLButtonElement).disabled).toBe(false);
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
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/login?cache=unavailable"));
    expect(localStorage.getItem(otherKey)).toBe("another account's cached state");
  });
});

// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let unsubscribe: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-security-mode");
});
afterEach(() => {
  unsubscribe?.();
  unsubscribe = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

async function store() {
  const security = await import("./security-mode");
  unsubscribe = security.subscribeSecurityMode(vi.fn());
  return security;
}

function fileInput() {
  const input = document.createElement("input");
  input.type = "file";
  document.body.append(input);
  return input;
}

describe("screen privacy preference", () => {
  it.each([
    [null, "open"],
    ["false", "open"],
    ["true", "locked"],
    ["damaged", "locked"],
  ])("bootstraps %s without a visible financial-data flash", async (value, expected) => {
    const security = await import("./security-mode");
    if (value !== null) localStorage.setItem(security.SECURITY_MODE_KEY, value);
    new Function("localStorage", "sessionStorage", "document", security.securityModeBootstrap)(localStorage, sessionStorage, document);
    expect(document.documentElement.dataset.securityMode).toBe(expected);
    unsubscribe = security.subscribeSecurityMode(vi.fn());
    expect(security.getSecuritySnapshot().locked).toBe(expected === "locked");
    expect(security.getSecuritySnapshot().ready).toBe(true);
    if (value === "damaged") expect(security.getSecuritySnapshot().error).toContain("ungültig");
  });

  it("persists independently of financial data and keeps server rendering locked", async () => {
    localStorage.setItem("finanzdashboard.v1", '{"unchanged":1250}');
    const security = await store();
    expect(security.getServerSecuritySnapshot()).toMatchObject({ locked: true, ready: false });
    security.toggleSecurityMode();
    expect(localStorage.getItem(security.SECURITY_MODE_KEY)).toBe("true");
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    security.toggleSecurityMode();
    expect(localStorage.getItem(security.SECURITY_MODE_KEY)).toBe("false");
    expect(security.getSecuritySnapshot().locked).toBe(false);
    expect(localStorage.getItem("finanzdashboard.v1")).toBe('{"unchanged":1250}');
  });

  it("synchronizes other tabs and bfcache restores", async () => {
    const security = await store();
    localStorage.setItem(security.SECURITY_MODE_KEY, "true");
    window.dispatchEvent(new StorageEvent("storage", { key: security.SECURITY_MODE_KEY }));
    expect(security.getSecuritySnapshot().locked).toBe(true);
    localStorage.setItem(security.SECURITY_MODE_KEY, "false");
    window.dispatchEvent(new Event("pageshow"));
    expect(security.getSecuritySnapshot().locked).toBe(false);
  });

  it("locks immediately on window blur and requires explicit unlocking after focus returns", async () => {
    const security = await store();
    window.dispatchEvent(new Event("blur"));
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    expect(localStorage.getItem(security.SECURITY_MODE_KEY)).toBe("true");
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBe("true");
    window.dispatchEvent(new Event("focus"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
    security.setSecurityMode(false);
    expect(security.getSecuritySnapshot().locked).toBe(false);
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBeNull();
  });

  it.each(["change", "cancel"])("does not lock when a native file dialog opens and closes with %s", async (event) => {
    vi.useFakeTimers();
    const security = await store();
    const input = fileInput();
    input.click();
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(false);
    expect(localStorage.getItem(security.SECURITY_MODE_KEY)).toBeNull();
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBeNull();
    vi.advanceTimersByTime(60_000);
    expect(security.getSecuritySnapshot().locked).toBe(false);
    input.dispatchEvent(new Event(event, { bubbles: true }));
    window.dispatchEvent(new Event("focus"));
    expect(security.getSecuritySnapshot().locked).toBe(false);
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
  });

  it.each(["change", "cancel", "focus"])("clears an unused file-dialog exception on %s", async (event) => {
    const security = await store();
    const input = fileInput();
    input.click();
    if (event === "focus") window.dispatchEvent(new Event(event));
    else input.dispatchEvent(new Event(event, { bubbles: true }));
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
  });

  it("exempts only one blur rather than suspending automatic locking", async () => {
    const security = await store();
    fileInput().click();
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(false);
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
  });

  it.each([false, true])("still locks a hidden tab with a pending or open file picker (blurred: %s)", async (blurred) => {
    const security = await store();
    const input = fileInput();
    input.click();
    if (blurred) window.dispatchEvent(new Event("blur"));
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
    visibility.mockReturnValue("visible");
    input.dispatchEvent(new Event("change", { bubbles: true }));
    window.dispatchEvent(new Event("focus"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBe("true");
  });

  it("expires the exception if a clicked file input does not open a native dialog", async () => {
    vi.useFakeTimers();
    const security = await store();
    fileInput().click();
    vi.advanceTimersByTime(1_001);
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
  });

  it("clears an unused exception when another page control is clicked", async () => {
    const security = await store();
    fileInput().click();
    document.body.click();
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
  });

  it.each(["prevented", "disabled", "removed", "not-file"])("does not exempt %s file-input activations", async (condition) => {
    const security = await store();
    const input = fileInput();
    if (condition === "prevented") input.addEventListener("click", (event) => event.preventDefault());
    if (condition === "disabled") input.disabled = true;
    if (condition === "not-file") input.type = "text";
    input.click();
    if (condition === "removed") input.remove();
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
  });

  it("never unlocks an existing manual or cross-tab lock when a file dialog closes", async () => {
    const security = await store();
    const input = fileInput();
    input.click();
    window.dispatchEvent(new Event("blur"));
    localStorage.setItem(security.SECURITY_MODE_KEY, "true");
    window.dispatchEvent(new StorageEvent("storage", { key: security.SECURITY_MODE_KEY }));
    input.dispatchEvent(new Event("cancel", { bubbles: true }));
    window.dispatchEvent(new Event("focus"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
    security.setSecurityMode(true);
    input.click();
    window.dispatchEvent(new Event("blur"));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    window.dispatchEvent(new Event("focus"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
  });

  it("clears pending file-dialog state when the final subscriber unmounts", async () => {
    const security = await store();
    const input = fileInput();
    input.click();
    unsubscribe?.();
    input.click();
    unsubscribe = security.subscribeSecurityMode(vi.fn());
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
  });

  it("locks on tab hiding, ignores another tab's unlock and preserves the local lock through reload", async () => {
    const security = await store();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
    localStorage.setItem(security.SECURITY_MODE_KEY, "false");
    window.dispatchEvent(new StorageEvent("storage", { key: security.SECURITY_MODE_KEY }));
    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    window.dispatchEvent(new Event("pageshow"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
    new Function("localStorage", "sessionStorage", "document", security.securityModeBootstrap)(localStorage, sessionStorage, document);
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    unsubscribe?.();
    vi.resetModules();
    const reloaded = await store();
    expect(reloaded.getSecuritySnapshot().locked).toBe(true);
    reloaded.setSecurityMode(false);
    expect(reloaded.getSecuritySnapshot()).toMatchObject({ locked: false, error: null });
  });

  it("protects a tab loaded in the background before hydration", async () => {
    const security = await import("./security-mode");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    localStorage.setItem(security.SECURITY_MODE_KEY, "false");
    new Function("localStorage", "sessionStorage", "document", security.securityModeBootstrap)(localStorage, sessionStorage, document);
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBe("true");
    unsubscribe = security.subscribeSecurityMode(vi.fn());
    expect(security.getSecuritySnapshot().locked).toBe(true);
  });

  it("does not lock for focus movement within the page and removes automatic listeners on unsubscribe", async () => {
    const security = await store();
    const input = document.createElement("input");
    document.body.append(input);
    input.dispatchEvent(new Event("blur"));
    input.remove();
    expect(security.getSecuritySnapshot().locked).toBe(false);
    unsubscribe?.();
    unsubscribe = undefined;
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(false);
  });

  it("fails closed if persisting an automatic lock fails", async () => {
    const security = await store();
    const original = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage && key === security.SECURITY_MODE_KEY) throw new DOMException("Full", "QuotaExceededError");
      original.call(this, key, value);
    });
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot()).toMatchObject({ locked: true, ready: true });
    expect(security.getSecuritySnapshot().error).toContain("nicht dauerhaft");
    expect(sessionStorage.getItem(security.SECURITY_FALLBACK_KEY)).toBe("true");
  });

  it("fails closed when storage cannot be read", async () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    const security = await store();
    expect(security.getSecuritySnapshot()).toMatchObject({ locked: true, ready: true });
    expect(security.getSecuritySnapshot().error).toContain("nicht geladen");
  });

  it("retains a reload-safe session lock when persistence fails and unlocks only after a successful write", async () => {
    const security = await store();
    const original = Storage.prototype.setItem;
    const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage && key === security.SECURITY_MODE_KEY) throw new DOMException("Full", "QuotaExceededError");
      original.call(this, key, value);
    });
    security.setSecurityMode(true);
    expect(sessionStorage.getItem(security.SECURITY_FALLBACK_KEY)).toBe("true");
    security.setSecurityMode(false);
    expect(security.getSecuritySnapshot().locked).toBe(true);
    expect(security.getSecuritySnapshot().error).toContain("nicht dauerhaft");
    new Function("localStorage", "sessionStorage", "document", security.securityModeBootstrap)(localStorage, sessionStorage, document);
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    window.dispatchEvent(new Event("focus"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
    fail.mockRestore();
    security.setSecurityMode(false);
    expect(security.getSecuritySnapshot()).toMatchObject({ locked: false, error: null });
    expect(sessionStorage.getItem(security.SECURITY_FALLBACK_KEY)).toBeNull();
  });
});

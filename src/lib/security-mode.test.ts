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
  vi.restoreAllMocks();
});

async function store() {
  const security = await import("./security-mode");
  unsubscribe = security.subscribeSecurityMode(vi.fn());
  return security;
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

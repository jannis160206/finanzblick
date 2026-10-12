// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let unsubscribe: (() => void) | undefined;
beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-security-mode");
  document.documentElement.removeAttribute("data-security-mode-error");
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

function bootstrap(security: typeof import("./security-mode")) {
  new Function("localStorage", "sessionStorage", "document", security.securityModeBootstrap)(localStorage, sessionStorage, document);
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

describe("security activation preferences", () => {
  it("migrates an absent activation preference to automatic without rewriting the legacy keys", async () => {
    const security = await store();
    expect(security.getSecuritySnapshot().preference).toBe("automatic");
    expect(localStorage.getItem(security.SECURITY_ACTIVATION_KEY)).toBeNull();
    expect(localStorage.getItem(security.SECURITY_MODE_KEY)).toBeNull();
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "automatic", locked: true, error: null });
    expect(localStorage.getItem(security.SECURITY_ACTIVATION_KEY)).toBeNull();
  });

  it.each(["manual", "off"] as const)("does not activate %s on blur, hidden load, focus or reload", async (preference) => {
    const security = await import("./security-mode");
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, preference);
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("open");
    unsubscribe = security.subscribeSecurityMode(vi.fn());
    window.dispatchEvent(new Event("blur"));
    document.dispatchEvent(new Event("visibilitychange"));
    expect(security.getSecuritySnapshot()).toMatchObject({ preference, locked: false, error: null });
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBeNull();
    visibility.mockReturnValue("visible");
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("pageshow"));
    expect(security.getSecuritySnapshot().locked).toBe(false);
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("open");
  });

  it("keeps a persisted manual mask in manual mode until an explicit unlock", async () => {
    const security = await store();
    security.setSecurityMode(true);
    security.setSecurityPreference("manual");
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "manual", locked: true });
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    window.dispatchEvent(new Event("blur"));
    security.setSecurityMode(false);
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "manual", locked: false });
  });

  it("keeps an automatic lock when switching to manual, but removes automatic activation", async () => {
    const security = await store();
    window.dispatchEvent(new Event("blur"));
    security.setSecurityPreference("manual");
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBeNull();
    expect(localStorage.getItem(security.SECURITY_MODE_KEY)).toBe("true");
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "manual", locked: true });
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    security.toggleSecurityMode();
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(false);
  });

  it("clears every lock when off is explicitly persisted, and disallows manual header toggles", async () => {
    const security = await store();
    window.dispatchEvent(new Event("blur"));
    sessionStorage.setItem(security.SECURITY_FALLBACK_KEY, "true");
    security.setSecurityPreference("off");
    expect(localStorage.getItem(security.SECURITY_ACTIVATION_KEY)).toBe("off");
    expect(localStorage.getItem(security.SECURITY_MODE_KEY)).toBe("false");
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBeNull();
    expect(sessionStorage.getItem(security.SECURITY_FALLBACK_KEY)).toBeNull();
    security.toggleSecurityMode();
    security.setSecurityMode(true);
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "off", locked: false, error: null });
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("open");
  });

  it("re-enables automatic activation immediately when the current document is hidden", async () => {
    const security = await store();
    security.setSecurityPreference("manual");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    security.setSecurityPreference("automatic");
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "automatic", locked: true });
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBe("true");
  });

  it("synchronizes preferences across tabs, retaining sticky locks except for off", async () => {
    const security = await store();
    window.dispatchEvent(new Event("blur"));
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "manual");
    localStorage.setItem(security.SECURITY_MODE_KEY, "false");
    window.dispatchEvent(new StorageEvent("storage", { key: security.SECURITY_ACTIVATION_KEY }));
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "manual", locked: true });
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "off");
    window.dispatchEvent(new StorageEvent("storage", { key: security.SECURITY_ACTIVATION_KEY }));
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "off", locked: false });
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBeNull();
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "automatic");
    window.dispatchEvent(new StorageEvent("storage", { key: null }));
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "automatic", locked: true });
  });

  it("activates automatic protection if an external preference change arrives while hidden", async () => {
    const security = await store();
    security.setSecurityPreference("manual");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    localStorage.removeItem(security.SECURITY_ACTIVATION_KEY);
    window.dispatchEvent(new StorageEvent("storage", { key: security.SECURITY_ACTIVATION_KEY }));
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "automatic", locked: true });
  });

  it("checks the current preference on leave even before the storage event is delivered", async () => {
    const security = await store();
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "manual");
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "manual", locked: false });
  });

  it.each(["visible", "hidden"] as const)("ignores stale manual/automatic locks for off during %s bootstrap and hydration", async (visibility) => {
    const security = await import("./security-mode");
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "off");
    localStorage.setItem(security.SECURITY_MODE_KEY, "true");
    sessionStorage.setItem(security.SECURITY_AUTO_LOCK_KEY, "true");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue(visibility);
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("open");
    unsubscribe = security.subscribeSecurityMode(vi.fn());
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "off", locked: false, error: null });
    expect(localStorage.getItem(security.SECURITY_MODE_KEY)).toBe("false");
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBeNull();
  });

  it("does not ignore a failed-write fallback even when the preference is off", async () => {
    const security = await import("./security-mode");
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "off");
    sessionStorage.setItem(security.SECURITY_FALLBACK_KEY, "true");
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    unsubscribe = security.subscribeSecurityMode(vi.fn());
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "off", locked: true });
    expect(security.getSecuritySnapshot().error).toContain("nicht dauerhaft");
    security.retrySecurityMode();
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "off", locked: false, error: null });
  });

  it.each(["", "auto", "never", "AUTOMATIC", "null"])("fails closed for invalid externally stored preference %s", async (value) => {
    const security = await import("./security-mode");
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, value);
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    unsubscribe = security.subscribeSecurityMode(vi.fn());
    expect(security.getSecuritySnapshot()).toMatchObject({ locked: true, ready: true });
    expect(security.getSecuritySnapshot().error).toContain("ungültig");
    security.toggleSecurityMode();
    expect(security.getSecuritySnapshot().locked).toBe(true);
    security.setSecurityPreference("manual");
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "manual", locked: true, error: null });
    security.toggleSecurityMode();
    expect(security.getSecuritySnapshot().locked).toBe(false);
  });

  it.each(["SECURITY_MODE_KEY", "SECURITY_AUTO_LOCK_KEY", "SECURITY_FALLBACK_KEY"] as const)(
    "validates malformed %s even while off", async (key) => {
      const security = await import("./security-mode");
      localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "off");
      const storage = key === "SECURITY_MODE_KEY" ? localStorage : sessionStorage;
      storage.setItem(security[key], "broken");
      bootstrap(security);
      expect(document.documentElement.dataset.securityMode).toBe("locked");
      unsubscribe = security.subscribeSecurityMode(vi.fn());
      expect(security.getSecuritySnapshot().error).toContain("ungültig");
    },
  );

  it("rejects an invalid setPreference call at the boundary without persisting it", async () => {
    const security = await store();
    security.setSecurityPreference("manual");
    security.setSecurityPreference("damaged" as import("./security-mode").SecurityActivationPreference);
    expect(localStorage.getItem(security.SECURITY_ACTIVATION_KEY)).toBe("manual");
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "manual", locked: true });
    expect(security.getSecuritySnapshot().error).toContain("ungültig");
    expect(sessionStorage.getItem(security.SECURITY_FALLBACK_KEY)).toBe("true");
    security.retrySecurityMode();
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "manual", locked: true, error: null });
  });

  it("reports corrupt cross-tab preferences instead of retaining an open view", async () => {
    const security = await store();
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "bad");
    window.dispatchEvent(new StorageEvent("storage", { key: security.SECURITY_ACTIVATION_KEY }));
    expect(security.getSecuritySnapshot().locked).toBe(true);
    expect(security.getSecuritySnapshot().error).toContain("ungültig");
  });

  it.each(["SECURITY_MODE_KEY", "SECURITY_ACTIVATION_KEY"] as const)(
    "fails closed on %s preference-transition failure and retries the requested choice", async (key) => {
      const security = await store();
      security.setSecurityPreference("manual");
      security.setSecurityMode(true);
      const original = Storage.prototype.setItem;
      const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, writeKey, value) {
        if (this === localStorage && writeKey === security[key]) throw new DOMException("Full", "QuotaExceededError");
        original.call(this, writeKey, value);
      });
      security.setSecurityPreference("off");
      expect(security.getSecuritySnapshot()).toMatchObject({ preference: "manual", locked: true });
      expect(security.getSecuritySnapshot().error).toContain("nicht dauerhaft");
      expect(localStorage.getItem(security.SECURITY_ACTIVATION_KEY)).toBe("manual");
      expect(sessionStorage.getItem(security.SECURITY_FALLBACK_KEY)).toBe("true");
      bootstrap(security);
      expect(document.documentElement.dataset.securityMode).toBe("locked");
      window.dispatchEvent(new Event("focus"));
      expect(security.getSecuritySnapshot().locked).toBe(true);
      fail.mockRestore();
      security.retrySecurityMode();
      expect(security.getSecuritySnapshot()).toMatchObject({ preference: "off", locked: false, error: null });
      expect(localStorage.getItem(security.SECURITY_ACTIVATION_KEY)).toBe("off");
      expect(sessionStorage.getItem(security.SECURITY_FALLBACK_KEY)).toBeNull();
    },
  );

  it.each(["SECURITY_AUTO_LOCK_KEY", "SECURITY_FALLBACK_KEY"] as const)(
    "does not commit off when clearing %s fails", async (key) => {
      const security = await store();
      window.dispatchEvent(new Event("blur"));
      const original = Storage.prototype.removeItem;
      const fail = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(function (this: Storage, writeKey) {
        if (this === sessionStorage && writeKey === security[key]) throw new DOMException("Denied", "SecurityError");
        original.call(this, writeKey);
      });
      security.setSecurityPreference("off");
      expect(security.getSecuritySnapshot()).toMatchObject({ preference: "automatic", locked: true });
      expect(security.getSecuritySnapshot().error).toContain("nicht dauerhaft");
      expect(localStorage.getItem(security.SECURITY_ACTIVATION_KEY)).toBeNull();
      fail.mockRestore();
      security.retrySecurityMode();
      expect(security.getSecuritySnapshot()).toMatchObject({ preference: "off", locked: false, error: null });
    },
  );

  it("explicitly reports that reload protection is not guaranteed if all writes are blocked", async () => {
    const security = await store();
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    security.setSecurityPreference("off");
    expect(security.getSecuritySnapshot()).toMatchObject({ locked: true, preference: "automatic" });
    expect(security.getSecuritySnapshot().error).toContain("nicht garantiert");
  });

  it("carries a bootstrap write failure into hydration even when storage recovers meanwhile", async () => {
    const security = await import("./security-mode");
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "off");
    localStorage.setItem(security.SECURITY_MODE_KEY, "true");
    sessionStorage.setItem(security.SECURITY_AUTO_LOCK_KEY, "true");
    const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    fail.mockRestore();
    unsubscribe = security.subscribeSecurityMode(vi.fn());
    expect(security.getSecuritySnapshot()).toMatchObject({ locked: true, ready: true, preference: "off" });
    expect(security.getSecuritySnapshot().error).toContain("nicht garantiert");
    security.retrySecurityMode();
    expect(security.getSecuritySnapshot()).toMatchObject({ locked: false, preference: "off", error: null });
  });

  it("carries a blocked bootstrap read into hydration and supports explicit retry", async () => {
    const security = await import("./security-mode");
    const fail = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    fail.mockRestore();
    unsubscribe = security.subscribeSecurityMode(vi.fn());
    expect(security.getSecuritySnapshot()).toMatchObject({ locked: true, ready: true });
    expect(security.getSecuritySnapshot().error).toContain("nicht geladen");
    security.retrySecurityMode();
    expect(security.getSecuritySnapshot()).toMatchObject({ locked: true, error: null, preference: "automatic" });
    security.toggleSecurityMode();
    expect(security.getSecuritySnapshot().locked).toBe(false);
  });

  it("keeps a background bootstrap write failure locked and recoverable after hydration", async () => {
    const security = await import("./security-mode");
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    const original = Storage.prototype.setItem;
    const failure = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage && key === security.SECURITY_MODE_KEY) throw new DOMException("Full", "QuotaExceededError");
      original.call(this, key, value);
    });
    bootstrap(security);
    expect(document.documentElement.dataset.securityMode).toBe("locked");
    expect(sessionStorage.getItem(security.SECURITY_FALLBACK_KEY)).toBe("true");
    unsubscribe = security.subscribeSecurityMode(vi.fn());
    expect(security.getSecuritySnapshot().error).toContain("nicht dauerhaft");
    failure.mockRestore();
    security.retrySecurityMode();
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "automatic", locked: true, error: null });
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBe("true");
  });

  it("does not resurrect a failed automatic lock if another tab disables activation before retry", async () => {
    const security = await store();
    const original = Storage.prototype.setItem;
    const failure = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
      if (this === localStorage && key === security.SECURITY_MODE_KEY) throw new DOMException("Full", "QuotaExceededError");
      original.call(this, key, value);
    });
    window.dispatchEvent(new Event("blur"));
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "off");
    window.dispatchEvent(new StorageEvent("storage", { key: security.SECURITY_ACTIVATION_KEY }));
    failure.mockRestore();
    security.retrySecurityMode();
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "off", locked: false, error: null });
    expect(sessionStorage.getItem(security.SECURITY_AUTO_LOCK_KEY)).toBeNull();
    expect(sessionStorage.getItem(security.SECURITY_FALLBACK_KEY)).toBeNull();
    expect(localStorage.getItem(security.SECURITY_ACTIVATION_KEY)).toBe("off");
  });

  it("fails closed if removing a stale off-mode automatic lock from another tab fails", async () => {
    const security = await store();
    window.dispatchEvent(new Event("blur"));
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "off");
    const failure = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
    window.dispatchEvent(new StorageEvent("storage", { key: security.SECURITY_ACTIVATION_KEY }));
    expect(security.getSecuritySnapshot().locked).toBe(true);
    expect(security.getSecuritySnapshot().error).toContain("nicht dauerhaft");
    failure.mockRestore();
    security.retrySecurityMode();
    expect(security.getSecuritySnapshot()).toMatchObject({ preference: "off", locked: false, error: null });
  });

  it.each(["manual", "off"] as const)("leaves native file-picker interactions unlocked in %s mode", async (preference) => {
    const security = await store();
    security.setSecurityPreference(preference);
    const write = vi.spyOn(Storage.prototype, "setItem");
    const input = fileInput();
    input.click();
    window.dispatchEvent(new Event("blur"));
    input.dispatchEvent(new Event("cancel", { bubbles: true }));
    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot()).toMatchObject({ preference, locked: false, error: null });
    expect(write).not.toHaveBeenCalled();
  });

  it("clears a pending file-picker exemption when the activation preference changes", async () => {
    const security = await store();
    fileInput().click();
    security.setSecurityPreference("manual");
    security.setSecurityPreference("automatic");
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
  });

  it("retains the native file-picker exemption when automatic activation is explicitly selected", async () => {
    const security = await store();
    security.setSecurityPreference("automatic");
    fileInput().click();
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(false);
    window.dispatchEvent(new Event("blur"));
    expect(security.getSecuritySnapshot().locked).toBe(true);
  });

  it("does not write or mutate financial application state when changing preferences", async () => {
    const financialKey = "finanzdashboard.v1";
    const unchanged = '{"unchanged":"fixture"}';
    localStorage.setItem(financialKey, unchanged);
    const security = await store();
    const write = vi.spyOn(Storage.prototype, "setItem");
    for (const preference of ["manual", "off", "automatic"] as const) security.setSecurityPreference(preference);
    expect(localStorage.getItem(financialKey)).toBe(unchanged);
    expect(write.mock.calls.every(([key]) => [
      security.SECURITY_ACTIVATION_KEY, security.SECURITY_MODE_KEY, security.SECURITY_AUTO_LOCK_KEY,
    ].includes(key))).toBe(true);
  });
});

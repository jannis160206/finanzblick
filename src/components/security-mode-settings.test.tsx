// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.resetModules();
  localStorage.clear();
  sessionStorage.clear();
  document.documentElement.removeAttribute("data-security-mode");
  document.documentElement.removeAttribute("data-security-mode-error");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

async function mount() {
  const [{ SecurityModeProvider, useSecurityMode }, { SecurityModeSettings }, security] = await Promise.all([
    import("./security-mode-provider"), import("./security-mode-settings"), import("@/lib/security-mode"),
  ]);
  function HeaderControl() {
    const { locked, preference, toggle } = useSecurityMode();
    return <button type="button" disabled={preference === "off"} onClick={toggle}>{locked ? "Entsperren" : "Sichtschutz einschalten"}</button>;
  }
  render(<SecurityModeProvider><HeaderControl /><SecurityModeSettings /></SecurityModeProvider>);
  return security;
}

it("offers a labelled native radio group with keyboard-focusable 44px targets and privacy context", async () => {
  await mount();
  const section = screen.getByRole("region", { name: "Sicherheitsmodus" });
  expect(section.id).toBe("sichtschutz");
  const group = within(section).getByRole("group", { name: "Sichtschutz aktivieren" });
  const radios = within(group).getAllByRole("radio") as HTMLInputElement[];
  expect(radios.map((radio) => radio.getAttribute("aria-label"))).toEqual(["Automatisch", "Nur manuell", "Deaktiviert"]);
  expect(radios.map((radio) => radio.checked)).toEqual([true, false, false]);
  expect(new Set(radios.map((radio) => radio.name)).size).toBe(1);
  for (const radio of radios) {
    expect(radio.type).toBe("radio");
    expect(radio.disabled).toBe(false);
    expect(radio.closest("label")?.className).toContain("min-h-11");
    expect(radio.closest("label")?.className).toContain("focus-within:ring-2");
    expect(document.getElementById(radio.getAttribute("aria-describedby")!)?.textContent).toBeTruthy();
    radio.focus();
    expect(document.activeElement).toBe(radio);
  }
  expect(within(section).getByText(/Beträge unscharf/)).toBeTruthy();
  expect(within(section).getByText(/in diesem Browser/)).toBeTruthy();
});

it("changes the immediately persisted preference without altering financial data", async () => {
  localStorage.setItem("finanzdashboard.v1", '{"unchanged":"fixture"}');
  const security = await mount();
  fireEvent.click(screen.getByRole("radio", { name: "Nur manuell" }));
  expect((screen.getByRole("radio", { name: "Nur manuell" }) as HTMLInputElement).checked).toBe(true);
  expect(localStorage.getItem(security.SECURITY_ACTIVATION_KEY)).toBe("manual");
  act(() => { window.dispatchEvent(new Event("blur")); });
  expect(screen.getByRole("button", { name: "Sichtschutz einschalten" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Sichtschutz einschalten" }));
  expect(screen.getByRole("button", { name: "Entsperren" })).toBeTruthy();
  fireEvent.click(screen.getByRole("radio", { name: "Deaktiviert" }));
  expect(localStorage.getItem(security.SECURITY_ACTIVATION_KEY)).toBe("off");
  expect((screen.getByRole("button", { name: "Sichtschutz einschalten" }) as HTMLButtonElement).disabled).toBe(true);
  expect(document.documentElement.dataset.securityMode).toBe("open");
  expect(localStorage.getItem("finanzdashboard.v1")).toBe('{"unchanged":"fixture"}');
});

it("keeps settings editable while the financial-data mask is active", async () => {
  const security = await mount();
  act(() => { window.dispatchEvent(new Event("blur")); });
  expect(security.getSecuritySnapshot().locked).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Nur manuell" }));
  expect(security.getSecuritySnapshot()).toMatchObject({ preference: "manual", locked: true });
  expect((screen.getByRole("radio", { name: "Deaktiviert" }) as HTMLInputElement).disabled).toBe(false);
  fireEvent.click(screen.getByRole("radio", { name: "Deaktiviert" }));
  expect(security.getSecuritySnapshot()).toMatchObject({ preference: "off", locked: false });
});

it("reflects cross-tab preference changes without submitting financial settings", async () => {
  const security = await mount();
  act(() => {
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "manual");
    window.dispatchEvent(new StorageEvent("storage", { key: security.SECURITY_ACTIVATION_KEY }));
  });
  expect((screen.getByRole("radio", { name: "Nur manuell" }) as HTMLInputElement).checked).toBe(true);
  act(() => {
    localStorage.setItem(security.SECURITY_ACTIVATION_KEY, "off");
    window.dispatchEvent(new StorageEvent("storage", { key: security.SECURITY_ACTIVATION_KEY }));
  });
  expect((screen.getByRole("radio", { name: "Deaktiviert" }) as HTMLInputElement).checked).toBe(true);
});

it("does not claim a failed preference is saved, and retries the actual requested choice", async () => {
  const security = await mount();
  const original = Storage.prototype.setItem;
  const failure = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (this === localStorage && key === security.SECURITY_ACTIVATION_KEY) throw new DOMException("Full", "QuotaExceededError");
    original.call(this, key, value);
  });
  fireEvent.click(screen.getByRole("radio", { name: "Deaktiviert" }));
  expect(screen.getByRole("alert").textContent).toContain("nicht dauerhaft");
  expect((screen.getByRole("radio", { name: "Automatisch" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("radio", { name: "Deaktiviert" }) as HTMLInputElement).checked).toBe(false);
  expect(document.documentElement.dataset.securityMode).toBe("locked");
  const retry = screen.getByRole("button", { name: "Erneut versuchen" });
  expect(retry.className).toContain("h-11");
  failure.mockRestore();
  fireEvent.click(retry);
  expect(screen.queryByRole("alert")).toBeNull();
  expect((screen.getByRole("radio", { name: "Deaktiviert" }) as HTMLInputElement).checked).toBe(true);
  expect(localStorage.getItem(security.SECURITY_ACTIVATION_KEY)).toBe("off");
  expect(document.documentElement.dataset.securityMode).toBe("open");
});

it("reports unavailable persistence explicitly and leaves native controls available for recovery", async () => {
  vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
  await mount();
  expect(screen.getByRole("alert").textContent).toContain("nicht geladen");
  expect((screen.getByRole("radio", { name: "Nur manuell" }) as HTMLInputElement).disabled).toBe(false);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new DOMException("Denied", "SecurityError"); });
  fireEvent.click(screen.getByRole("radio", { name: "Nur manuell" }));
  expect(screen.getByRole("alert").textContent).toContain("nicht garantiert");
  expect(document.documentElement.dataset.securityMode).toBe("locked");
});

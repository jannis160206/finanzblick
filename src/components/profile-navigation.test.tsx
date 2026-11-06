// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { AccountWorkspaceContext, type AccountWorkspace } from "./account-context";
import { AccountProfileSettings } from "./account-profile";
import { AppShell } from "./app-shell";
import { useFinance } from "./finance-provider";
import { createEmptyAccountState } from "@/lib/account-state";
import { calculateDashboard } from "@/lib/calc";

const navigation = vi.hoisted(() => ({ path: "/", locked: false }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.path, useRouter: () => ({ push: vi.fn(), replace: vi.fn() }) }));
vi.mock("next/link", () => ({
  default: ({ href, children, onClick, ...props }: ComponentProps<"a">) => <a href={href} {...props} onClick={(event) => {
    event.preventDefault();
    onClick?.(event);
  }}>{children}</a>,
}));
vi.mock("next-themes", () => ({ useTheme: () => ({ theme: "dark", setTheme: vi.fn() }) }));
vi.mock("./seasonal-theme-provider", () => ({ useSeasonalTheme: () => ({ theme: "default" }) }));
vi.mock("./security-mode-provider", () => ({
  useSecurityMode: () => ({ ready: true, locked: navigation.locked, error: null, toggle: vi.fn(), retry: vi.fn() }),
}));
vi.mock("./finance-provider", () => ({ useFinance: vi.fn(), useFinanceRestoration: () => vi.fn() }));
const workspace: AccountWorkspace = { user: { id: "profile-account", username: "admin", role: "admin" }, loadServer: vi.fn() };

function finance(saved = true) {
  const state = createEmptyAccountState();
  vi.mocked(useFinance).mockReturnValue({
    state, dashboard: calculateDashboard(state), ready: true, saved, storageError: null,
    openReviewCount: 0, update: vi.fn(), replace: vi.fn(), retrySave: vi.fn(), appendStatements: vi.fn(), statementImport: undefined,
  });
}
function shell(account: AccountWorkspace | null = workspace) {
  return render(<AccountWorkspaceContext.Provider value={account}><AppShell><p>Dashboard</p></AppShell></AccountWorkspaceContext.Provider>);
}
beforeEach(() => { localStorage.clear(); navigation.path = "/"; navigation.locked = false; finance(); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

it("places the signed-in identity, settings and logout together in the sidebar, not the header", () => {
  const view = shell();
  const sidebar = screen.getByRole("complementary");
  const profile = within(sidebar).getByRole("region", { name: "Benutzerprofil" });
  expect(within(profile).getByText("admin")).toBeTruthy();
  expect(within(profile).getByText("Administrator")).toBeTruthy();
  expect(within(profile).getByRole("link", { name: "Profil von admin öffnen" }).getAttribute("href")).toBe("/einstellungen#profil");
  expect(within(profile).getByRole("link", { name: "Einstellungen" }).getAttribute("href")).toBe("/einstellungen");
  expect(within(profile).getByRole("button", { name: "Abmelden" })).toBeTruthy();
  expect(within(view.container.querySelector("header")!).queryByRole("button", { name: "Abmelden" })).toBeNull();
  expect(within(screen.getByRole("navigation", { name: "Hauptnavigation" })).queryByRole("link", { name: "Einstellungen" })).toBeNull();
});

it("marks the profile's settings action as the active page", () => {
  navigation.path = "/einstellungen";
  shell();
  const link = screen.getByRole("link", { name: "Einstellungen" });
  expect(link.getAttribute("aria-current")).toBe("page");
  expect(link.className).toContain("text-primary");
});

it("preserves the original settings navigation for an unsigned local browser workspace", () => {
  shell(null);
  expect(screen.queryByRole("region", { name: "Benutzerprofil" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Abmelden" })).toBeNull();
  expect(screen.getByRole("link", { name: "Einstellungen" }).parentElement?.className).toContain("mt-auto");
  expect(screen.getByText("Daten bleiben in diesem Browser.")).toBeTruthy();
});

it("shows the same profile actions in the mobile drawer and closes it when opening settings", async () => {
  shell();
  fireEvent.click(screen.getByRole("button", { name: "Navigation öffnen" }));
  const dialog = screen.getByRole("dialog");
  const profile = within(dialog).getByRole("region", { name: "Benutzerprofil" });
  expect(within(profile).getByText("admin")).toBeTruthy();
  expect(within(profile).getByRole("button", { name: "Abmelden" })).toBeTruthy();
  fireEvent.click(within(profile).getByRole("link", { name: "Einstellungen" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

it("keeps unsynchronized logout protection in the profile area", () => {
  finance(false);
  shell();
  const button = screen.getByRole("button", { name: "Abmelden" }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  expect(document.getElementById(button.getAttribute("aria-describedby") ?? "")?.textContent).toBe("Bitte zuerst Änderungen synchronisieren.");
});

it("keeps profile navigation available while the financial screen is locked", () => {
  navigation.locked = true;
  shell();
  expect(screen.getByRole("link", { name: "Profil von admin öffnen" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Abmelden" })).toBeTruthy();
});

it("surfaces logout failures inside the backup dialog instead of the header", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
  shell();
  const profile = screen.getByRole("region", { name: "Benutzerprofil" });
  fireEvent.click(within(profile).getByRole("button", { name: "Abmelden" }));
  const dialog = await screen.findByRole("dialog", { name: "Vor dem Abmelden sichern" });
  fireEvent.click(within(dialog).getByRole("checkbox", { name: /bewusst ohne Sicherung verwerfen/ }));
  fireEvent.click(within(dialog).getByRole("button", { name: "Ohne Sicherung abmelden" }));
  const error = await within(dialog).findByRole("alert");
  expect(error.textContent).toContain("Der Server ist nicht erreichbar");
  expect((within(dialog).getByRole("button", { name: "Ohne Sicherung abmelden" }) as HTMLButtonElement).disabled).toBe(false);
});

it("shows a normal user's own profile and links to the existing settings sections", () => {
  render(<AccountWorkspaceContext.Provider value={{ ...workspace, user: { id: "alice", username: "alice", role: "user" } }}>
    <AccountProfileSettings />
  </AccountWorkspaceContext.Provider>);
  expect(screen.getByRole("heading", { name: "alice" })).toBeTruthy();
  expect(screen.getByText("Persönliches Konto")).toBeTruthy();
  expect(screen.queryByText("Administrator")).toBeNull();
  expect(screen.getByRole("link", { name: "Erscheinungsbild" }).getAttribute("href")).toBe("#jahreszeit");
  expect(screen.getByRole("link", { name: "Datensicherung" }).getAttribute("href")).toBe("#sicherung");
});

it("does not invent an account profile in unsigned browser mode", () => {
  const { container } = render(<AccountProfileSettings />);
  expect(container.childElementCount).toBe(0);
});

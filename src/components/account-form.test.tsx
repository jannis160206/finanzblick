// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccountForm } from "./account-form";

const fetchMock = vi.fn<typeof fetch>();
const assign = vi.fn();
const password = "A long passphrase 2026!";

function fillCredentials(username = "my.account", secret = password) {
  fireEvent.change(screen.getByLabelText("Benutzername"), { target: { value: username } });
  fireEvent.change(screen.getByLabelText("Passwort"), { target: { value: secret } });
}

function submit(registering = false) {
  fireEvent.submit(screen.getByRole("form", { name: registering ? "Konto erstellen" : "Anmelden" }));
}

function reply(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  assign.mockReset();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("location", { assign });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("AccountForm", () => {
  it("explains a failed local cache cleanup after a successful logout", () => {
    render(<AccountForm mode="login" storageWarning />);
    expect(screen.getByRole("alert").textContent).toContain("Du bist abgemeldet.");
    expect(screen.getByRole("alert").textContent).toContain("Website-Daten");
  });
  it("renders a standalone German login with accessible fields and the registration link", () => {
    render(<AccountForm mode="login" />);
    expect(screen.getByRole("main").className).toContain("min-h-screen");
    expect(screen.getByRole("heading", { name: "Willkommen zurück" })).toBeTruthy();
    expect(screen.getByLabelText("Benutzername").getAttribute("autocomplete")).toBe("username");
    expect(screen.getByLabelText("Passwort").getAttribute("autocomplete")).toBe("current-password");
    expect(screen.getByLabelText("Passwort").getAttribute("type")).toBe("password");
    expect(screen.getByRole("link", { name: "Konto erstellen" }).getAttribute("href")).toBe("/register");
    expect(screen.queryByLabelText("Passwort bestätigen")).toBeNull();
  });

  it("shows and hides passwords without submitting", () => {
    render(<AccountForm mode="register" />);
    fireEvent.click(screen.getByRole("button", { name: "Passwort anzeigen" }));
    expect(screen.getByLabelText("Passwort").getAttribute("type")).toBe("text");
    expect(screen.getByLabelText("Passwort bestätigen").getAttribute("type")).toBe("text");
    expect(screen.getByRole("button", { name: "Passwort verbergen" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Passwort verbergen" }));
    expect(screen.getByLabelText("Passwort").getAttribute("type")).toBe("password");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["", "", "Benutzername"],
    ["invalid name", password, "Benutzername"],
    ["my.account", "", "Passwort"],
  ])("rejects invalid credentials (%s) without a request", (username, secret, invalidField) => {
    render(<AccountForm mode="login" />);
    fillCredentials(username, secret);
    submit();
    expect(screen.getByRole("alert").textContent).toContain("Bitte überprüfe deine Eingaben.");
    expect(screen.getByLabelText(invalidField).getAttribute("aria-invalid")).toBe("true");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("submits an existing local administrator's short password without applying registration rules", async () => {
    fetchMock.mockResolvedValue(reply({ user: { id: "local-admin", username: "admin", role: "admin" } }));
    render(<AccountForm mode="login" />);
    fillCredentials("admin", "1234");
    submit();
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/"));
    expect(JSON.parse(fetchMock.mock.calls[0][1]!.body as string)).toEqual({ username: "admin", password: "1234" });
  });

  it("still requires a long password for registration", () => {
    render(<AccountForm mode="register" />);
    fillCredentials("alice", "1234");
    fireEvent.change(screen.getByLabelText("Passwort bestätigen"), { target: { value: "1234" } });
    submit(true);
    expect(screen.getByText("Dein Passwort muss 12–128 Zeichen lang sein.")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects mismatched registration confirmation and uses new-password autocomplete", () => {
    render(<AccountForm mode="register" />);
    fillCredentials();
    fireEvent.change(screen.getByLabelText("Passwort bestätigen"), { target: { value: "Another passphrase!" } });
    submit(true);
    expect(screen.getByText("Die Passwörter stimmen nicht überein.")).toBeTruthy();
    expect(screen.getByLabelText("Passwort bestätigen").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByLabelText("Passwort").getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText("Passwort bestätigen").getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByRole("link", { name: "Anmelden" }).getAttribute("href")).toBe("/login");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows a generic 401 instead of untrusted response text and preserves credentials", async () => {
    fetchMock.mockResolvedValue(reply({ error: "<script>secret internal details</script>" }, 401));
    render(<AccountForm mode="login" />);
    fillCredentials();
    submit();
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Anmeldung fehlgeschlagen. Bitte überprüfe deinen Benutzernamen und dein Passwort.");
    expect(alert.textContent).not.toContain("internal");
    expect((screen.getByLabelText("Passwort") as HTMLInputElement).value).toBe(password);
    expect((screen.getByLabelText("Benutzername") as HTMLInputElement).value).toBe("my.account");
    expect(assign).not.toHaveBeenCalled();
    expect((screen.getByRole("button", { name: "Anmelden" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("shows an allowlisted public error without rendering arbitrary details", async () => {
    fetchMock.mockResolvedValue(reply({ error: "Dieser Benutzername ist nicht verfügbar." }, 409));
    render(<AccountForm mode="register" />);
    fillCredentials();
    fireEvent.change(screen.getByLabelText("Passwort bestätigen"), { target: { value: password } });
    submit(true);
    expect((await screen.findByRole("alert")).textContent).toContain("Dieser Benutzername ist nicht verfügbar.");
    expect((screen.getByLabelText("Passwort bestätigen") as HTMLInputElement).value).toBe(password);
  });

  it("reports a network failure and permits retry without losing typed input", async () => {
    fetchMock.mockRejectedValue(new TypeError("Failed to fetch"));
    render(<AccountForm mode="login" />);
    fillCredentials();
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("Verbindung fehlgeschlagen.");
    expect((screen.getByLabelText("Passwort") as HTMLInputElement).value).toBe(password);
    expect((screen.getByRole("button", { name: "Anmelden" }) as HTMLButtonElement).disabled).toBe(false);
    submit();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(assign).not.toHaveBeenCalled();
  });

  it("prevents duplicate requests while busy and performs a full root navigation on success", async () => {
    let resolve!: (response: Response) => void;
    fetchMock.mockReturnValue(new Promise<Response>((done) => { resolve = done; }));
    render(<AccountForm mode="login" />);
    fillCredentials("MY.Account");
    submit();
    submit();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username: "my.account", password }),
    });
    expect(screen.getByRole("form", { name: "Anmelden" }).getAttribute("aria-busy")).toBe("true");
    expect((screen.getByLabelText("Passwort") as HTMLInputElement).matches(":disabled")).toBe(true);
    expect((screen.getByRole("button", { name: "Anmeldung läuft …" }) as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(reply({ user: { id: "user-1", username: "my.account", role: "user" } })));
    expect(assign).toHaveBeenCalledExactlyOnceWith("/");
    expect((screen.getByLabelText("Passwort") as HTMLInputElement).value).toBe("");
    submit();
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends only username and password to registration, never the confirmation", async () => {
    fetchMock.mockResolvedValue(reply({ user: { id: "user-2", username: "new.account", role: "admin" } }, 201));
    const storage = vi.spyOn(Storage.prototype, "setItem");
    render(<AccountForm mode="register" />);
    fillCredentials("new.account");
    fireEvent.change(screen.getByLabelText("Passwort bestätigen"), { target: { value: password } });
    submit(true);
    await waitFor(() => expect(assign).toHaveBeenCalledExactlyOnceWith("/"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({ username: "new.account", password }),
    });
    expect(storage).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Passwort bestätigen") as HTMLInputElement).value).toBe("");
  });

  it.each([
    {},
    { user: { id: "user-1", username: "my.account" } },
    { user: { id: "user-1", username: "my.account", role: "superuser" } },
    { user: { id: 1, username: "my.account", role: "user" } },
  ])("rejects invalid successful account responses: %j", async (payload) => {
    fetchMock.mockResolvedValue(reply(payload));
    render(<AccountForm mode="login" />);
    fillCredentials();
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("Die Anmeldung konnte nicht bestätigt werden.");
    expect(assign).not.toHaveBeenCalled();
    expect((screen.getByLabelText("Passwort") as HTMLInputElement).value).toBe(password);
  });

  it("handles non-JSON server errors with a German fallback", async () => {
    fetchMock.mockResolvedValue(new Response("Bad gateway", { status: 502 }));
    render(<AccountForm mode="login" />);
    fillCredentials();
    submit();
    expect((await screen.findByRole("alert")).textContent).toContain("Anmeldung nicht möglich.");
    expect(assign).not.toHaveBeenCalled();
  });

  it("renders an informative closed registration page without credential inputs", () => {
    render(<AccountForm mode="register" registrationEnabled={false} />);
    expect(screen.getByText("Registrierung derzeit geschlossen")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Zur Anmeldung" }).getAttribute("href")).toBe("/login");
    expect(screen.queryByRole("form")).toBeNull();
    expect(screen.queryByLabelText("Passwort")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not invite users to register when registration is disabled", () => {
    render(<AccountForm mode="login" registrationEnabled={false} />);
    expect(screen.queryByRole("link", { name: "Konto erstellen" })).toBeNull();
    expect(screen.getByText("Neue Konten können derzeit nicht erstellt werden.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Anmelden" })).toBeTruthy();
  });
});

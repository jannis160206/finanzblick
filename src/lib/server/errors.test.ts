import { afterEach, expect, it, vi } from "vitest";
afterEach(() => vi.restoreAllMocks());

it("preserves safe public errors across route-module instances without exposing configuration details", async () => {
  const original = await import("./errors");
  const conflict = new original.AccountError(409, "Dieser Benutzername ist nicht verfügbar.");
  const configuration = new original.AccountConfigError("Private configuration detail");
  vi.resetModules();
  const current = await import("./errors");
  const { accountErrorResponse } = await import("./http");
  expect(conflict).not.toBeInstanceOf(current.AccountError);
  expect(accountErrorResponse(conflict).status).toBe(409);
  vi.spyOn(console, "error").mockImplementation(() => {});
  const response = accountErrorResponse(configuration);
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Die Kontoanmeldung ist momentan nicht verfügbar." });
  const unexpected = new Error("Private database detail");
  unexpected.name = "AccountError";
  expect(await accountErrorResponse(unexpected).json()).toEqual({ error: "Die Anfrage konnte nicht verarbeitet werden." });
});

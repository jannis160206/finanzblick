// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UploadStatus } from "./upload-status";
import type { AutomationJob } from "@/lib/automation/schema";
const privacy = vi.hoisted(() => ({ locked: false }));
vi.mock("./security-mode-provider", () => ({ useSecurityMode: () => privacy }));

afterEach(() => {
  cleanup();
  privacy.locked = false;
  delete document.documentElement.dataset.securityMode;
});

function job(id: string, status: AutomationJob["status"], kind: AutomationJob["kind"] = "statement"): AutomationJob {
  return { id, name: `${id}.pdf`, status, kind, progress: 45,
    attempts: 0, cursor: 0, total: 0, updatedAt: 1,
    error: status === "FAILED" ? "Datei beschädigt" : null };
}

it("keeps progress and warnings off the page until the clock is opened and counts only active uploads", () => {
  render(<UploadStatus activities={[]} jobs={[
    job("queue", "QUEUED"), job("processing", "PROCESSING"),
    job("done", "COMPLETED"), job("failed", "FAILED"), job("backfill", "PROCESSING", "backfill"),
  ]} error={null} reviewCount={4} summary={{ imported: 47, issues: ["bad.pdf: Nicht lesbar."] }} />);
  const trigger = screen.getByRole("button", { name: "Uploadstatus" });
  expect(trigger.querySelector("[data-upload-badge]")?.textContent).toBe("2");
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.queryByLabelText("Importstatus")).toBeNull();
  expect(screen.queryByText("Datei beschädigt")).toBeNull();
  fireEvent.click(trigger);
  const dialog = within(screen.getByRole("dialog", { name: "Uploadstatus" }));
  expect(dialog.getAllByRole("article")).toHaveLength(5);
  expect(dialog.getByRole("alert").textContent).toBe("Datei beschädigt");
  expect(dialog.getByRole("region", { name: "Importstatus" })).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Importhinweise" }));
  expect(dialog.getByText("Nicht lesbar.")).toBeTruthy();
  fireEvent.click(dialog.getByRole("button", { name: "Schließen" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("has a useful empty state and no badge until there is activity", () => {
  render(<UploadStatus activities={[]} jobs={[]} error={null} reviewCount={0} />);
  expect(document.querySelector("[data-upload-badge]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getByText("Noch keine Uploads")).toBeTruthy();
});

it("retains an exclamation badge and explicit connection errors without pretending there are active uploads", () => {
  render(<UploadStatus activities={[]} jobs={[]} error="Echtzeit-Verbindung unterbrochen" reviewCount={0} />);
  const button = screen.getByRole("button", { name: "Uploadstatus" });
  expect(button.querySelector("[data-upload-badge]")?.textContent).toBe("!");
  fireEvent.click(button);
  expect(screen.getByRole("alert").textContent).toContain("Echtzeit-Verbindung unterbrochen");
});

it("does not fabricate a transfer percentage and does not double-count a realtime uploading job", () => {
  render(<UploadStatus activities={[
    { id: "one", name: "gleich.pdf", phase: "uploading", error: null },
    { id: "two", name: "gleich.pdf", phase: "waiting", error: null },
  ]} jobs={[{ ...job("one", "UPLOADING"), name: "gleich.pdf" }]} error={null} reviewCount={0} />);
  expect(document.querySelector("[data-upload-badge]")?.textContent).toBe("2");
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getAllByRole("article")).toHaveLength(2);
  for (const bar of screen.getAllByRole("progressbar"))
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
  expect(screen.queryByText("0%")).toBeNull();
  expect(screen.getByText("Wird hochgeladen")).toBeTruthy();
  expect(screen.getByText("Wartet auf Übertragung")).toBeTruthy();
});

it("conceals an open private upload dialog while screen privacy is locked", () => {
  const view = render(<UploadStatus activities={[]} jobs={[job("private", "PROCESSING")]} error={null} reviewCount={0} />);
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getByText("private.pdf")).toBeTruthy();
  privacy.locked = true;
  view.rerender(<UploadStatus activities={[]} jobs={[job("private", "PROCESSING")]} error={null} reviewCount={0} />);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByText("private.pdf")).toBeNull();
});

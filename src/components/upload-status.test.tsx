// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { UploadStatus } from "./upload-status";
import type { AutomationJob } from "@/lib/automation/schema";
import { useUploadActivity } from "./upload-activity";
const privacy = vi.hoisted(() => ({ locked: false }));
vi.mock("./security-mode-provider", () => ({ useSecurityMode: () => privacy }));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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
    { id: "one", name: "gleich.pdf", phase: "uploading", error: null, updatedAt: 1 },
    { id: "two", name: "gleich.pdf", phase: "waiting", error: null, updatedAt: 2 },
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

it("shows only the latest two finished server imports, including a failed import, without hiding active uploads", () => {
  render(<UploadStatus activities={[]} jobs={[
    { ...job("old-failure", "FAILED"), updatedAt: 1 },
    { ...job("old-success", "COMPLETED"), updatedAt: 2 },
    { ...job("latest-failure", "FAILED"), updatedAt: 4 },
    { ...job("latest-success", "COMPLETED"), updatedAt: 3 },
    { ...job("backfill-done", "COMPLETED", "backfill"), updatedAt: 5 },
    ...Array.from({ length: 3 }, (_, index) => job(`active-${index}`, "PROCESSING")),
  ]} error={null} reviewCount={0} />);
  expect(document.querySelector("[data-upload-badge]")?.textContent).toBe("3");
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getAllByRole("article")).toHaveLength(5);
  expect(screen.getByRole("article", { name: "Verarbeitung: latest-failure.pdf" })).toBeTruthy();
  expect(screen.getByRole("article", { name: "Verarbeitung: latest-success.pdf" })).toBeTruthy();
  expect(screen.queryByText("old-failure.pdf")).toBeNull();
  expect(screen.queryByText("old-success.pdf")).toBeNull();
  expect(screen.queryByText("backfill-done.pdf")).toBeNull();
  expect(screen.getByRole("alert").textContent).toBe("Datei beschädigt");
});

it("shares the two-import limit between client and server results rather than allowing two of each", () => {
  render(<UploadStatus activities={[
    { id: "old-local", name: "old-local.pdf", phase: "completed", error: null, updatedAt: 1 },
    { id: "local-failure", name: "local-failure.pdf", phase: "failed", error: "Upload fehlgeschlagen", updatedAt: 4 },
    { id: "remote-success", name: "remote-success.pdf", phase: "accepted", error: null, updatedAt: 3 },
  ]} jobs={[
    { ...job("remote-success", "COMPLETED"), updatedAt: 3 },
    { ...job("old-remote", "COMPLETED"), updatedAt: 2 },
  ]} error={null} reviewCount={0} />);
  expect(document.querySelector("[data-upload-badge]")?.textContent).toBe("!");
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getAllByRole("article")).toHaveLength(2);
  expect(screen.getByRole("article", { name: "Verarbeitung: local-failure.pdf" })).toBeTruthy();
  expect(screen.getByRole("article", { name: "Verarbeitung: remote-success.pdf" })).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toBe("Upload fehlgeschlagen");
  expect(screen.queryByText("old-local.pdf")).toBeNull();
  expect(screen.queryByText("old-remote.pdf")).toBeNull();
});

it("does not retain an error badge for failures older than the latest two imports", () => {
  render(<UploadStatus activities={[
    { id: "old", name: "old.pdf", phase: "failed", error: "Alter Fehler", updatedAt: 1 },
  ]} jobs={[
    { ...job("latest", "COMPLETED"), updatedAt: 3 },
    { ...job("second", "COMPLETED"), updatedAt: 2 },
  ]} error={null} reviewCount={0} />);
  expect(document.querySelector("[data-upload-badge]")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.getAllByRole("article")).toHaveLength(2);
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByText("Alter Fehler")).toBeNull();
});

it("retains only two local outcomes by completion time while keeping every unfinished file", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { result } = renderHook(() => useUploadActivity([]));
  act(() => result.current.add(["first", "second", "third", "running"].map((id) => ({
    id, name: `${id}.pdf`, phase: "waiting", error: null, updatedAt: 0,
  }))));
  vi.setSystemTime(100);
  act(() => result.current.change(["third"], "completed"));
  vi.setSystemTime(200);
  act(() => result.current.change(["second"], "failed", "Datei nicht lesbar"));
  vi.setSystemTime(300);
  act(() => result.current.change(["first"], "completed"));
  expect(result.current.activities.map((item) => item.id)).toEqual(["first", "second", "running"]);
  expect(result.current.activities.find((item) => item.id === "second")).toMatchObject({
    phase: "failed", error: "Datei nicht lesbar", updatedAt: 200,
  });
});

it("replaces the older result when a third import finishes while the status window is open", async () => {
  const initial = [
    { ...job("first", "COMPLETED"), updatedAt: 1 },
    { ...job("second", "COMPLETED"), updatedAt: 2 },
  ];
  const view = render(<UploadStatus activities={[]} jobs={initial} error={null} reviewCount={0} />);
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  view.rerender(<UploadStatus activities={[]} jobs={[
    ...initial, { ...job("third", "FAILED"), updatedAt: 3 },
  ]} error={null} reviewCount={0} />);
  expect(screen.getAllByRole("article")).toHaveLength(2);
  expect(screen.getByRole("article", { name: "Verarbeitung: second.pdf" })).toBeTruthy();
  expect(screen.getByRole("article", { name: "Verarbeitung: third.pdf" })).toBeTruthy();
  expect(document.querySelector("[data-upload-badge]")?.textContent).toBe("!");
  await waitFor(() => expect(screen.queryByText("first.pdf")).toBeNull());
});

it("offers a cancel button only for active statement jobs and local uploads", () => {
  const onCancel = vi.fn();
  render(<UploadStatus activities={[{ id: "local", name: "local.csv", phase: "waiting", error: null, updatedAt: 1 },
    { id: "reading", name: "reading.csv", phase: "reading", error: null, updatedAt: 1 }]}
    jobs={[job("queue", "QUEUED"), job("done", "COMPLETED"), job("failed", "FAILED"),
      job("backfill", "PROCESSING", "backfill")]}
    error={null} reviewCount={0} onCancel={onCancel} />);
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  const dialog = within(screen.getByRole("dialog", { name: "Uploadstatus" }));
  expect(dialog.getAllByRole("button", { name: /Verarbeitung abbrechen/ })).toHaveLength(2);
  fireEvent.click(dialog.getByRole("button", { name: "Verarbeitung abbrechen: queue.pdf" }));
  expect(onCancel).toHaveBeenCalledWith("queue");
  fireEvent.click(dialog.getByRole("button", { name: "Verarbeitung abbrechen: local.csv" }));
  expect(onCancel).toHaveBeenCalledWith("local");
});

it("shows no cancel button without a cancel handler", () => {
  render(<UploadStatus activities={[]} jobs={[job("queue", "QUEUED")]} error={null} reviewCount={0} />);
  fireEvent.click(screen.getByRole("button", { name: "Uploadstatus" }));
  expect(screen.queryByRole("button", { name: /Verarbeitung abbrechen/ })).toBeNull();
});
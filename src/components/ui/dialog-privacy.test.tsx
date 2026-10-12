// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle } from "./dialog";

const privacy = vi.hoisted(() => ({ locked: false }));
vi.mock("../security-mode-provider", () => ({ useSecurityMode: () => privacy }));
afterEach(() => { cleanup(); privacy.locked = false; delete document.documentElement.dataset.securityMode; });

it("ignores dismissal during a synchronous privacy lock before React sees the lock", () => {
  document.documentElement.dataset.securityMode = "open";
  const changed = vi.fn();
  const view = render(<Dialog open onOpenChange={changed}><DialogContent><DialogTitle>Entwurf</DialogTitle><DialogDescription>Nicht gespeichert</DialogDescription><DialogClose>Abbrechen</DialogClose></DialogContent></Dialog>);
  document.documentElement.dataset.securityMode = "locked";
  fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
  expect(changed).not.toHaveBeenCalled();
  privacy.locked = true;
  view.rerender(<Dialog open onOpenChange={changed}><DialogContent><DialogTitle>Entwurf</DialogTitle><DialogDescription>Nicht gespeichert</DialogDescription></DialogContent></Dialog>);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it("allows explicit dismissals again after unlocking", () => {
  document.documentElement.dataset.securityMode = "open";
  const changed = vi.fn();
  render(<Dialog open onOpenChange={changed}><DialogContent><DialogTitle>Entwurf</DialogTitle><DialogDescription>Nicht gespeichert</DialogDescription><DialogClose>Abbrechen</DialogClose></DialogContent></Dialog>);
  fireEvent.click(screen.getByRole("button", { name: "Abbrechen" }));
  expect(changed).toHaveBeenCalledWith(false);
});

it("keeps the navigation drawer dismissible while privacy is active", () => {
  privacy.locked = true;
  document.documentElement.dataset.securityMode = "locked";
  const changed = vi.fn();
  render(<Dialog allowWhenLocked open onOpenChange={changed}><DialogContent variant="navigation"><DialogTitle>Navigation</DialogTitle><DialogDescription>Seite wählen</DialogDescription><DialogClose>Schließen</DialogClose></DialogContent></Dialog>);
  fireEvent.click(screen.getAllByRole("button", { name: "Schließen" })[0]);
  expect(changed).toHaveBeenCalledWith(false);
});

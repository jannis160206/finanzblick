// @vitest-environment jsdom
import { useState, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ChoiceCards, DialogStep, DialogSteps, Field, MoneyField, PremiumDialog, PremiumDialogBody, PremiumDialogContent, PremiumDialogFooter,
  PremiumDialogHeader, PremiumDialogTrigger, ToggleRow,
} from "./index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

const security = vi.hoisted(() => ({ locked: false }));
vi.mock("@/components/security-mode-provider", () => ({ useSecurityMode: () => ({ locked: security.locked, ready: true }) }));

let compact = false;
beforeEach(() => {
  compact = false;
  security.locked = false;
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query.includes("max-width: 767px") ? compact : false, media: query,
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, onchange: null, dispatchEvent: () => false,
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function Harness({ children, dirty = false, snapPoints, onOpenChange }: { children?: ReactNode; dirty?: boolean; snapPoints?: number[]; onOpenChange?: (open: boolean) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <PremiumDialog open={open} onOpenChange={(next) => { setOpen(next); onOpenChange?.(next); }}>
      <PremiumDialogTrigger asChild><Button>Öffnen</Button></PremiumDialogTrigger>
      <PremiumDialogContent dirty={dirty} snapPoints={snapPoints}>
        <PremiumDialogHeader title="Sparziel anlegen" description="Wofür sparst du?" />
        {children ?? <>
          <PremiumDialogBody><Field label="Name"><Input /></Field></PremiumDialogBody>
          <PremiumDialogFooter><Button>Speichern</Button></PremiumDialogFooter>
        </>}
      </PremiumDialogContent>
    </PremiumDialog>
  );
}

describe("premium dialog", () => {
  it("opens as a centered modal with title, description and the first field focused, and restores focus on Escape", async () => {
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "Öffnen" });
    fireEvent.click(trigger);
    const dialog = screen.getByRole("dialog", { name: "Sparziel anlegen" });
    expect(dialog.dataset.presentation).toBe("modal");
    expect(dialog.getAttribute("aria-describedby")).toBeTruthy();
    expect(within(dialog).getByText("Wofür sparst du?")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(within(dialog).getByLabelText("Name")));
    fireEvent.keyDown(document.activeElement!, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(trigger));
  });

  it("becomes a bottom sheet on small screens with snap points that work by keyboard", async () => {
    compact = true;
    render(<Harness snapPoints={[0.5, 0.92]} />);
    fireEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    const dialog = screen.getByRole("dialog", { name: "Sparziel anlegen" });
    expect(dialog.dataset.presentation).toBe("sheet");
    expect(dialog.dataset.snap).toBe("1");
    const handle = within(dialog).getByRole("button", { name: "Höhe anpassen" });
    fireEvent.keyDown(handle, { key: "ArrowDown" });
    await waitFor(() => expect(dialog.dataset.snap).toBe("0"));
    expect(dialog.style.height).toBe(`${Math.round(0.5 * window.innerHeight)}px`);
    fireEvent.click(handle);
    await waitFor(() => expect(dialog.dataset.snap).toBe("1"));
  });

  it("closes the sheet when it is swiped down", () => {
    compact = true;
    const changed = vi.fn();
    render(<Harness onOpenChange={changed} />);
    fireEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    const title = screen.getByRole("heading", { name: "Sparziel anlegen" });
    fireEvent.pointerDown(title, { clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(title, { clientY: 500, pointerId: 1 });
    fireEvent.pointerUp(title, { clientY: 500, pointerId: 1 });
    expect(changed).toHaveBeenLastCalledWith(false);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("asks before discarding unsaved input on Escape and swipe", () => {
    compact = true;
    render(<Harness dirty />);
    fireEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBe(dialog);
    const guard = within(dialog).getByRole("group", { name: "Ungespeicherte Eingaben" });
    fireEvent.click(within(guard).getByRole("button", { name: "Weiter bearbeiten" }));
    expect(within(dialog).queryByRole("group", { name: "Ungespeicherte Eingaben" })).toBeNull();
    const title = within(dialog).getByRole("heading", { name: "Sparziel anlegen" });
    fireEvent.pointerDown(title, { clientY: 100, button: 0, pointerId: 1 });
    fireEvent.pointerMove(title, { clientY: 600, pointerId: 1 });
    fireEvent.pointerUp(title, { clientY: 600, pointerId: 1 });
    fireEvent.click(within(dialog).getByRole("button", { name: "Verwerfen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows nothing while the privacy lock is active", () => {
    security.locked = true;
    render(<Harness />);
    fireEvent.click(screen.getByRole("button", { name: "Öffnen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

function StepsHarness({ editing = false, onComplete = vi.fn(), mode = "always" as "always" | "auto" | "never" }) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  return (
    <PremiumDialog defaultOpen>
      <PremiumDialogContent>
        <PremiumDialogHeader title="Vertrag" />
        <DialogSteps mode={mode} editing={editing} onComplete={onComplete}>
          <DialogStep id="basics" title="Grunddaten" validate={() => { const ok = name.trim().length > 0; setError(ok ? null : "Bitte einen Namen eingeben."); return ok; }}>
            <Field label="Name" error={error}><Input value={name} onChange={(event) => setName(event.target.value)} /></Field>
          </DialogStep>
          <DialogStep id="amount" title="Betrag">
            <Field label="Betrag"><MoneyField value={amount} onValueChange={setAmount} /></Field>
          </DialogStep>
          <DialogStep id="preview" title="Vorschau"><p>Alles bereit</p></DialogStep>
        </DialogSteps>
      </PremiumDialogContent>
    </PremiumDialog>
  );
}

describe("dialog steps", () => {
  it("validates each step before moving on and focuses the invalid field", async () => {
    const done = vi.fn();
    render(<StepsHarness onComplete={done} />);
    const steps = screen.getByRole("navigation", { name: "Schritte" });
    expect(within(steps).getByText("Schritt 1 von 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Weiter" }));
    expect(screen.getByRole("alert").textContent).toBe("Bitte einen Namen eingeben.");
    await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText("Name")));
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Netflix" } });
    fireEvent.click(screen.getByRole("button", { name: "Weiter" }));
    expect(within(steps).getByText("Schritt 2 von 3")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Betrag" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Zurück" }));
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(within(steps).getByRole("button", { name: "2. Betrag" }).hasAttribute("disabled")).toBe(false);
    expect(within(steps).getByRole("button", { name: "3. Vorschau" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Weiter" }));
    fireEvent.click(screen.getByRole("button", { name: "Weiter" }));
    expect(screen.getByText("Alles bereit")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(done).toHaveBeenCalledTimes(1);
  });

  it("lets every step be opened and saves at once when editing, but still validates", () => {
    const done = vi.fn();
    render(<StepsHarness editing onComplete={done} />);
    const steps = screen.getByRole("navigation", { name: "Schritte" });
    expect(within(steps).getAllByRole("button").every((button) => !button.hasAttribute("disabled"))).toBe(true);
    fireEvent.click(within(steps).getByRole("button", { name: "3. Vorschau" }));
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(done).not.toHaveBeenCalled();
    expect(screen.getByLabelText("Name").getAttribute("aria-invalid")).toBe("true");
  });

  it("shows a short form in one piece and becomes step-by-step when it does not fit or on phones", () => {
    const { unmount } = render(<StepsHarness mode="auto" />);
    expect(screen.queryByRole("navigation", { name: "Schritte" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Betrag" })).toBeTruthy();
    unmount();
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockReturnValue(1200);
    const client = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(500);
    const tall = render(<StepsHarness mode="auto" />);
    expect(screen.getByRole("navigation", { name: "Schritte" })).toBeTruthy();
    tall.unmount();
    scroll.mockRestore();
    client.mockRestore();
    compact = true;
    render(<StepsHarness mode="auto" />);
    expect(screen.getByRole("navigation", { name: "Schritte" })).toBeTruthy();
  });

  it("submits a single-page form only when every step is valid", () => {
    const done = vi.fn();
    render(<StepsHarness mode="never" onComplete={done} />);
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(done).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Gym" } });
    fireEvent.click(screen.getByRole("button", { name: "Speichern" }));
    expect(done).toHaveBeenCalledTimes(1);
  });
});

describe("dialog fields", () => {
  it("wires label, hint and error to the control", () => {
    render(<Field label="Betrag" hint="Pro Monat" error="Bitte einen Betrag eingeben."><Input /></Field>);
    const input = screen.getByLabelText("Betrag");
    expect(input.getAttribute("aria-invalid")).toBe("true");
    const described = input.getAttribute("aria-describedby")!.split(" ").map((id) => document.getElementById(id)?.textContent);
    expect(described).toEqual(["Pro Monat", "Bitte einen Betrag eingeben."]);
  });

  it("tidies Austrian money input on blur", () => {
    function Money() { const [value, setValue] = useState(""); return <MoneyField aria-label="Betrag" value={value} onValueChange={setValue} />; }
    render(<Money />);
    const input = screen.getByLabelText("Betrag");
    fireEvent.change(input, { target: { value: "1250,5" } });
    fireEvent.blur(input);
    expect((input as HTMLInputElement).value).toMatch(/^1\.250,50$/);
  });

  it("chooses cards with arrow keys and toggles switches", () => {
    function Choice() {
      const [value, setValue] = useState<"a" | "b" | "c">("a");
      const [on, setOn] = useState(false);
      return <>
        <ChoiceCards aria-labelledby="x" value={value} onValueChange={setValue} options={[{ value: "a", label: "Monatlich" }, { value: "b", label: "Jährlich", disabled: true }, { value: "c", label: "Wöchentlich" }]} />
        <ToggleRow label="Automatisch planen" checked={on} onCheckedChange={setOn} />
      </>;
    }
    render(<Choice />);
    const monthly = screen.getByRole("radio", { name: "Monatlich" });
    expect(monthly.getAttribute("aria-checked")).toBe("true");
    fireEvent.keyDown(monthly, { key: "ArrowRight" });
    expect(screen.getByRole("radio", { name: "Wöchentlich" }).getAttribute("aria-checked")).toBe("true");
    expect(document.activeElement).toBe(screen.getByRole("radio", { name: "Wöchentlich" }));
    const toggle = screen.getByRole("switch", { name: "Automatisch planen" });
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-checked")).toBe("true");
  });
});

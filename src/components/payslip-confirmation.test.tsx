// @vitest-environment jsdom
import { StrictMode, useReducer, useState } from "react";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFinance } from "@/components/finance-provider";
import { PayslipRemoveDialog, type PayslipRemoval } from "@/components/payslip-remove-dialog";
import { PayslipSummary } from "@/components/payslip-summary";
import { PayslipUploadProvider } from "@/components/payslip-upload";
import { usePayslipMutation } from "@/components/payslip-mutation";
import { createSeed } from "@/lib/seed";
import type { Payslip, PayrollForecast } from "@/lib/payslip-schema";
import type { AppState } from "@/lib/types";
import { ZodError } from "zod";
import { FinanceStorageError } from "@/lib/finance-storage";
import { PayslipMutationError } from "@/lib/payslip-storage";

const fixture = vi.hoisted(() => ({
  state: undefined as unknown as AppState,
  update: vi.fn(),
  parse: vi.fn(),
  success: vi.fn(),
  imported: vi.fn(),
  atUpdate: null as ((state: AppState) => AppState) | null,
}));
vi.mock("@/components/finance-provider", () => ({
  useFinance: () => ({ state: fixture.state, update: fixture.update, storageError: null }),
}));
vi.mock("@/lib/import/payslip", () => ({
  parsePayslipPdf: fixture.parse,
  PayslipPasswordError: class extends Error {},
}));
vi.mock("sonner", () => ({ toast: { success: fixture.success } }));

const january: Payslip = {
  year: 2026, month: 1, employer: "Musterbetrieb GmbH",
  regularGross: 3000, specialGross: 0, baseSalary: 3000, monthlyPayroll: true,
};
const correction = { ...january, regularGross: 3100 };
const forecast: PayrollForecast = {
  year: 2026, employer: january.employer, months: [], standardPayrollConfirmed: true,
};
// The payroll page opens the removal from a month's details; this harness offers it for the first stored payslip.
function Removal() {
  const { state } = useFinance();
  const [target, setTarget] = useState<PayslipRemoval | null>(null);
  const entry = state.payslips?.[0];
  return <>
    {entry && <button type="button" onClick={(event) => setTarget({ entry, trigger: event.currentTarget })}>Abrechnung entfernen: 1/2026</button>}
    <PayslipRemoveDialog target={target} onClose={() => setTarget(null)} />
  </>;
}
const element = () => <PayslipUploadProvider onImported={fixture.imported}><PayslipSummary /><Removal /></PayslipUploadProvider>;

beforeEach(() => {
  vi.clearAllMocks();
  fixture.state = { ...createSeed(), payslips: [january], payrollForecasts: [forecast] };
  fixture.atUpdate = null;
  fixture.update.mockImplementation((updater: (state: AppState) => AppState) => {
    if (fixture.atUpdate) fixture.state = fixture.atUpdate(fixture.state);
    fixture.state = updater(fixture.state);
  });
  fixture.parse.mockResolvedValue({ drafts: [correction], issues: [] });
});
afterEach(cleanup);

function openDelete() {
  fireEvent.click(screen.getByRole("button", { name: "Abrechnung entfernen: 1/2026" }));
  return screen.getByRole("dialog", { name: "Lohnabrechnung entfernen?" });
}
function upload() {
  const file = new File(["synthetic PDF only"], "synthetic.pdf", { type: "application/pdf" });
  Object.defineProperty(file, "arrayBuffer", { value: async () => new ArrayBuffer(8) });
  fireEvent.change(screen.getByLabelText("Lohnabrechnungen als PDF auswählen"), { target: { files: [file] } });
}
async function openReplacement() {
  upload();
  return screen.findByRole("dialog", { name: "Gespeicherte Abrechnungen ersetzen?" });
}

describe("reviewed payslip confirmations with synthetic refreshed state", () => {
  it.each(["changed", "removed", "context changed"] as const)(
    "rejects deletion when the reviewed record is %s while the dialog is open", async (change) => {
      const view = render(element());
      const dialog = openDelete();
      fixture.state = { ...fixture.state, payslips: change === "removed" ? [] : [{
        ...january,
        ...(change === "changed" ? { regularGross: 3200 } : { payrollContextIssues: ["buag"] as Payslip["payrollContextIssues"] }),
      }] };
      const refreshed = structuredClone(fixture.state);
      view.rerender(element());
      fireEvent.click(within(dialog).getByRole("button", { name: "Entfernen" }));
      expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("erneut prüfen"));
      expect(fixture.state).toEqual(refreshed);
      expect(fixture.success).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Entfernen" }));
      expect(fixture.state).toEqual(refreshed);
      fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
      if (change !== "removed") {
        const freshDialog = openDelete();
        fireEvent.click(within(freshDialog).getByRole("button", { name: "Entfernen" }));
        await waitFor(() => expect(fixture.success).toHaveBeenCalledOnce());
        expect(fixture.state.payslips).toEqual([]);
      }
    },
  );

  it("compares deletion against actual callback state, not the latest rendered state", async () => {
    render(element());
    const dialog = openDelete();
    const refreshed = { ...fixture.state, payslips: [{ ...january, regularGross: 3200 }] };
    fixture.atUpdate = () => refreshed;
    fireEvent.click(within(dialog).getByRole("button", { name: "Entfernen" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("inzwischen geändert"));
    expect(fixture.state.payslips?.[0].regularGross).toBe(3200);
    expect(fixture.state.payrollForecasts).toEqual([forecast]);
    expect(fixture.state).toBe(refreshed);
    expect(fixture.success).not.toHaveBeenCalled();
  });

  it.each(["changed", "removed"] as const)(
    "rejects replacement of a %s reviewed record and permits it only after a new preview", async (change) => {
      const view = render(element());
      const dialog = await openReplacement();
      fixture.state = { ...fixture.state, payslips: change === "removed" ? [] : [{ ...january, regularGross: 3200 }] };
      const refreshed = structuredClone(fixture.state);
      view.rerender(element());
      fireEvent.click(within(dialog).getByRole("button", { name: "Abrechnungen ersetzen" }));
      expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("erneut hochladen"));
      expect(fixture.state).toEqual(refreshed);
      expect(fixture.success).not.toHaveBeenCalled();
      expect(fixture.imported).not.toHaveBeenCalled();
      fireEvent.click(within(dialog).getByRole("button", { name: "Abrechnungen ersetzen" }));
      expect(fixture.state).toEqual(refreshed);
      fireEvent.click(within(dialog).getByRole("button", { name: "Abbrechen" }));
      view.rerender(element());
      if (change === "changed") {
        const fresh = await openReplacement();
        fireEvent.click(within(fresh).getByRole("button", { name: "Abrechnungen ersetzen" }));
      } else {
        upload();
      }
      await waitFor(() => expect(fixture.success).toHaveBeenCalledOnce());
      expect(fixture.state.payslips).toEqual([correction]);
    },
  );

  it("rejects an entire replacement batch when an initially absent incoming month appeared before the callback", async () => {
    const february = { ...january, month: 2 };
    fixture.parse.mockResolvedValue({ drafts: [correction, february], issues: [] });
    render(element());
    const dialog = await openReplacement();
    const refreshed = { ...fixture.state, payslips: [january, { ...february, regularGross: 3400 }] };
    fixture.atUpdate = () => refreshed;
    fireEvent.click(within(dialog).getByRole("button", { name: "Abrechnungen ersetzen" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", expect.stringContaining("inzwischen geändert"));
    expect(fixture.state.payslips).toEqual([january, { ...february, regularGross: 3400 }]);
    expect(fixture.state.payrollForecasts).toEqual([forecast]);
    expect(fixture.state).toBe(refreshed);
    expect(fixture.imported).not.toHaveBeenCalled();
    expect(fixture.success).not.toHaveBeenCalled();
  });

  it("accepts an unchanged review and preserves unrelated refreshed records/forecasts", async () => {
    render(element());
    const dialog = await openReplacement();
    const other = { ...january, employer: "Anderer Betrieb", regularGross: 4200 };
    const otherForecast = { ...forecast, employer: other.employer };
    fixture.atUpdate = (state) => ({ ...state, payslips: [january, other], payrollForecasts: [forecast, otherForecast] });
    fireEvent.click(within(dialog).getByRole("button", { name: "Abrechnungen ersetzen" }));
    await waitFor(() => expect(fixture.success).toHaveBeenCalledOnce());
    expect(fixture.state.payslips).toEqual(expect.arrayContaining([correction, other]));
    expect(fixture.state.payrollForecasts).toEqual([{ ...forecast, standardPayrollConfirmed: false }, otherForecast]);
    expect(fixture.imported).toHaveBeenCalledWith(correction);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("does not invalidate forecasts when the imported records are already unchanged", async () => {
    fixture.parse.mockResolvedValue({ drafts: [january], issues: [] });
    render(element());
    const before = fixture.state;
    upload();
    await waitFor(() => expect(fixture.success).toHaveBeenCalledOnce());
    expect(fixture.state.payslips).toEqual([january]);
    expect(fixture.state.payrollForecasts).toEqual([forecast]);
    expect(fixture.state).toBe(before);
    expect(fixture.success).toHaveBeenCalledWith("Bereits vorhanden – nichts doppelt übernommen · 1 ohne eindeutiges Netto");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it.each([
    new PayslipMutationError("review rejected"),
    new ZodError([{ code: "custom", path: [], message: "invalid payslip" }]),
    new FinanceStorageError("storage rejected"),
  ])("keeps replacement mutation-free on a known dispatch rejection: %s", async (error) => {
    render(element());
    const dialog = await openReplacement();
    const before = structuredClone(fixture.state);
    fixture.update.mockImplementationOnce(() => { throw error; });
    fireEvent.click(within(dialog).getByRole("button", { name: "Abrechnungen ersetzen" }));
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", error.message);
    expect(fixture.state).toEqual(before);
    expect(fixture.success).not.toHaveBeenCalled();
    expect(fixture.imported).not.toHaveBeenCalled();
  });

  it("does not turn an unexpected replacement dispatch failure into a domain alert", async () => {
    render(element());
    const dialog = await openReplacement();
    const before = structuredClone(fixture.state);
    const unexpected = new TypeError("programmer failure");
    const failures: unknown[] = [];
    const capture = (event: ErrorEvent) => { failures.push(event.error); event.preventDefault(); };
    window.addEventListener("error", capture);
    try {
      fixture.update.mockImplementationOnce(() => { throw unexpected; });
      fireEvent.click(within(dialog).getByRole("button", { name: "Abrechnungen ersetzen" }));
      expect(failures).toEqual([unexpected]);
      expect(within(dialog).queryByRole("alert")).toBeNull();
      expect(fixture.state).toEqual(before);
      expect(fixture.success).not.toHaveBeenCalled();
      expect(fixture.imported).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("error", capture);
    }
  });

  it.each(["cancel", "escape", "close"] as const)("makes deletion %s mutation-free", (action) => {
    render(element());
    const dialog = openDelete();
    const before = structuredClone(fixture.state);
    if (action === "escape") fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    else fireEvent.click(within(dialog).getByRole("button", { name: action === "close" ? "Schließen" : "Abbrechen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.state).toEqual(before);
    expect(fixture.success).not.toHaveBeenCalled();
  });

  it.each(["cancel", "escape", "close"] as const)("makes replacement %s mutation-free", async (action) => {
    render(element());
    const dialog = await openReplacement();
    const before = structuredClone(fixture.state);
    if (action === "escape") fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    else fireEvent.click(within(dialog).getByRole("button", { name: action === "close" ? "Schließen" : "Abbrechen" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(fixture.update).not.toHaveBeenCalled();
    expect(fixture.state).toEqual(before);
    expect(fixture.imported).not.toHaveBeenCalled();
  });
});

it("delivers reducer rejections after commit without crashing or duplicate notifications in StrictMode", async () => {
  const applied = vi.fn();
  const rejected = vi.fn();
  function Harness() {
    const [state, dispatch] = useReducer((current: number, updater: (value: number) => number) => updater(current), 0);
    const [message, setMessage] = useState("");
    const mutate = usePayslipMutation(state, dispatch);
    return <><button onClick={() => mutate(() => { throw new PayslipMutationError("stale preview"); }, applied, (error) => {
      rejected(error.message);
      setMessage(error.message);
    })}>Confirm</button><p>{message}</p><output>{state}</output></>;
  }
  render(<StrictMode><Harness /></StrictMode>);
  act(() => fireEvent.click(screen.getByRole("button", { name: "Confirm" })));
  expect(await screen.findByText("stale preview")).toBeTruthy();
  expect(rejected).toHaveBeenCalledExactlyOnceWith("stale preview");
  expect(applied).not.toHaveBeenCalled();
  expect(screen.getByRole("status").textContent).toBe("0");
});

it("applies a rapidly repeated confirmation only once before its outcome is committed", async () => {
  const applied = vi.fn();
  function Harness() {
    const [state, dispatch] = useReducer((current: number, updater: (value: number) => number) => updater(current), 0);
    const mutate = usePayslipMutation(state, dispatch);
    return <><button onClick={() => mutate((current) => current + 1, applied, vi.fn())}>Confirm</button><output>{state}</output></>;
  }
  render(<StrictMode><Harness /></StrictMode>);
  act(() => {
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
  });
  await waitFor(() => expect(applied).toHaveBeenCalledOnce());
  expect(screen.getByRole("status").textContent).toBe("1");
});

it.each([
  new PayslipMutationError("review rejected"),
  new ZodError([{ code: "custom", path: [], message: "invalid payslip" }]),
  new FinanceStorageError("storage rejected"),
])("surfaces an explicit known callback rejection after commit: %s", (error) => {
  const applied = vi.fn();
  const rejected = vi.fn();
  const update = vi.fn((updater: (current: number) => number) => expect(updater(0)).toBe(0));
  const hook = renderHook(() => usePayslipMutation(0, update));
  act(() => hook.result.current(() => { throw error; }, applied, rejected));
  expect(rejected).toHaveBeenCalledExactlyOnceWith(error);
  expect(applied).not.toHaveBeenCalled();
});

it.each(["callback", "dispatch"] as const)("propagates an unexpected %s failure instead of reporting a domain rejection", (source) => {
  const unexpected = new TypeError("programmer failure");
  const applied = vi.fn();
  const rejected = vi.fn();
  const update = (updater: (current: number) => number) => {
    if (source === "dispatch") throw unexpected;
    return updater(0);
  };
  const hook = renderHook(() => usePayslipMutation(0, update));
  act(() => {
    expect(() => hook.result.current(() => { throw unexpected; }, applied, rejected)).toThrow(unexpected);
  });
  expect(rejected).not.toHaveBeenCalled();
  expect(applied).not.toHaveBeenCalled();
});

it("surfaces an explicit storage rejection from dispatch without suppressing other exceptions", () => {
  const error = new FinanceStorageError("storage rejected");
  const rejected = vi.fn();
  const hook = renderHook(() => usePayslipMutation(0, () => { throw error; }));
  act(() => hook.result.current((current) => current + 1, vi.fn(), rejected));
  expect(rejected).toHaveBeenCalledExactlyOnceWith(error);
});

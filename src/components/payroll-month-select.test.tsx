// @vitest-environment jsdom
import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, expect, it, vi } from "vitest";
import { PayrollMonthSelect, type PayrollMonthState } from "@/components/payroll-month-select";

beforeAll(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

const dotOf = (node: Element) => node.querySelector("[aria-hidden=true].rounded-full")?.className ?? "";
const visibleText = (node: Element) => {
  const copy = node.cloneNode(true) as Element;
  copy.querySelectorAll(".sr-only").forEach((hidden) => hidden.remove());
  return copy.textContent;
};

function Fixture({ states }: { states: Partial<Record<number, PayrollMonthState>> }) {
  const [month, setMonth] = useState(3);
  return (
    <>
      <label htmlFor="month">Monat</label>
      <PayrollMonthSelect id="month" value={month} states={states} onChange={setMonth} />
    </>
  );
}

it("lists all twelve months with a status dot and no visible status text", () => {
  render(<Fixture states={{ 1: "imported", 2: "review", 3: "imported" }} />);
  const trigger = screen.getByRole("combobox", { name: "Monat" });
  expect(trigger.textContent).toBe("März, importiert");
  expect(dotOf(trigger)).toContain("bg-success");
  expect(visibleText(trigger)).toBe("März");

  fireEvent.click(trigger);
  const options = screen.getAllByRole("option");
  expect(options.map((option) => option.textContent)).toEqual([
    "Jänner, importiert", "Februar, zur Prüfung", "März, importiert",
    ...["April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"].map((name) => `${name}, noch nicht importiert`),
  ]);
  expect(options.map(visibleText)).toEqual(["Jänner", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"]);
  expect(dotOf(options[1])).toContain("bg-warning");
  expect(dotOf(options[3])).toContain("bg-muted-foreground");
  expect(options[3].getAttribute("aria-disabled")).toBe("true");
  expect(options[2].dataset.state).toBe("checked");

  fireEvent.click(options[3]);
  expect(trigger.textContent).toBe("März, importiert");
  fireEvent.click(screen.getByRole("option", { name: "Februar, zur Prüfung" }));
  const changed = screen.getByRole("combobox", { name: "Monat" });
  expect(changed.textContent).toBe("Februar, zur Prüfung");
  expect(dotOf(changed)).toContain("bg-warning");
});

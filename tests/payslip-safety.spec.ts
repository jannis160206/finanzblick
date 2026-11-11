import { expect, test } from "@playwright/test";
import { build } from "esbuild";

let bundle: string;
const january = {
  year: 2026, month: 1, employer: "Musterbetrieb GmbH",
  regularGross: 3000, specialGross: 0, regularSv: 540, regularTax: 200,
  monthlyTaxableBase: 2460, baseSalary: 3000, monthlyPayroll: true, reportedSixth: 6000,
};

test.beforeAll(async () => {
  const result = await build({
    stdin: {
      contents: `
        import React, { StrictMode, useEffect, useReducer, useState } from "react";
        import { createRoot } from "react-dom/client";
        import { FixtureFinanceContext } from "@/components/finance-provider";
        import { PayslipSummary } from "@/components/payslip-summary";
        import { PayslipRemoveDialog } from "@/components/payslip-remove-dialog";
        import { PayslipUploadProvider } from "@/components/payslip-upload";
        import { createSeed } from "@/lib/seed";
        import { PayrollResults } from "@/components/payroll-results";
        import { payrollPresentation } from "@/components/payroll-presentation";
        import { parsePayslipPages } from "./src/lib/import/payslip";
        import { payslipSchema } from "@/lib/payslip-schema";
        import { positionedLine, syntheticContextPage } from "./tests/fixtures/payslip-context";
        const january = ${JSON.stringify(january)};
        // The payroll page removes a payslip from its month details; here the first stored payslip offers it.
        function Removal({ state }) {
          const [target, setTarget] = useState(null);
          const entry = state.payslips?.[0];
          return <>
            {entry && <button type="button" onClick={(event) => setTarget({ entry, trigger: event.currentTarget })}>Abrechnung entfernen: 1/2026</button>}
            <PayslipRemoveDialog target={target} onClose={() => setTarget(null)} />
          </>;
        }
        function Fixture() {
          const [state, update] = useReducer((current, updater) => updater(current), {
            ...createSeed(),
            payslips: [january],
            payrollForecasts: [{ year: 2026, employer: january.employer, standardPayrollConfirmed: true, months: [] }]
          });
          useEffect(() => {
            window.syntheticPayroll = {
              snapshot: () => structuredClone(state),
              refresh: () => update((current) => ({
                ...current, payslips: [{ ...january, regularGross: 3200 }]
              })),
              setContext: (context) => {
                const report = parsePayslipPages([syntheticContextPage(positionedLine(700,
                  [50, "Eintritt:01.01.2026"], [250, context]))]);
                const entry = payslipSchema.parse(JSON.parse(JSON.stringify(report.drafts[0])));
                update((current) => ({ ...current, payslips: [entry] }));
              }
            };
          }, [state]);
          return <FixtureFinanceContext.Provider value={{ state, update, storageError: null }}>
            <PayslipUploadProvider onImported={() => { window.imported = true; }}>
              <PayslipSummary />
              <Removal state={state} />
            </PayslipUploadProvider>
            <PayrollResults view={payrollPresentation(state.payslips, 2026, january.employer, "2026-05-01")} />
          </FixtureFinanceContext.Provider>;
        }
        window.successes = [];
        createRoot(document.getElementById("root")).render(<StrictMode><Fixture /></StrictMode>);
      `,
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "iife",
    platform: "browser",
    jsx: "automatic",
    // next/link reads build-time flags that Next inlines; the isolated bundle has no process object.
    define: { "process.env.NODE_ENV": '"test"', "process.env": "{}" },
    plugins: [{
      name: "synthetic-isolated-payroll",
      setup(builder) {
        builder.onResolve({ filter: /^@\/components\/finance-provider$/ }, () => ({ path: "finance", namespace: "fixture" }));
        builder.onResolve({ filter: /^@\/lib\/import\/payslip$/ }, () => ({ path: "parser", namespace: "fixture" }));
        builder.onResolve({ filter: /^sonner$/ }, () => ({ path: "toast", namespace: "fixture" }));
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, ({ path: value }) => ({
          resolveDir: process.cwd(),
          loader: "js",
          contents: value === "finance"
            ? `import { createContext, useContext } from "react"; export const FixtureFinanceContext = createContext(null); export const useFinance = () => useContext(FixtureFinanceContext);`
            : value === "parser"
              ? `export class PayslipPasswordError extends Error {} export async function parsePayslipPdf() { return ${JSON.stringify({ drafts: [{ ...january, regularGross: 3100 }], issues: [] })}; }`
              : `export const toast = { success: (message) => window.successes.push(message) };`,
        }));
      },
    }],
  });
  bundle = result.outputFiles[0].text;
});

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) => route.abort());
  await page.setContent("<html><body><div id='root'></div></body></html>");
  await page.addScriptTag({ content: bundle });
  await expect(page.getByRole("heading", { name: "1 Abrechnung übernommen" })).toBeVisible();
});

async function refresh(page: import("@playwright/test").Page) {
  await page.evaluate(() => {
    (window as unknown as { syntheticPayroll: { refresh: () => void } }).syntheticPayroll.refresh();
  });
  await page.waitForFunction(() => {
    const state = (window as unknown as { syntheticPayroll: { snapshot: () => { payslips: typeof january[] } } }).syntheticPayroll.snapshot();
    return state.payslips[0].regularGross === 3200;
  });
}

async function snapshot(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const fixture = window as unknown as { syntheticPayroll: { snapshot: () => unknown }; successes: string[]; imported?: boolean };
    return { state: fixture.syntheticPayroll.snapshot(), successes: fixture.successes, imported: fixture.imported ?? false };
  });
}

test("refreshed deletion rejects stale review; Escape, close and cancel are mutation-free", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.getByRole("button", { name: "Abrechnung entfernen: 1/2026" }).click();
  const dialog = page.getByRole("dialog", { name: "Lohnabrechnung entfernen?" });
  await refresh(page);
  const current = await snapshot(page);
  await dialog.getByRole("button", { name: "Entfernen", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("erneut prüfen");
  expect(await snapshot(page)).toEqual(current);
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
  for (const action of ["Schließen", "Abbrechen"]) {
    await page.getByRole("button", { name: "Abrechnung entfernen: 1/2026" }).click();
    await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await snapshot(page)).toEqual(current);
  }
  expect(errors).toEqual([]);
});

test("refreshed replacement rejects stale correction until a new preview", async ({ page }) => {
  const file = { name: "synthetic.pdf", mimeType: "application/pdf", buffer: Buffer.from("synthetic PDF only") };
  await page.getByLabel("Lohnabrechnungen als PDF auswählen").setInputFiles(file);
  const dialog = page.getByRole("dialog", { name: "Gespeicherte Abrechnungen ersetzen?" });
  await expect(dialog).toBeVisible();
  await refresh(page);
  const current = await snapshot(page);
  await dialog.getByRole("button", { name: "Abrechnungen ersetzen", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("erneut hochladen");
  expect(await snapshot(page)).toEqual(current);
  await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  for (const action of ["escape", "Schließen"]) {
    await page.getByLabel("Lohnabrechnungen als PDF auswählen").setInputFiles(file);
    await expect(dialog).toBeVisible();
    if (action === "escape") await page.keyboard.press("Escape");
    else await dialog.getByRole("button", { name: action, exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(await snapshot(page)).toEqual(current);
  }
  await page.getByLabel("Lohnabrechnungen als PDF auswählen").setInputFiles(file);
  await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "Abrechnungen ersetzen", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  const applied = await snapshot(page);
  expect(applied.imported).toBe(true);
  expect(applied.successes).toHaveLength(1);
  expect((applied.state as { payslips: typeof january[] }).payslips[0].regularGross).toBe(3100);
});

test("raw multi-column context keeps documentary sixth but removes net estimates", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await expect(page.getByText("Geschätzter Auszahlungsanteil netto")).toBeVisible();
  for (const [context, label] of [
    ["Dienstverhältnis:BUAG / BUAK", "BUAG/BUAK erkannt"],
    ["Dienstverhältnis:Lehrling", "Lehrverhältnis erkannt"],
    ["Austritt:31.01.2026", "Austritt angegeben"],
    ["Personengruppe:123", "Beschäftigungskontext unklar"],
    ["Beschäftigungsart:unleserlich", "Beschäftigungskontext unklar"],
  ]) {
    await page.evaluate((value) => {
      (window as unknown as { syntheticPayroll: { setContext: (context: string) => void } }).syntheticPayroll.setContext(value);
    }, context);
    const result = page.getByRole("region", { name: "Steuer nächste Sonderzahlung" });
    await expect(result.getByRole("status")).toContainText(label);
    await expect(result).toContainText("Steuer- und Nettoprognose nicht verfügbar");
    await expect(page.getByRole("region", { name: "Jahressechstel Abrechnungsstand" })).toContainText("6.000");
    await expect(page.getByText("Geschätzter Auszahlungsanteil netto")).toHaveCount(0);
    await expect(page.getByRole("spinbutton")).toHaveCount(0);
  }
  await page.evaluate(() => {
    (window as unknown as { syntheticPayroll: { setContext: (context: string) => void } })
      .syntheticPayroll.setContext("Personengruppe:Angestellter Austritt:-");
  });
  await expect(page.getByText("Geschätzter Auszahlungsanteil netto")).toBeVisible();
  await expect(page.getByRole("region", { name: "Jahressechstel Abrechnungsstand" })).toContainText("6.000");
  expect(errors).toEqual([]);
});

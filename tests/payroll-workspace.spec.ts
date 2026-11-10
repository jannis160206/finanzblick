import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { appStateSchema, type AppState } from "../src/lib/types";
import { analyzePayrollAutomatically } from "../src/lib/payroll-analysis";
import { payslipKey } from "../src/lib/payslip-schema";
import { currency, monthLabel } from "../src/lib/format";
import {
  payrollEmployer,
  otherPayrollEmployer,
  payrollFixture,
  syntheticPayslipPdf,
} from "./fixtures/payroll-state";

test.skip(
  process.env.PLAYWRIGHT_LOCAL_ADMIN !== "1",
  "Requires an isolated account database.",
);
test.use({ timezoneId: "Europe/Vienna" });
let cookies: Awaited<ReturnType<BrowserContext["cookies"]>> = [];
test.beforeAll(async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL });
  const page = await context.newPage();
  await page.goto("/login");
  await page.getByLabel("Benutzername", { exact: true }).fill("admin");
  await page
    .getByLabel("Passwort", { exact: true })
    .fill(process.env.FINANZBLICK_ADMIN_PASSWORD!);
  await page.getByRole("button", { name: "Anmelden", exact: true }).click();
  await expect(
    page.getByText("Synchronisiert", { exact: true }),
  ).toBeAttached();
  cookies = await context.cookies();
  await context.close();
});
async function snapshot(page: Page) {
  const session = await (await page.request.get("/api/auth/session")).json();
  const headers = {
    Origin: new URL(page.url()).origin,
    "X-Finanzblick-Account": session.user.id,
  };
  const response = await page.request.get("/api/finance", { headers });
  expect(response.status()).toBe(200);
  const data = await response.json();
  return {
    state: appStateSchema.parse(data.state),
    revision: data.revision,
    headers,
  };
}
async function unlock(page: Page) {
  const security = page.getByRole("button", {
    name: /^Sicherheitsmodus (aktivieren|deaktivieren)$/,
  });
  await expect(security).toBeEnabled();
  if ((await security.getAttribute("aria-pressed")) === "true")
    await security.click();
  await expect(
    page.getByRole("heading", { name: "Gehalt & Steuern", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Synchronisiert", { exact: true }),
  ).toBeAttached();
}
async function open(page: Page, state = payrollFixture()) {
  await page.clock.setFixedTime(new Date("2026-10-08T10:00:00Z"));
  await page.context().addCookies(cookies);
  await page.goto("/gehalt-steuern");
  await expect(
    page.getByText("Synchronisiert", { exact: true }),
  ).toBeAttached();
  const previous = await snapshot(page);
  const response = await page.request.put("/api/finance", {
    headers: previous.headers,
    data: { state, revision: previous.revision },
  });
  expect(response.status()).toBe(200);
  await page.reload();
  await unlock(page);
  return (await snapshot(page)).state;
}
async function noOverflow(page: Page) {
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
}
// The payslip-based Jahressechstel has its own card now; it must be visible without any disclosure.
async function details(page: Page) {
  await expect(
    page.getByRole("region", {
      name: "Jahressechstel Abrechnungsstand",
      exact: true,
    }),
  ).toBeVisible();
}
function monthTile(page: Page, month: string) {
  return page
    .getByRole("list", { name: "Monate 2026", exact: true })
    .getByRole("button", { name: new RegExp(`^${monthLabel(month)},`) });
}
async function field(page: Page, label: string, value: number | undefined) {
  const special = page.getByRole("region", {
    name: "Steuer nächste Sonderzahlung",
    exact: true,
  });
  await expect(
    special
      .locator("dl > div")
      .filter({ has: page.getByText(label, { exact: true }) })
      .locator("dd"),
  ).toHaveText(value === undefined ? "Noch offen" : currency(value));
}
async function modelValues(page: Page, state: AppState) {
  const model = analyzePayrollAutomatically(
    state.payslips ?? [],
    2026,
    payrollEmployer,
  );
  await details(page);
  await expect(
    page.getByRole("region", {
      name: "Jahressechstel Abrechnungsstand",
      exact: true,
    }),
  ).toContainText(model.actual ? currency(model.actual.sixth) : "Noch offen");
  const next = model.projections.find((entry) => entry.month === 11);
  await field(
    page,
    "Geschätzter Auszahlungsanteil netto",
    next?.tax?.netSpecial,
  );
  await field(page, "Geschätzte Lohnsteuer", next?.tax?.total);
  await field(
    page,
    "Mehr-/Mindersteuer durch Sechstelüberhang",
    next?.tax?.signedOverflowDelta,
  );
}
function pdf(gross = 4000) {
  return {
    name: "synthetic-payroll.pdf",
    mimeType: "application/pdf",
    buffer: syntheticPayslipPdf(10, gross),
  };
}

for (const width of [1440, 390, 320]) {
  test(`salary evidence, estimates, import access and readonly filters fit ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const state = await open(page);
    await modelValues(page, state);
    await expect(
      page.getByRole("group", { name: "Steuerbeispiel Zusatzprämie" }),
    ).not.toBeVisible();
    await expect(
      page.getByLabel("PDF-Passwort", { exact: true }),
    ).not.toBeVisible();
    await expect(
      page.getByRole("button", { name: "Abrechnungen hochladen", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "PDF auswählen", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("region", {
        name: monthLabel("2026-10"),
        exact: true,
      }),
    ).toHaveCount(0);
    await expect(monthTile(page, "2026-10")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    await noOverflow(page);
    await page.screenshot({
      path: testInfo.outputPath(`payroll-${width}-dark.png`),
      fullPage: true,
    });
    await page
      .getByRole("button", { name: "Farbschema wechseln", exact: true })
      .click();
    await expect(page.locator("html")).toHaveClass(/light/);
    await page.screenshot({
      path: testInfo.outputPath(`payroll-${width}-light.png`),
      fullPage: true,
    });
    const chooser = page.waitForEvent("filechooser");
    await page
      .getByRole("button", { name: "Abrechnungen hochladen", exact: true })
      .click();
    expect((await chooser).isMultiple()).toBe(true);
    const records = page.getByText("Gespeicherte Abrechnungen (9)", {
      exact: true,
    });
    await records.focus();
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("button", {
        name: "Abrechnung entfernen: 9/2026",
        exact: true,
      }),
    ).toBeVisible();
    await details(page);
    await page
      .getByRole("group", { name: "Steuerbeispiel", exact: true })
      .locator("summary")
      .click();
    await expect(
      page.getByRole("group", { name: "Steuerbeispiel Zusatzprämie" }),
    ).toBeVisible();
    await monthTile(page, "2026-10").click();
    await expect(monthTile(page, "2026-10")).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    await expect(
      page.getByRole("region", {
        name: monthLabel("2026-10"),
        exact: true,
      }),
    ).toBeVisible();
    await noOverflow(page);
    await page
      .getByLabel("Dienstverhältnis", { exact: true })
      .selectOption(otherPayrollEmployer);
    await details(page);
    await expect(
      page.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }),
    ).toContainText(currency(6000));
    await expect(
      page.getByText("Gespeicherte Abrechnungen (1)", { exact: true }),
    ).toBeVisible();
    await noOverflow(page);
    await page.getByLabel("Steuerjahr", { exact: true }).selectOption("2027");
    await expect(
      page.getByLabel("Dienstverhältnis", { exact: true }),
    ).toHaveValue(payrollEmployer);
    const special = page.getByRole("region", {
      name: "Steuer nächste Sonderzahlung",
    });
    await expect(special.getByText("Noch offen", { exact: true })).toHaveCount(
      3,
    );
    expect((await snapshot(page)).state).toEqual(state);
    expect(errors).toEqual([]);
  });
}

for (const width of [1440, 390]) {
  test(`real payroll PDF import, duplicate protection and confirmed removal work at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 1000 });
    const initial = await open(page);
    const importer = page.getByRole("region", {
      name: "Abrechnungen",
      exact: true,
    });
    const picker = page.getByLabel("Lohnabrechnungen als PDF auswählen", {
      exact: true,
    });
    await picker.setInputFiles(pdf());
    await expect(
      importer.getByText(/^1 Abrechnung\(en\) automatisch übernommen\./),
    ).toBeVisible();
    await expect(
      page.getByText("Synchronisiert", { exact: true }),
    ).toBeAttached();
    let saved = (await snapshot(page)).state;
    expect(saved.payslips).toHaveLength((initial.payslips?.length ?? 0) + 1);
    await modelValues(page, saved);
    await picker.setInputFiles(pdf());
    await expect(
      importer.getByText(
        /^Abrechnungen bereits vorhanden – nicht doppelt übernommen\./,
      ),
    ).toBeVisible();
    expect((await snapshot(page)).state.payslips).toEqual(saved.payslips);
    await picker.setInputFiles(pdf(4500));
    const replacement = page.getByRole("dialog", {
      name: "Gespeicherte Abrechnungen ersetzen?",
    });
    await expect(replacement).toBeVisible();
    await replacement
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    expect((await snapshot(page)).state.payslips).toEqual(saved.payslips);
    await picker.setInputFiles(pdf(4500));
    await replacement
      .getByRole("button", { name: "Abrechnungen ersetzen", exact: true })
      .click();
    await expect(replacement).toHaveCount(0);
    await expect(
      page.getByText("Synchronisiert", { exact: true }),
    ).toBeAttached();
    saved = (await snapshot(page)).state;
    expect(
      saved.payslips?.find((entry) => entry.year === 2026 && entry.month === 10)
        ?.regularGross,
    ).toBe(4500);
    await page.reload();
    await unlock(page);
    await page
      .getByText("Gespeicherte Abrechnungen (10)", { exact: true })
      .click();
    const trigger = page.getByRole("button", {
      name: "Abrechnung entfernen: 10/2026",
      exact: true,
    });
    await trigger.click();
    const deleting = page.getByRole("dialog", {
      name: "Lohnabrechnung entfernen?",
    });
    await deleting
      .getByRole("button", { name: "Abbrechen", exact: true })
      .click();
    await expect(trigger).toBeFocused();
    expect((await snapshot(page)).state.payslips).toEqual(saved.payslips);
    await trigger.click();
    await deleting
      .getByRole("button", { name: "Entfernen", exact: true })
      .click();
    await expect(deleting).toHaveCount(0);
    await expect(
      page.getByRole("region", {
        name: "Abrechnungen",
        exact: true,
      }),
    ).toBeFocused();
    await expect(
      page.getByText("Synchronisiert", { exact: true }),
    ).toBeAttached();
    const after = (await snapshot(page)).state;
    expect(after.payslips).toHaveLength(initial.payslips?.length ?? 0);
    expect(
      new Map(
        (after.payslips ?? []).map((entry) => [payslipKey(entry), entry]),
      ),
    ).toEqual(
      new Map(
        (initial.payslips ?? []).map((entry) => [payslipKey(entry), entry]),
      ),
    );
    expect(after.transactions).toEqual(initial.transactions);
    // The import wrote the net into the next month's income; removing the payslip leaves it untouched.
    // (Variable budgets of the current month may be filled in on reload independently of payroll.)
    const income = (rows: AppState["financeRows"]) =>
      rows.filter((row) => row.kind === "income");
    expect(income(after.financeRows)).toEqual(income(saved.financeRows));
    expect(after.savingsGoals).toEqual(initial.savingsGoals);
    await noOverflow(page);
  });
}

test("missing records and unresolved bonuses keep actual tax and net unknown at 320px", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  const fixture = payrollFixture();
  fixture.payslips = fixture.payslips?.filter(
    (entry) =>
      entry.employer !== payrollEmployer ||
      entry.year !== 2026 ||
      entry.month !== 2,
  );
  const state = await open(page, fixture);
  await expect(page.getByRole("status")).toContainText(
    "Fehlende Abrechnung: Februar 2026",
  );
  await modelValues(page, state);
  await noOverflow(page);
  const uncertain = payrollFixture();
  uncertain.payslips = uncertain.payslips?.map((entry) =>
    entry.employer === payrollEmployer &&
    entry.year === 2026 &&
    entry.month === 2
      ? { ...entry, unresolvedSixthBonus: 1000, specialSv: 141.2 }
      : entry,
  );
  const updated = await open(page, uncertain);
  await expect(page.getByRole("status")).toContainText(
    "Prämie erkannt, Sechstelzuordnung offen",
  );
  await modelValues(page, updated);
  await noOverflow(page);
});

test("empty years provide an accessible import entry without blank tax cards", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  const fixture = payrollFixture();
  fixture.payslips = [];
  const state = await open(page, fixture);
  await expect(
    page.getByText("Noch keine Lohnabrechnungen für 2026", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("region", { name: "Abrechnungen", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("PDF-Passwort", { exact: true })).toHaveCount(0);
  const chooser = page.waitForEvent("filechooser");
  await page
    .getByRole("button", { name: "Abrechnungen hochladen", exact: true })
    .click();
  expect((await chooser).isMultiple()).toBe(true);
  await page.getByLabel("Steuerjahr", { exact: true }).selectOption("2027");
  await expect(
    page.getByText("Noch keine Lohnabrechnungen für 2027", { exact: true }),
  ).toBeVisible();
  expect((await snapshot(page)).state).toEqual(state);
  await noOverflow(page);
});

test("large supported amounts fit 320px without overflowing result cards", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 1000 });
  const fixture = payrollFixture();
  fixture.payslips = [
    {
      year: 2026,
      month: 1,
      employer: payrollEmployer,
      monthlyPayroll: true,
      regularGross: 1_000_000_000,
      specialGross: 0,
      reportedSixth: 1_000_000_000,
    },
  ];
  await open(page, fixture);
  await details(page);
  await expect(
    page.getByRole("region", { name: "Jahressechstel Abrechnungsstand" }),
  ).toContainText(currency(1_000_000_000));
  await noOverflow(page);
  await monthTile(page, "2026-02").click();
  await expect(
    page.getByRole("region", { name: monthLabel("2026-02"), exact: true }),
  ).toBeVisible();
  await noOverflow(page);
});

for (const width of [1440, 390]) {
  test(`month tiles reveal January-based forecast values and highlight special payments at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 1000 });
    const fixture = payrollFixture();
    fixture.payslips = fixture.payslips?.filter((entry) =>
      entry.employer === payrollEmployer && entry.year === 2026 && entry.month === 1,
    );
    const state = await open(page, fixture);
    const model = analyzePayrollAutomatically(state.payslips ?? [], 2026, payrollEmployer);
    await expect(page.getByText("Berechnungsdetails, Annahmen & Quellen", { exact: true })).toHaveCount(0);
    const months = page.getByRole("list", { name: "Monate 2026", exact: true });
    await expect(months.getByRole("listitem")).toHaveCount(12);
    await expect(months.getByRole("button", { expanded: false })).toHaveCount(12);
    // Grid instead of a list: 6 tiles per row on desktop, 3 on phones.
    const tops = await months
      .getByRole("listitem")
      .evaluateAll((items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
    expect(tops.filter((top) => top === tops[0])).toHaveLength(width >= 1024 ? 6 : 3);
    let tile = monthTile(page, "2026-01");
    for (const month of model.forecast.months) {
      const period = `2026-${String(month.month).padStart(2, "0")}`;
      const label = monthLabel(period);
      tile = monthTile(page, period);
      await expect(tile).toContainText(month.specialGross > 0 ? "mit Sonderzahlung" : "geschätzt");
      await tile.focus();
      await page.keyboard.press("Enter");
      await expect(tile).toHaveAttribute("aria-expanded", "true");
      const card = page.getByRole("region", { name: label, exact: true });
      await expect(card).toBeVisible();
      await expect(card.getByLabel(`${label} Laufendes Brutto`, { exact: true })).toHaveText(currency(month.regularGross));
      await expect(card.getByLabel(`${label} Sonderzahlung`, { exact: true })).toHaveText(
        month.specialGross > 0 ? currency(month.specialGross) : "Keine geplant",
      );
      await expect(card.locator("header").getByText("Sonderzahlung", { exact: true })).toHaveCount(month.specialGross > 0 ? 1 : 0);
      const sixth = model.sixthEstimates.find((entry) => entry.month === month.month)!;
      await expect(card.getByLabel(`${label} Jahressechstel`, { exact: true })).toHaveText(currency(sixth.sixth));
      await noOverflow(page);
    }
    for (const theme of ["dark", "light"]) {
      await noOverflow(page);
      await page.screenshot({ path: testInfo.outputPath(`forecast-${width}-${theme}.png`), fullPage: true });
      if (theme === "dark") await page.getByRole("button", { name: "Farbschema wechseln", exact: true }).click();
    }
    expect((await snapshot(page)).state).toEqual(state);
    await page.getByRole("button", { name: "Monatsdetails schließen", exact: true }).click();
    await expect(page.getByRole("region", { name: monthLabel("2026-12"), exact: true })).toHaveCount(0);
    await expect(tile).toBeFocused();
    await expect(tile).toHaveAttribute("aria-expanded", "false");
  });
}

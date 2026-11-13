import { expect, test, type CDPSession, type Locator, type Page, type TestInfo } from "@playwright/test";
import { createSeed } from "../src/lib/seed";
import type { Transaction } from "../src/lib/types";

const viewports = [
  { width: 390, height: 844 },
  { width: 1280, height: 720 },
  { width: 844, height: 390 },
];
const booking: Transaction = {
  id: "bounds-booking", date: "2026-09-12", description: "Dropdown Beispiel",
  amount: -12, bank: "Revolut", pocket: null, category: "Shopping",
  categoryOverride: true, includeInPlan: true,
};

async function seed(page: Page) {
  const state = createSeed();
  state.settings.asOf = "2026-09-17";
  state.settings.baselineDate = "2026-09-01";
  state.transactions = [
    booking,
    { ...booking, id: "bounds-review", description: "Unbekannter Testhaendler", category: "Prüfen", categoryOverride: false },
  ];
  state.fixedReceipts = [];
  await page.clock.setFixedTime(new Date("2026-09-17T12:00:00Z"));
  await page.addInitScript((state) => {
    if (!localStorage.getItem("finanzdashboard.v1")) {
      localStorage.setItem("finanzdashboard.v1", JSON.stringify(state));
    }
  }, state);
  await page.goto("/umsaetze");
  await expect(page.getByRole("heading", { name: "Umsätze", exact: true })).toBeVisible();
}

type BrowserNode = {
  backendNodeId: number;
  attributes?: string[];
  children?: BrowserNode[];
  shadowRoots?: BrowserNode[];
  pseudoElements?: BrowserNode[];
};

function findPicker(node: BrowserNode): BrowserNode | undefined {
  if (node.attributes?.includes("picker(select)")) return node;
  for (const child of [...node.shadowRoots ?? [], ...node.children ?? [], ...node.pseudoElements ?? []]) {
    const picker = findPicker(child);
    if (picker) return picker;
  }
}

async function pickerBounds(cdp: CDPSession, select: Locator) {
  await select.evaluate((element) => element.setAttribute("data-bounds-probe", ""));
  const { root } = await cdp.send("DOM.getDocument", { depth: 0 });
  const { nodeId } = await cdp.send("DOM.querySelector", {
    nodeId: root.nodeId, selector: "select[data-bounds-probe]",
  });
  const { node } = await cdp.send("DOM.describeNode", { nodeId, depth: 3, pierce: true });
  const picker = findPicker(node)!;
  expect(picker, "Measure the real browser top-layer picker, not its closed select").toBeTruthy();
  const { model } = await cdp.send("DOM.getBoxModel", { backendNodeId: picker.backendNodeId });
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: picker.backendNodeId });
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function() { return { scrollHeight: this.scrollHeight, clientHeight: this.clientHeight, scrollTop: this.scrollTop }; }",
    returnByValue: true,
  });
  await select.evaluate((element) => element.removeAttribute("data-bounds-probe"));
  return {
    x: model.border[0], y: model.border[1],
    right: model.border[2], bottom: model.border[5],
    height: model.height,
    ...result.value as { scrollHeight: number; clientHeight: number; scrollTop: number },
  };
}

function expectBounds(box: { x: number; y: number; right: number; bottom: number }, page: Page) {
  const viewport = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.right).toBeLessThanOrEqual(viewport.width);
  expect(box.bottom).toBeLessThanOrEqual(viewport.height);
}

async function checkSelect(page: Page, cdp: CDPSession, select: Locator, testInfo: TestInfo, name: string) {
  const original = await select.inputValue();
  const choices = await select.locator("option:not(:disabled)").evaluateAll((options) =>
    options.map((option) => (option as HTMLOptionElement).value),
  );
  for (const [edge, value] of [["first", choices[0]], ["last", choices.at(-1)!]]) {
    await select.selectOption(value);
    await select.click();
    await expect.poll(() => select.evaluate((element) => element.matches(":open"))).toBe(true);
    const bounds = await pickerBounds(cdp, select);
    expectBounds(bounds, page);
    if (choices.length > 20) expect(bounds.scrollHeight).toBeGreaterThan(bounds.clientHeight);
    for (const [key, index] of [["Home", 0], ["End", choices.length - 1]] as const) {
      await page.keyboard.press(key);
      const option = select.locator("option:not(:disabled)").nth(index);
      const box = (await option.boundingBox())!;
      expect(box.y).toBeGreaterThanOrEqual(bounds.y);
      expect(box.y + box.height).toBeLessThanOrEqual(bounds.bottom);
    }
    await testInfo.attach(`${name}-${edge}-bounds`, { body: JSON.stringify(bounds), contentType: "application/json" });
    if (edge === "last") {
      await page.screenshot({ path: testInfo.outputPath(`${name.replaceAll("/", "-")}.png`) });
    }
    await page.keyboard.press("Escape");
    await expect.poll(() => select.evaluate((element) => element.matches(":open"))).toBe(false);
  }
  if (choices.includes(original)) await select.selectOption(original);
}

for (const viewport of viewports) {
  test(`native dropdowns scroll down and back up with the mouse wheel at ${viewport.width}x${viewport.height}`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await seed(page);
    const cdp = await context.newCDPSession(page);
    async function scrollSearch(trigger: Locator) {
      await trigger.click();
      const list = page.getByRole("listbox", { name: "Kategorien", exact: true });
      await expect(list).toBeVisible();
      const box = (await list.boundingBox())!;
      const windowY = await page.evaluate(() => scrollY);
      const dialogBody = page.locator('[data-slot="dialog-body"]:visible');
      const bodyY = await dialogBody.count() ? await dialogBody.evaluate((element) => element.scrollTop) : undefined;
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.wheel(0, 600);
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(300);
      await page.mouse.wheel(0, -1200);
      await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => scrollY)).toBe(windowY);
      if (bodyY !== undefined) expect(await dialogBody.evaluate((element) => element.scrollTop)).toBe(bodyY);
      await page.keyboard.press("Escape");
      await expect(list).toHaveCount(0);
    }
    async function scrollBothWays(select: Locator) {
      await select.click();
      await expect.poll(() => select.evaluate((element) => element.matches(":open"))).toBe(true);
      await page.keyboard.press("Home");
      const bounds = await pickerBounds(cdp, select);
      const windowY = await page.evaluate(() => scrollY);
      const dialogBody = page.locator('[data-slot="dialog-body"]:visible');
      const bodyY = await dialogBody.count() ? await dialogBody.evaluate((element) => element.scrollTop) : undefined;
      await page.mouse.move((bounds.x + bounds.right) / 2, (bounds.y + bounds.bottom) / 2);
      for (let cycle = 0; cycle < 2; cycle++) {
        await page.mouse.wheel(0, 600);
        await expect.poll(async () => (await pickerBounds(cdp, select)).scrollTop).toBeGreaterThan(300);
        await page.mouse.wheel(0, -1200);
        await expect.poll(async () => (await pickerBounds(cdp, select)).scrollTop).toBeLessThanOrEqual(1);
      }
      for (const delta of [1800, 1200, 600, 300, 100]) await page.mouse.wheel(0, delta);
      const maxScroll = bounds.scrollHeight - bounds.clientHeight;
      await expect.poll(async () => (await pickerBounds(cdp, select)).scrollTop).toBeGreaterThanOrEqual(maxScroll - 1);
      await page.mouse.wheel(0, -300);
      await expect.poll(async () => (await pickerBounds(cdp, select)).scrollTop).toBeLessThan(maxScroll - 100);
      await page.mouse.wheel(0, -bounds.scrollHeight);
      await expect.poll(async () => (await pickerBounds(cdp, select)).scrollTop).toBeLessThanOrEqual(1);
      expect(await page.evaluate(() => scrollY)).toBe(windowY);
      if (bodyY !== undefined) expect(await dialogBody.evaluate((element) => element.scrollTop)).toBe(bodyY);
      await page.keyboard.press("Escape");
    }
    await scrollBothWays(page.getByLabel("Kategorie filtern", { exact: true }));
    await scrollSearch(page.getByRole("button", { name: "Kategorien durchsuchen", exact: true }));
    await page.getByRole("button", { name: /^Zuordnung prüfen/ }).click();
    let dialog = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
    await scrollBothWays(dialog.getByLabel("Kategorie", { exact: true }).first());
    await scrollSearch(dialog.getByRole("button", { name: "Kategorie durchsuchen", exact: true }).first());
    await dialog.getByRole("button", { name: "Prüfung schließen", exact: true }).click();
    await page.getByRole("button", { name: "Zuordnung ändern: Dropdown Beispiel", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Zuordnung ändern", exact: true });
    await scrollBothWays(dialog.getByLabel("Kategorie", { exact: true }));
    await scrollSearch(dialog.getByRole("button", { name: "Kategorie durchsuchen", exact: true }));
    await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
  });

  test(`all native dropdown surfaces stay bounded at ${viewport.width}x${viewport.height}`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport);
    await seed(page);
    expect(await page.evaluate(() => CSS.supports("appearance", "base-select"))).toBe(true);
    const cdp = await context.newCDPSession(page);
    for (const label of ["Monat filtern", "Konto/Pocket filtern", "Kategorie filtern"]) {
      await checkSelect(page, cdp, page.getByLabel(label, { exact: true }), testInfo, label);
    }
    await page.getByRole("button", { name: "Zuordnung ändern: Dropdown Beispiel", exact: true }).click();
    let dialog = page.getByRole("dialog", { name: "Zuordnung ändern", exact: true });
    await checkSelect(page, cdp, dialog.getByLabel("Kategorie", { exact: true }), testInfo, "edit-category");
    await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await page.getByRole("button", { name: /^Zuordnung prüfen/ }).click();
    dialog = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
    await checkSelect(page, cdp, dialog.getByLabel("Kategorie", { exact: true }).first(), testInfo, "review-category");
    await dialog.getByRole("button", { name: "Prüfung schließen", exact: true }).click();
    await page.goto("/monate");
    await page.getByRole("button", { name: "Plan bearbeiten", exact: true }).click();
    await page.getByRole("button", { name: "Position hinzufügen", exact: true }).click();
    dialog = page.getByRole("dialog", { name: "Position hinzufügen", exact: true });
    for (const label of ["Bereich", "Kategorie / Planverknüpfung"]) {
      await checkSelect(page, cdp, dialog.getByLabel(label, { exact: true }), testInfo, label.replaceAll("/", "-"));
    }
    await dialog.getByRole("button", { name: "Abbrechen", exact: true }).click();
    await page.goto("/pockets");
    await page.getByText("Round-ups", { exact: true }).first().click();
    await checkSelect(page, cdp, page.getByLabel("Round-up Jahr", { exact: true }), testInfo, "round-up");
  });

  test(`category picker fits viewport edges with selected last option at ${viewport.width}x${viewport.height}`, async ({ page, context }, testInfo) => {
    await page.setViewportSize(viewport);
    await seed(page);
    const cdp = await context.newCDPSession(page);
    const select = page.getByLabel("Kategorie filtern", { exact: true });
    for (const edge of ["top", "bottom"]) {
      await select.evaluate((element, edge) => {
        element.style.cssText = `position:fixed;z-index:80;left:16px;width:min(300px,calc(100vw - 32px));${edge}:8px`;
      }, edge);
      await checkSelect(page, cdp, select, testInfo, `viewport-${edge}`);
    }
  });

  test(`Radix search, filter and action menus remain bounded at ${viewport.width}x${viewport.height}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await seed(page);
    for (const [name, surface] of [
      ["Kategorien durchsuchen", '[data-slot="popover-content"]'],
      ["Weitere Filter", '[data-slot="dialog-content"]'],
      ["Weitere Aktionen: Dropdown Beispiel", '[data-slot="dialog-content"]'],
    ]) {
      const trigger = page.getByRole("button", { name, exact: true });
      for (const edge of ["top", "bottom"]) {
        await trigger.evaluate((element, edge) => {
          element.style.cssText = `position:fixed;z-index:80;right:16px;${edge}:8px`;
        }, edge);
        await trigger.click();
        const content = page.locator(surface);
        await expect(content).toBeVisible();
        await expect.poll(async () => {
          const box = (await content.boundingBox())!;
          return box.y >= 0 && box.y + box.height <= viewport.height;
        }).toBe(true);
        const box = (await content.boundingBox())!;
        expectBounds({ ...box, right: box.x + box.width, bottom: box.y + box.height }, page);
        if (name === "Kategorien durchsuchen") {
          const search = page.getByRole("combobox", { name: "Kategorien suchen", exact: true });
          await search.press("ArrowUp");
          await expect(page.getByRole("option", { name: "Prüfen", exact: true }).filter({ visible: true })).toBeInViewport();
          await search.press("ArrowDown");
          await expect(page.getByRole("option", { name: "Alle Kategorien", exact: true }).filter({ visible: true })).toBeInViewport();
        }
        await testInfo.attach(`${name}-${edge}-bounds`, { body: JSON.stringify(box), contentType: "application/json" });
        await page.screenshot({ path: testInfo.outputPath(`${name.replaceAll(":", "")}-${edge}.png`) });
        await page.keyboard.press("Escape");
        await expect(content).toHaveCount(0);
        await expect(trigger).toBeFocused();
      }
      await trigger.evaluate((element) => element.removeAttribute("style"));
    }
  });
}

test("touch swipes scroll native and searchable dropdowns in both directions inside a dialog", async ({ page, context }) => {
  await page.setViewportSize(viewports[0]);
  await seed(page);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
  await page.getByRole("button", { name: /^Zuordnung prüfen/ }).click();
  const dialog = page.getByRole("dialog", { name: "Kontoauszüge prüfen", exact: true });
  const select = dialog.getByLabel("Kategorie", { exact: true }).first();
  await select.click();
  await expect.poll(() => select.evaluate((element) => element.matches(":open"))).toBe(true);
  await page.keyboard.press("Home");
  const bounds = await pickerBounds(cdp, select);
  const body = dialog.locator('[data-slot="dialog-body"]');
  const bodyY = await body.evaluate((element) => element.scrollTop);
  async function swipe(box: { x: number; y: number; width: number; height: number }, upward: boolean) {
    const x = box.x + box.width / 2;
    const startY = box.y + box.height * (upward ? 0.2 : 0.8);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart", touchPoints: [{ x, y: startY }],
    });
    for (let step = 1; step <= 10; step++) {
      await cdp.send("Input.dispatchTouchEvent", {
        type: "touchMove",
        touchPoints: [{ x, y: startY + box.height * (upward ? 0.6 : -0.6) * step / 10 }],
      });
    }
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  const nativeBox = { ...bounds, width: bounds.right - bounds.x };
  await swipe(nativeBox, false);
  await expect.poll(async () => (await pickerBounds(cdp, select)).scrollTop).toBeGreaterThan(50);
  const down = (await pickerBounds(cdp, select)).scrollTop;
  await swipe(nativeBox, true);
  await expect.poll(async () => (await pickerBounds(cdp, select)).scrollTop).toBeLessThan(down - 50);
  await page.keyboard.press("Escape");
  await dialog.getByRole("button", { name: "Kategorie durchsuchen", exact: true }).first().click();
  const list = page.getByRole("listbox", { name: "Kategorien", exact: true });
  const box = (await list.boundingBox())!;
  await swipe(box, false);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeGreaterThan(50);
  const listDown = await list.evaluate((element) => element.scrollTop);
  await swipe(box, true);
  await expect.poll(() => list.evaluate((element) => element.scrollTop)).toBeLessThan(listDown - 50);
  expect(await body.evaluate((element) => element.scrollTop)).toBe(bodyY);
});

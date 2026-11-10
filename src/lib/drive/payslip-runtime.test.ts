import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { syntheticPayslipPdf } from "../../../tests/fixtures/payroll-state";
import { PayslipReadError, readPayslipInChild } from "./payslip-runtime";

let directory: string;
beforeAll(async () => { directory = await mkdtemp(join(tmpdir(), "finanzblick-payslip-child-")); });
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

it("reads protected payslips in an isolated process, only with the right password", async () => {
  const pdf = syntheticPayslipPdf(10, 4000, "synthetisch-123");
  const path = join(directory, "lohnzettel.pdf");
  await writeFile(path, pdf);
  expect(await readPayslipInChild(path, pdf.byteLength, [])).toEqual({ status: "locked" });
  expect(await readPayslipInChild(path, pdf.byteLength, ["falsch"])).toEqual({ status: "locked" });
  const opened = await readPayslipInChild(path, pdf.byteLength, ["falsch", "synthetisch-123"]);
  expect(opened.status).toBe("ok");
  expect(opened.status === "ok" && opened.result.drafts).toEqual([expect.objectContaining({ year: 2026, month: 10, regularGross: 4000 })]);
}, 60_000);

it("rejects changed or broken files with a readable message", async () => {
  const path = join(directory, "kaputt.pdf");
  await writeFile(path, "%PDF-1.4 kaputt");
  await expect(readPayslipInChild(path, 999, [])).rejects.toThrow("Datei wurde verändert oder ist beschädigt.");
  await expect(readPayslipInChild(path, 15, [])).rejects.toBeInstanceOf(PayslipReadError);
}, 60_000);

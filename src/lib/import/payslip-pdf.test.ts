import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parsePayslipPdf, PayslipPasswordError } from "./payslip";

const pdfjs = vi.hoisted(() => ({
  getDocument: vi.fn(),
  GlobalWorkerOptions: { workerSrc: "" },
}));
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", () => pdfjs);

const pdfBuffer = () => new TextEncoder().encode("%PDF-1.7\nsynthetic fixture only").buffer;
const item = (x: number, y: number, str: string) => ({
  str, transform: [1, 0, 0, 1, x, y], width: str.length * 4,
});
const content = () => ({ items: [
  item(50, 800, "Gehaltsabrechnung Jänner 2026"),
  item(50, 760, "Fabelwald Robotik GmbH"),
  item(290, 550, "LSt-Tg"), item(350, 550, "SV-Tg"),
  item(298, 538, "30"), item(358, 538, "30"),
  item(54, 510, "LA-Nr."), item(89, 510, "Bezeichnung"), item(254, 510, "Menge"),
  item(329, 510, "Satz"), item(392, 510, "Betrag"), item(455, 510, "BMG SV"), item(526, 510, "BMG LSt"),
  item(54, 490, "1000"), item(89, 490.5, "Gehalt"), item(379, 489.5, "2.810,20"),
  item(451, 490, "2.810,20"), item(525, 490, "2.810,20"),
  item(89, 470, "Brutto"), item(379, 470, "2.810,20"),
] });

function loading(options: {
  pages?: number; text?: ReturnType<typeof content>; failure?: unknown;
  pending?: boolean; textFailure?: unknown; textPending?: boolean; cleanupFailure?: boolean;
} = {}) {
  const cleanup = vi.fn();
  const getTextContent = options.textPending
    ? vi.fn(() => new Promise<ReturnType<typeof content>>(() => {}))
    : options.textFailure
      ? vi.fn().mockRejectedValue(options.textFailure)
      : vi.fn().mockResolvedValue(options.text ?? content());
  const getPage = vi.fn().mockResolvedValue({ getTextContent, cleanup });
  const document = { numPages: options.pages ?? 1, getPage };
  const destroy = options.cleanupFailure
    ? vi.fn().mockRejectedValue(new Error("private cleanup detail"))
    : vi.fn().mockResolvedValue(undefined);
  pdfjs.getDocument.mockImplementation(() => ({
    promise: options.pending ? new Promise(() => {})
      : options.failure ? Promise.reject(options.failure) : Promise.resolve(document),
    destroy,
  }));
  return { document, getPage, getTextContent, cleanup, destroy };
}

beforeEach(() => {
  vi.clearAllMocks();
  pdfjs.GlobalWorkerOptions.workerSrc = "";
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("local encrypted payslip PDF lifecycle", () => {
  it("copies input before PDF.js transfers it, preserving the caller's ArrayBuffer", async () => {
    const original = pdfBuffer();
    const originalLength = original.byteLength;
    const state = loading();
    const mocked = pdfjs.getDocument.getMockImplementation()!;
    pdfjs.getDocument.mockImplementation((options) => {
      expect(options.data.buffer).not.toBe(original);
      expect([...options.data]).toEqual([...new Uint8Array(original)]);
      structuredClone(options.data, { transfer: [options.data.buffer] });
      return mocked(options);
    });
    const result = await parsePayslipPdf(original);
    expect(original.byteLength).toBe(originalLength);
    expect(result.drafts[0]).toMatchObject({ regularGross: 2810.2, specialGross: 0 });
    expect(state.destroy).toHaveBeenCalledOnce();
    expect(state.cleanup).toHaveBeenCalledOnce();
  });

  it("passes only an in-memory synthetic password and stores no password/text in results", async () => {
    const state = loading();
    const password = "synthetic-test-password";
    const result = await parsePayslipPdf(pdfBuffer(), password);
    expect(pdfjs.getDocument).toHaveBeenCalledWith(expect.objectContaining({
      password, isEvalSupported: false, stopAtErrors: true, verbosity: 0,
    }));
    expect(JSON.stringify(result)).not.toContain(password);
    expect(JSON.stringify(result)).not.toContain("Gehaltsabrechnung");
    expect(state.destroy).toHaveBeenCalledOnce();
  });

  it.each([
    [1, "password-required", /Passwort eingeben/],
    [2, "wrong-password", /nicht richtig/],
  ] as const)("maps PDF.js password response %s and destroys even a rejected loading task", async (code, expected, message) => {
    const state = loading({ failure: { name: "PasswordException", code, message: "sensitive PDF internals" } });
    const result = parsePayslipPdf(pdfBuffer(), code === 2 ? "deliberately-wrong-synthetic" : undefined);
    await expect(result).rejects.toBeInstanceOf(PayslipPasswordError);
    await expect(result).rejects.toMatchObject({ code: expected, message: expect.stringMatching(message) });
    expect(state.destroy).toHaveBeenCalledOnce();
    expect(state.getPage).not.toHaveBeenCalled();
  });

  it("uses the same-origin browser worker endpoint", async () => {
    vi.stubGlobal("window", {});
    loading();
    await parsePayslipPdf(pdfBuffer());
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("/api/pdf-worker");
  });

  it("does not force the browser worker path in Node", async () => {
    loading();
    await parsePayslipPdf(pdfBuffer());
    expect(pdfjs.GlobalWorkerOptions.workerSrc).toBe("");
  });

  it("rejects invalid signatures and oversize input before PDF.js is called", async () => {
    await expect(parsePayslipPdf(new TextEncoder().encode("not a PDF").buffer)).rejects.toThrow(/Signatur/);
    await expect(parsePayslipPdf(new ArrayBuffer(20 * 1024 * 1024 + 1))).rejects.toThrow(/20 MB/);
    expect(pdfjs.getDocument).not.toHaveBeenCalled();
  });

  it("reports damaged PDFs generically without exposing internal text", async () => {
    const state = loading({ failure: new Error("private extracted content") });
    const result = parsePayslipPdf(pdfBuffer());
    await expect(result).rejects.toThrow(/beschädigt/);
    await expect(result).rejects.not.toThrow(/private extracted/);
    expect(state.destroy).toHaveBeenCalledOnce();
  });

  it("also maps synchronous document-loading failures", async () => {
    pdfjs.getDocument.mockImplementation(() => { throw new Error("sensitive synchronous failure"); });
    await expect(parsePayslipPdf(pdfBuffer())).rejects.toThrow(/beschädigt/);
  });

  it("rejects scanned PDFs and cleans up the page and document", async () => {
    const state = loading({ text: { items: [] } });
    await expect(parsePayslipPdf(pdfBuffer())).rejects.toThrow(/Gescannte/);
    expect(state.cleanup).toHaveBeenCalledOnce();
    expect(state.destroy).toHaveBeenCalledOnce();
  });

  it("rejects unrelated PDFs instead of returning an empty success", async () => {
    const state = loading({ text: { items: [item(10, 10, "An unrelated private document")] } });
    await expect(parsePayslipPdf(pdfBuffer())).rejects.toThrow(/Keine unterstützte/);
    expect(state.destroy).toHaveBeenCalledOnce();
  });

  it("rejects excessive page counts without extracting pages", async () => {
    const state = loading({ pages: 101 });
    await expect(parsePayslipPdf(pdfBuffer())).rejects.toThrow(/100 Seiten/);
    expect(state.getPage).not.toHaveBeenCalled();
    expect(state.destroy).toHaveBeenCalledOnce();
  });

  it("rejects excessive per-page text and item counts", async () => {
    const text = loading({ text: { items: [item(10, 10, "x".repeat(100_001))] } });
    await expect(parsePayslipPdf(pdfBuffer())).rejects.toThrow(/zu viel Text/);
    expect(text.cleanup).toHaveBeenCalledOnce();
    expect(text.destroy).toHaveBeenCalledOnce();
    const items = loading({ text: { items: Array.from({ length: 10_001 }, () => item(10, 10, "x")) } });
    await expect(parsePayslipPdf(pdfBuffer())).rejects.toThrow(/zu viele Textelemente/);
    expect(items.cleanup).toHaveBeenCalledOnce();
    expect(items.destroy).toHaveBeenCalledOnce();
  });

  it("limits total extracted text across pages", async () => {
    const state = loading({ pages: 11, text: { items: [item(10, 10, "x".repeat(95_000))] } });
    await expect(parsePayslipPdf(pdfBuffer())).rejects.toThrow(/zu viel Text/);
    expect(state.destroy).toHaveBeenCalledOnce();
  });

  it("cleans up when text extraction fails", async () => {
    const state = loading({ textFailure: new Error("private font details") });
    await expect(parsePayslipPdf(pdfBuffer())).rejects.toThrow(/beschädigt/);
    expect(state.cleanup).toHaveBeenCalledOnce();
    expect(state.destroy).toHaveBeenCalledOnce();
  });

  it("times out a stuck encrypted loading task and destroys it", async () => {
    vi.useFakeTimers();
    const state = loading({ pending: true });
    const result = expect(parsePayslipPdf(pdfBuffer())).rejects.toThrow(/zu lange/);
    await vi.advanceTimersByTimeAsync(10_001);
    await result;
    expect(state.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("times out stuck page text extraction and releases page resources", async () => {
    vi.useFakeTimers();
    const state = loading({ textPending: true });
    const result = expect(parsePayslipPdf(pdfBuffer())).rejects.toThrow(/zu lange/);
    await vi.advanceTimersByTimeAsync(10_001);
    await result;
    expect(state.cleanup).toHaveBeenCalledOnce();
    expect(state.destroy).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a password failure useful even when cleanup also rejects", async () => {
    const state = loading({
      failure: { name: "PasswordException", code: 2 }, cleanupFailure: true,
    });
    await expect(parsePayslipPdf(pdfBuffer(), "wrong-synthetic")).rejects.toMatchObject({ code: "wrong-password" });
    expect(state.destroy).toHaveBeenCalledOnce();
  });

  it("never reports success after failed cleanup", async () => {
    loading({ cleanupFailure: true });
    await expect(parsePayslipPdf(pdfBuffer())).rejects.toThrow(/nicht sauber beendet/);
  });
});

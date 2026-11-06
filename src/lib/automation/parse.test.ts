import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import ExcelJS from "exceljs";
import sharp from "sharp";
import { createWorker } from "tesseract.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMPORT_BYTES } from "../import/limits";
import { parseAmexText } from "../import/amex-pdf";
import { parseStatementCsv } from "../import/statements";
import {
  getServerOcrOptions,
  parseServerStatement,
  SERVER_PARSE_LIMITS,
} from "./parse";

vi.mock("tesseract.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("tesseract.js")>();
  return { ...actual, createWorker: vi.fn(actual.createWorker) };
});
vi.mock("pdfjs-dist/legacy/build/pdf.mjs", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("pdfjs-dist/legacy/build/pdf.mjs")>();
  return { ...actual, getDocument: vi.fn(actual.getDocument) };
});

const fixture = (name: string) =>
  readFileSync(new URL(`../import/fixtures/${name}`, import.meta.url));
const encode = (text: string) => new TextEncoder().encode(text);
const pdfHeader = () => encode("%PDF-1.7\nsynthetic fixture");
const createWorkerMock = vi.mocked(createWorker);

async function blankImage(format: "png" | "jpeg" | "webp" = "png") {
  return sharp({
    create: { width: 400, height: 200, channels: 3, background: "#fff" },
  })
    .toFormat(format)
    .toBuffer();
}

function fakeOcrWorker() {
  return {
    reinitialize: vi.fn().mockResolvedValue({}),
    setParameters: vi.fn().mockResolvedValue({}),
    recognize: vi
      .fn()
      .mockResolvedValue({ data: { text: "", blocks: [], confidence: 100 } }),
    terminate: vi.fn().mockResolvedValue({}),
  };
}

function textPdf(pages: string[]): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${pages.map((_, i) => `${4 + i * 2} 0 R`).join(" ")}] /Count ${pages.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  for (let i = 0; i < pages.length; i++) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    const stream = `BT /F1 10 Tf 14 TL 30 750 Td ${pages[i]
      .split("\n")
      .map((line) => `(${line.replace(/[\\()]/g, "\\$&")}) Tj T*`)
      .join("\n")} ET`;
    objects.push(
      `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}\nendstream`,
    );
  }
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "latin1"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const start = Buffer.byteLength(pdf, "latin1");
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("")}`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${start}\n%%EOF\n`;
  return Buffer.from(pdf, "latin1");
}

async function fakePdf(
  options: { pages?: number; failure?: Error; textFailure?: Error } = {},
) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const cleanup = vi.fn();
  const getTextContent = options.textFailure
    ? vi.fn().mockRejectedValue(options.textFailure)
    : vi.fn().mockResolvedValue({ items: [] });
  const getPage = vi.fn().mockResolvedValue({ getTextContent, cleanup });
  const destroy = vi.fn().mockResolvedValue(undefined);
  vi.mocked(pdfjs.getDocument).mockReturnValue({
    promise: options.failure
      ? Promise.reject(options.failure)
      : Promise.resolve({ numPages: options.pages ?? 1, getPage }),
    destroy,
  } as unknown as ReturnType<typeof pdfjs.getDocument>);
  return { cleanup, destroy, getPage };
}

beforeEach(() => vi.clearAllMocks());
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("server statement parsing", () => {
  it.each(["raiffeisen", "revolut", "amex"])(
    "preserves existing %s CSV results and sliced buffers",
    async (name) => {
      const bytes = fixture(`${name}.csv`);
      const padded = Buffer.concat([
        encode("not part of the file"),
        bytes,
        encode("neither is this"),
      ]);
      const input = padded.subarray(20, 20 + bytes.length);
      const result = await parseServerStatement(input, `${name}.CSV`);
      const expected = parseStatementCsv(bytes.toString("utf8"), `${name}.CSV`);
      expect(result).toEqual({
        ...expected,
        rows: expected.rows.map((row) => ({ ...row, id: expect.any(String) })),
        issues: expected.issues.map((issue) => ({
          ...issue,
          ...(issue.draft
            ? { draft: { ...issue.draft, id: expect.any(String) } }
            : {}),
        })),
      });
      expect(input.length).toBe(bytes.length);
    },
  );

  it("parses XLSX in Node without a browser File", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Raiffeisen");
    sheet.addRow(["Buchungsdatum", "Verwendungszweck/Text", "Betrag"]);
    sheet.addRow(["12.09.2026", "BIPA", "-4,50"]);
    const result = await parseServerStatement(
      new Uint8Array(await workbook.xlsx.writeBuffer()),
      "statement.xlsx",
    );
    expect(result.source).toBe("Raiffeisen");
    expect(result.rows).toMatchObject([
      { date: "2026-09-12", amount: -4.5, description: "BIPA" },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("surfaces malformed CSV and XLSX errors instead of trying OCR", async () => {
    await expect(
      parseServerStatement(encode('Datum;Betrag\n"not closed'), "bad.csv"),
    ).rejects.toThrow("Anführungszeichen");
    await expect(
      parseServerStatement(encode("not a workbook"), "bad.xlsx"),
    ).rejects.toThrow("XLSX-Datei");
    expect(createWorkerMock).not.toHaveBeenCalled();
  });

  it("rejects oversized, empty and unsupported files before loading parsers", async () => {
    await expect(
      parseServerStatement(new Uint8Array(MAX_IMPORT_BYTES + 1), "large.csv"),
    ).rejects.toThrow("20 MB");
    await expect(
      parseServerStatement(new Uint8Array(), "empty.csv"),
    ).rejects.toThrow("leer");
    await expect(
      parseServerStatement(encode("hello"), "file.html"),
    ).rejects.toThrow(/format/i);
    await expect(
      parseServerStatement(encode("hello"), "fake.pdf"),
    ).rejects.toThrow("PDF-Signatur");
    expect(createWorkerMock).not.toHaveBeenCalled();
  });

  it("extracts a real PDF page by page and reuses the text fixture parser without networking", async () => {
    const fetch = vi.fn(() => {
      throw new Error("Network disabled");
    });
    vi.stubGlobal("fetch", fetch);
    const text = fixture("precise-amex.txt").toString("utf8");
    const bytes = textPdf([text, ""]);
    const original = Buffer.from(bytes);
    const result = await parseServerStatement(bytes, "statement.pdf");
    const expected = parseAmexText([text], "statement.pdf");
    expect(result.rows).toEqual(
      expected.rows.map((row) => ({ ...row, id: expect.any(String) })),
    );
    expect(result.issues).toEqual(expected.issues);
    expect(result.skipped).toBe(expected.skipped);
    expect(result.rows).toHaveLength(2);
    expect(bytes).toEqual(original);
    expect(fetch).not.toHaveBeenCalled();
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const options = vi.mocked(pdfjs.getDocument).mock.calls.at(-1)![0] as {
      cMapUrl: string;
      standardFontDataUrl: string;
      wasmUrl: string;
      useWorkerFetch: boolean;
    };
    expect(options.useWorkerFetch).toBe(false);
    for (const asset of [
      options.cMapUrl,
      options.standardFontDataUrl,
      options.wasmUrl,
      fileURLToPath(pdfjs.GlobalWorkerOptions.workerSrc),
    ]) {
      expect(isAbsolute(asset)).toBe(true);
      expect(existsSync(asset)).toBe(true);
    }
  });

  it("reports unreadable non-Amex and scanned PDFs for review rather than guessing", async () => {
    expect(
      await parseServerStatement(
        textPdf(["Unknown Bank\n12.09 12.09 BIPA 4,50"]),
        "unknown.pdf",
        { ai: false },
      ),
    ).toMatchObject({
      source: null,
      rows: [],
      issues: [{ message: expect.stringContaining("PDF-Zeile nicht eindeutig lesbar") }],
    });
    expect(await parseServerStatement(textPdf([""]), "scan.pdf")).toMatchObject(
      { rows: [], issues: [{ message: expect.stringContaining("Scan") }] },
    );
    expect(createWorkerMock).not.toHaveBeenCalled();
  });

  it("reads a text PDF of another bank with the generic line parser", async () => {
    const fetch = vi.fn(() => {
      throw new Error("Network disabled");
    });
    vi.stubGlobal("fetch", fetch);
    const result = await parseServerStatement(textPdf([[
      "Erste Bank - Kontoauszug 9/2026",
      "Zeitraum 01.09.2026 bis 30.09.2026",
      "Alter Kontostand 1.000,00",
      "02.09.2026 BILLA DANKT 1234 -54,30",
      "15.09.2026 Gehalt Muster GmbH 2.100,00",
      "Neuer Kontostand 3.045,70",
    ].join("\n")]), "erste.pdf");
    expect(result.source).toBe("PDF");
    expect(result.issues).toEqual([]);
    expect(result.rows.map(({ date, amount, bank }) => ({ date, amount, bank }))).toEqual([
      { date: "2026-09-02", amount: -54.3, bank: "Erste Bank" },
      { date: "2026-09-15", amount: 2100, bank: "Erste Bank" },
    ]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("destroys loading tasks for page limits and loading failures", async () => {
    const tooMany = await fakePdf({ pages: SERVER_PARSE_LIMITS.pdfPages + 1 });
    await expect(
      parseServerStatement(pdfHeader(), "large.pdf"),
    ).rejects.toThrow("100 Seiten");
    expect(tooMany.destroy).toHaveBeenCalledOnce();
    expect(tooMany.getPage).not.toHaveBeenCalled();
    const corrupt = await fakePdf({
      failure: new Error("encrypted or corrupt"),
    });
    await expect(parseServerStatement(pdfHeader(), "bad.pdf")).rejects.toThrow(
      "encrypted or corrupt",
    );
    expect(corrupt.destroy).toHaveBeenCalledOnce();
  });

  it("cleans up a page and its loading task when text extraction fails", async () => {
    const state = await fakePdf({ textFailure: new Error("bad page content") });
    await expect(parseServerStatement(pdfHeader(), "bad.pdf")).rejects.toThrow(
      "bad page content",
    );
    expect(state.cleanup).toHaveBeenCalledOnce();
    expect(state.destroy).toHaveBeenCalledOnce();
  });

  it("classifies encrypted, damaged, oversized and infrastructure failures without retrying permanent input", async () => {
    await fakePdf({ failure: Object.assign(new Error("Password required"), { name: "PasswordException" }) });
    await expect(parseServerStatement(pdfHeader(), "encrypted.pdf")).rejects.toMatchObject({ code: "PARSE_ENCRYPTED" });
    await fakePdf({ failure: new Error("Invalid PDF structure") });
    await expect(parseServerStatement(pdfHeader(), "damaged.pdf")).rejects.toMatchObject({ code: "PARSE_DAMAGED" });
    await fakePdf({ pages: SERVER_PARSE_LIMITS.pdfPages + 1 });
    await expect(parseServerStatement(pdfHeader(), "huge.pdf")).rejects.toMatchObject({ code: "PARSE_RESOURCE_LIMIT" });
    await fakePdf({ failure: Object.assign(new Error("Local read failed"), { code: "EIO" }) });
    await expect(parseServerStatement(pdfHeader(), "local-error.pdf")).rejects.toMatchObject({ code: "PARSE_INFRASTRUCTURE" });
    await fakePdf({ failure: Object.assign(new Error("Missing local runtime asset"), { code: "MODULE_NOT_FOUND" }) });
    await expect(parseServerStatement(pdfHeader(), "local-error.pdf")).rejects.toMatchObject({ code: "PARSE_INFRASTRUCTURE" });
    await fakePdf({ failure: new Error("Operation timed out") });
    await expect(parseServerStatement(pdfHeader(), "slow.pdf")).rejects.toMatchObject({ code: "PARSE_TIMEOUT" });
  });

  it("rejects excessive PDF text and still cleans up", async () => {
    const state = await fakePdf();
    const page = await state.getPage();
    page.getTextContent.mockResolvedValueOnce({
      items: [
        {
          str: "x".repeat(SERVER_PARSE_LIMITS.pdfTextCharacters + 1),
          transform: [1, 0, 0, 1, 0, 0],
        },
      ],
    });
    await expect(
      parseServerStatement(pdfHeader(), "large.pdf"),
    ).rejects.toThrow("zu viel Buchungstext");
    expect(state.cleanup).toHaveBeenCalledOnce();
    expect(state.destroy).toHaveBeenCalledOnce();
  });
});

describe("filesystem-only server OCR", () => {
  it("uses installed Node worker/core and language directories", () => {
    const options = getServerOcrOptions();
    expect(options).toMatchObject({
      workerBlobURL: false,
      cacheMethod: "none",
      gzip: true,
    });
    for (const asset of [
      options.workerPath!,
      options.corePath!,
      options.langPath!,
    ]) {
      expect(isAbsolute(asset)).toBe(true);
      expect(existsSync(asset)).toBe(true);
      expect(asset).not.toMatch(/^https?:|\/api\//);
    }
    expect(existsSync(join(options.langPath!, "deu.traineddata.gz"))).toBe(
      true,
    );
  });

  it("runs actual Node OCR with local eng/deu data and fetch disabled", async () => {
    const fetch = vi.fn(() => {
      throw new Error("Network disabled");
    });
    vi.stubGlobal("fetch", fetch);
    const result = await parseServerStatement(await blankImage(), "blank.png");
    expect(result).toMatchObject({
      source: null,
      rows: [],
      issues: [{ message: expect.stringContaining("Screenshot") }],
    });
    expect(createWorkerMock).toHaveBeenCalledOnce();
    expect(createWorkerMock.mock.calls[0][0]).toBe("deu+eng");
    const options = createWorkerMock.mock.calls[0][2]!;
    expect(isAbsolute(options.langPath!)).toBe(true);
    expect(options.langPath).toContain(".automation-ocr-");
    expect(existsSync(options.langPath!)).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  }, 60_000);

  it.each([
    ["png", "png"],
    ["jpeg", "jpg"],
    ["webp", "webp"],
  ] as const)(
    "decodes %s locally, supplies Buffer input and terminates after each file",
    async (format, extension) => {
      const worker = fakeOcrWorker();
      createWorkerMock.mockResolvedValueOnce(
        worker as unknown as Awaited<ReturnType<typeof createWorker>>,
      );
      await parseServerStatement(
        await blankImage(format),
        `blank.${extension}`,
      );
      expect(worker.recognize).toHaveBeenCalledOnce();
      expect(Buffer.isBuffer(worker.recognize.mock.calls[0][0])).toBe(true);
      expect(worker.reinitialize.mock.calls[0][0]).toBe("deu");
      expect(worker.terminate).toHaveBeenCalledOnce();
    },
  );

  it("terminates on OCR errors and releases the serialized queue", async () => {
    const broken = fakeOcrWorker();
    broken.recognize.mockRejectedValueOnce(new Error("OCR failed"));
    const next = fakeOcrWorker();
    createWorkerMock
      .mockResolvedValueOnce(
        broken as unknown as Awaited<ReturnType<typeof createWorker>>,
      )
      .mockResolvedValueOnce(
        next as unknown as Awaited<ReturnType<typeof createWorker>>,
      );
    const image = await blankImage();
    await expect(parseServerStatement(image, "bad.png")).rejects.toThrow(
      "OCR failed",
    );
    await parseServerStatement(image, "next.png");
    expect(broken.terminate).toHaveBeenCalledOnce();
    expect(next.terminate).toHaveBeenCalledOnce();
  });

  it("cleans up its local language directory when worker creation rejects", async () => {
    createWorkerMock.mockRejectedValueOnce(new Error("worker unavailable"));
    await expect(
      parseServerStatement(await blankImage(), "bad.png"),
    ).rejects.toThrow("worker unavailable");
    const options = createWorkerMock.mock.calls[0][2]!;
    expect(existsSync(options.langPath!)).toBe(false);
  });

  it("allows only one simultaneous OCR worker", async () => {
    const first = fakeOcrWorker();
    const second = fakeOcrWorker();
    let finish!: (value: unknown) => void;
    let started!: () => void;
    const recognizing = new Promise<void>((resolve) => {
      started = resolve;
    });
    first.recognize.mockImplementationOnce(() => {
      started();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    createWorkerMock
      .mockResolvedValueOnce(
        first as unknown as Awaited<ReturnType<typeof createWorker>>,
      )
      .mockResolvedValueOnce(
        second as unknown as Awaited<ReturnType<typeof createWorker>>,
      );
    const image = await blankImage();
    const one = parseServerStatement(image, "one.png");
    await recognizing;
    const two = parseServerStatement(image, "two.png");
    await Promise.resolve();
    expect(createWorkerMock).toHaveBeenCalledOnce();
    finish({ data: { blocks: [] } });
    await Promise.all([one, two]);
    expect(first.terminate).toHaveBeenCalledOnce();
    expect(second.terminate).toHaveBeenCalledOnce();
    expect(first.terminate.mock.invocationCallOrder[0]).toBeLessThan(
      second.recognize.mock.invocationCallOrder[0],
    );
  });

  it("rejects invalid, wrong-format and huge images before spawning OCR", async () => {
    await expect(
      parseServerStatement(encode("not an image"), "bad.png"),
    ).rejects.toThrow();
    const tiff = await sharp({
      create: { width: 20, height: 20, channels: 3, background: "#fff" },
    })
      .tiff()
      .toBuffer();
    await expect(parseServerStatement(tiff, "wrong.png")).rejects.toThrow(
      "PNG, JPEG",
    );
    const large = await sharp({
      create: { width: 4000, height: 4000, channels: 3, background: "#fff" },
    })
      .png()
      .toBuffer();
    await expect(parseServerStatement(large, "large.png")).rejects.toThrow(
      /pixel/i,
    );
    expect(createWorkerMock).not.toHaveBeenCalled();
  });
});

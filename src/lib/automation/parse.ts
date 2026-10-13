import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import type { WorkerOptions } from "tesseract.js";
import { parseAmexText } from "../import/amex-pdf";
import { recognizeAmexScreenshot } from "../import/amex-ocr";
import { parseAmexScreenshotLines } from "../import/amex-screenshot";
import { assertImportSize } from "../import/limits";
import { parseStatementFile, type StatementResult } from "../import/statements";
import { classifyParserError, ParserFailure } from "./errors";

export type { StatementResult } from "../import/statements";

/** Hard bounds for unattended parsing on a small Node server. */
export const SERVER_PARSE_LIMITS = Object.freeze({
  pdfPages: 100,
  pdfTextCharacters: 2_000_000,
  pdfItemsPerPage: 25_000,
  imagePixels: 12_000_000,
  imageWidth: 6000,
  imageHeight: 12000,
});

const requireLocal = createRequire(import.meta.url);
let ocrQueue: Promise<void> = Promise.resolve();

type LocalLanguage = { code: string; langPath: string; gzip: boolean };

function languageAsset(code: "deu" | "eng"): LocalLanguage {
  return requireLocal(`@tesseract.js-data/${code}`) as LocalLanguage;
}

/** Filesystem-only Node worker/core assets; no browser worker or CDN defaults. */
export function getServerOcrOptions(): Partial<WorkerOptions> {
  return {
    workerPath: requireLocal.resolve(
      "tesseract.js/src/worker-script/node/index.js",
    ),
    corePath: dirname(requireLocal.resolve("tesseract.js-core/package.json")),
    langPath: languageAsset("deu").langPath,
    workerBlobURL: false,
    cacheMethod: "none",
    gzip: true,
    // Tesseract otherwise throws job errors from its message handler as well as
    // rejecting the job promise. Keep errors on the awaited promise instead.
    errorHandler: () => {},
  };
}

async function copyLanguage(
  code: "deu" | "eng",
  directory: string,
): Promise<void> {
  const asset = languageAsset(code);
  if (!asset.gzip)
    throw new Error(`OCR-Sprachdaten für ${code} sind nicht gzip-komprimiert.`);
  const filename = `${code}.traineddata.gz`;
  await copyFile(join(asset.langPath, filename), join(directory, filename));
}

async function parseImage(
  bytes: Uint8Array,
  file: string,
  workspace: string,
): Promise<StatementResult> {
  const previous = ocrQueue;
  let release!: () => void;
  ocrQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    const { default: sharp } = await import("sharp");
    sharp.concurrency(1);
    sharp.cache(false);
    const image = sharp(Buffer.from(bytes), {
      limitInputPixels: SERVER_PARSE_LIMITS.imagePixels,
      sequentialRead: true,
      failOn: "warning",
    });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? ""))
      throw new ParserFailure("PARSE_UNSUPPORTED",
        "Ungültiges Screenshot-Bild. Bitte PNG, JPEG oder WebP verwenden.",
      );
    if ((metadata.pages ?? 1) !== 1)
      throw new ParserFailure("PARSE_UNSUPPORTED",
        "Animierte oder mehrseitige Screenshots werden nicht unterstützt.",
      );
    if (
      !metadata.width ||
      !metadata.height ||
      metadata.width > SERVER_PARSE_LIMITS.imageWidth ||
      metadata.height > SERVER_PARSE_LIMITS.imageHeight ||
      metadata.width * metadata.height > SERVER_PARSE_LIMITS.imagePixels
    )
      throw new ParserFailure("PARSE_RESOURCE_LIMIT",
        "Screenshot zu groß. Höchstens 12 Megapixel und 6000 × 12000 Pixel sind erlaubt.",
      );
    const png = await image
      .timeout({ seconds: 30 })
      .flatten({ background: "#fff" })
      .png()
      .toBuffer();
    const { createWorker, OEM } = await import("tesseract.js");
    // Tesseract 7's binary Lang objects are broken during initialization. Its
    // string language API requires a single directory for both local packages.
    const directory = await mkdtemp(join(workspace, ".automation-ocr-"));
    try {
      await copyLanguage("deu", directory);
      await copyLanguage("eng", directory);
      const worker = await createWorker("deu+eng", OEM.LSTM_ONLY, {
        ...getServerOcrOptions(),
        langPath: directory,
      });
      try {
        return parseAmexScreenshotLines(
          await recognizeAmexScreenshot(worker, png),
          file,
        );
      } finally {
        await worker.terminate();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  } finally {
    release();
  }
}

async function parsePdf(
  bytes: Uint8Array,
  file: string,
): Promise<StatementResult> {
  if (!new TextDecoder().decode(bytes.subarray(0, 1024)).includes("%PDF-"))
    throw new ParserFailure("PARSE_DAMAGED",
      "PDF-Datei konnte nicht gelesen werden: ungültige PDF-Signatur.",
    );
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const root = dirname(requireLocal.resolve("pdfjs-dist/package.json"));
  pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(
    requireLocal.resolve("pdfjs-dist/legacy/build/pdf.worker.mjs"),
  ).href;
  const task = pdfjs.getDocument({
    // PDF.js may transfer/detach its input; never detach a caller's buffer.
    data: Uint8Array.from(bytes),
    // PDF.js requires a literal trailing slash even for Node filesystem paths.
    cMapUrl: join(root, "cmaps") + "/",
    standardFontDataUrl: join(root, "standard_fonts") + "/",
    wasmUrl: join(root, "wasm") + "/",
    useWorkerFetch: false,
    useSystemFonts: false,
    disableFontFace: true,
    isOffscreenCanvasSupported: false,
    isImageDecoderSupported: false,
    stopAtErrors: true,
    maxImageSize: SERVER_PARSE_LIMITS.imagePixels,
  });
  try {
    const document = await task.promise;
    if (document.numPages > SERVER_PARSE_LIMITS.pdfPages)
      throw new ParserFailure("PARSE_RESOURCE_LIMIT",
        `Die PDF-Datei enthält mehr als ${SERVER_PARSE_LIMITS.pdfPages} Seiten.`,
      );
    const pages: string[] = [];
    let characters = 0;
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      try {
        const content = await page.getTextContent();
        if (content.items.length > SERVER_PARSE_LIMITS.pdfItemsPerPage)
          throw new ParserFailure("PARSE_RESOURCE_LIMIT", "Die PDF-Seite enthält zu viele Textelemente.");
        const items = content.items
          .flatMap((item) => {
            if (!("str" in item) || !item.str.trim()) return [];
            characters += item.str.length + 1;
            if (characters > SERVER_PARSE_LIMITS.pdfTextCharacters)
              throw new ParserFailure("PARSE_RESOURCE_LIMIT", "Die PDF-Datei enthält zu viel Buchungstext.");
            return [
              { text: item.str, x: item.transform[4], y: item.transform[5] },
            ];
          })
          .sort((a, b) => b.y - a.y || a.x - b.x);
        const lines: { y: number; items: typeof items }[] = [];
        for (const item of items) {
          let line = lines.at(-1);
          if (!line || Math.abs(line.y - item.y) > 2) {
            line = { y: item.y, items: [] };
            lines.push(line);
          }
          line.items.push(item);
        }
        pages.push(
          lines
            .map((line) =>
              line.items
                .sort((a, b) => a.x - b.x)
                .map((item) => item.text)
                .join(" "),
            )
            .join("\n"),
        );
      } finally {
        page.cleanup();
      }
    }
    if (
      !/american\s*express|amex\.at/i.test(pages.join("\n")) &&
      pages.some((page) => page.trim())
    )
      return {
        source: null,
        file,
        rows: [],
        skipped: 1,
        issues: [
          {
            file,
            message:
              "PDF-Anbieter nicht eindeutig als Amex erkannt. Bitte Kontoauszug prüfen.",
          },
        ],
      };
    return parseAmexText(pages, file);
  } catch (error) {
    throw new ParserFailure(classifyParserError(error).code,
      `PDF-Datei konnte nicht gelesen werden: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  } finally {
    await task.destroy();
  }
}

/**
 * Parse CSV/XLSX statements, Amex text PDFs or Amex PNG/JPEG/WebP screenshots.
 * Uses only installed filesystem assets. Scanned/unknown PDFs remain review
 * issues; corrupt files and resource-limit failures reject instead of falling
 * back to a different parser. OCR is serialized within this Node worker.
 */
export async function parseServerStatement(
  bytes: Uint8Array,
  name: string,
  options: { workspace?: string } = {},
): Promise<StatementResult> {
  try {
    assertImportSize(bytes.byteLength);
    if (!bytes.byteLength) throw new ParserFailure("PARSE_DAMAGED", "Die Kontoauszugsdatei ist leer.");
    if (/\.pdf$/i.test(name)) return await parsePdf(bytes, name);
    if (/\.(png|jpe?g|webp)$/i.test(name))
      return await parseImage(bytes, name, options.workspace ?? process.cwd());
    if (/\.(csv|xlsx)$/i.test(name))
      return await parseStatementFile({
        name,
        size: bytes.byteLength,
        arrayBuffer: async () => Uint8Array.from(bytes).buffer,
      });
    throw new ParserFailure("PARSE_UNSUPPORTED",
      "Nicht unterstütztes Kontoauszugsformat. Bitte CSV, XLSX, PDF, PNG, JPEG oder WebP verwenden.",
    );
  } catch (error) {
    throw classifyParserError(error);
  }
}

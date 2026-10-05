import type { ImageLike, Worker } from "tesseract.js";
import { assertImportSize } from "./limits";
import { parseAmexScreenshotLines, screenshotAmount, screenshotContentTop, screenshotDate, type ScreenshotLine } from "./amex-screenshot";

export const localOcrOptions = {
  workerPath: "/api/ocr/worker.min.js",
  corePath: "/api/ocr",
  langPath: "/api/ocr",
  workerBlobURL: false,
  cacheMethod: "none",
} as const;
export const localOcrLanguages = "deu+eng";

export async function recognizeAmexScreenshot(worker: Worker, image: ImageLike): Promise<ScreenshotLine[]> {
  await worker.reinitialize("deu");
  await worker.setParameters({ tessedit_pageseg_mode: "11" as import("tesseract.js").PSM, user_defined_dpi: "300" });
  const { data } = await worker.recognize(image, {}, { blocks: true });
  const lines: ScreenshotLine[] = data.blocks?.flatMap((block) => block.paragraphs.flatMap((paragraph) =>
    paragraph.lines.map((line) => ({ text: line.text.trim(), bbox: line.bbox, confidence: line.confidence })))) ?? [];
  const top = screenshotContentTop(lines);
  if (top === null) return lines;
  const right = Math.max(...lines.map((line) => line.bbox.x1));
  await worker.setParameters({ tessedit_pageseg_mode: "7" as import("tesseract.js").PSM });
  // Re-read isolated amounts: sparse OCR can omit the decimal comma on dark mode.
  // A disagreement between two valid readings is never silently accepted.
  for (const line of lines) {
    if (line.bbox.y0 <= top) continue;
    const money = line.bbox.x0 > right * 0.7;
    const date = screenshotDate(line.text) !== null;
    const orderCode = /\b(?:AMAZON\.[A-Z.]+|AIRBNB)\s*\*/i.test(line.text);
    if (!money && (!date || line.confidence >= 75) && (!orderCode || line.confidence >= 85)) continue;
    if (orderCode && !money && !date) {
      // Keep German dates, but retry international order codes with the English model.
      await worker.reinitialize("eng");
      await worker.setParameters({ tessedit_pageseg_mode: "7" as import("tesseract.js").PSM, user_defined_dpi: "300" });
    }
    const { x0, y0, x1, y1 } = line.bbox;
    const { data: retry } = await worker.recognize(image, { rectangle: {
      left: Math.max(0, x0 - 12), top: Math.max(0, y0 - 12),
      width: x1 - x0 + 24, height: y1 - y0 + 24,
    } });
    if (orderCode && !money && !date) {
      if (retry.confidence > line.confidence && /\b(?:AMAZON\.[A-Z.]+|AIRBNB)\s*\*/i.test(retry.text)) {
        line.text = retry.text.trim();
        line.confidence = retry.confidence;
      }
      await worker.reinitialize("deu");
      await worker.setParameters({ tessedit_pageseg_mode: "7" as import("tesseract.js").PSM, user_defined_dpi: "300" });
      continue;
    }
    const parse = money ? screenshotAmount : screenshotDate;
    const first = parse(line.text);
    const second = parse(retry.text);
    if (first !== null && second !== null && first !== second) line.uncertain = true;
    else if (second !== null && (second === first || retry.confidence >= 65)) {
      line.text = retry.text.trim();
      line.confidence = retry.confidence;
    } else if (first === null || line.confidence < 65) line.uncertain = true;
  }
  return lines;
}

export async function parseAmexScreenshot(buffer: ArrayBuffer, file: string) {
  assertImportSize(buffer.byteLength);
  const bytes = new Uint8Array(buffer);
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10";
  const webp = new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" &&
    new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (!jpeg && !png && !webp) throw new Error("Ungültiges Screenshot-Bild. Bitte PNG, JPEG oder WebP verwenden.");
  const image = new Blob([buffer], { type: jpeg ? "image/jpeg" : png ? "image/png" : "image/webp" });
  const bitmap = await createImageBitmap(image);
  try {
    if (bitmap.width * bitmap.height > 24_000_000 || bitmap.width > 8000 || bitmap.height > 12000)
      throw new Error("Screenshot zu groß. Bitte auf höchstens 24 Megapixel verkleinern.");
  } finally {
    bitmap.close();
  }
  const { createWorker, OEM } = await import("tesseract.js");
  const worker = await createWorker(localOcrLanguages, OEM.LSTM_ONLY, localOcrOptions);
  try {
    return parseAmexScreenshotLines(await recognizeAmexScreenshot(worker, image), file);
  } finally {
    await worker.terminate();
  }
}

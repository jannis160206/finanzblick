import type { ImageLike, Worker } from "tesseract.js";
import { assertImportSize } from "./limits";
import { parseAmexScreenshotLines, screenshotAmount, screenshotContentTop, screenshotDate, screenshotGroupedDateLike, type ScreenshotLine } from "./amex-screenshot";

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
    paragraph.lines.flatMap((line) => {
      const currency = line.words?.findIndex((word) => /^[−–+-]?\s*€/.test(word.text)) ?? -1;
      if (currency <= 0) return [{ text: line.text.trim(), bbox: line.bbox, confidence: line.confidence }];
      const sections = [line.words.slice(0, currency), line.words.slice(currency)];
      return sections.map((words) => ({
        text: words.map((word) => word.text).join(" ").trim(),
        confidence: Math.min(...words.map((word) => word.confidence)),
        bbox: { x0: Math.min(...words.map((word) => word.bbox.x0)), y0: Math.min(...words.map((word) => word.bbox.y0)),
          x1: Math.max(...words.map((word) => word.bbox.x1)), y1: Math.max(...words.map((word) => word.bbox.y1)) },
      }));
    }))) ?? [];
  const top = screenshotContentTop(lines);
  if (top === null) return lines;
  const right = Math.max(...lines.map((line) => line.bbox.x1));
  const grouped = !lines.some((line) => /\d{1,2}\.\d{1,2}\.\d{4}\s*[-–]\s*Aktuell/i.test(line.text));
  const totalLabel = grouped && lines.find((line) => /Gesamtsaldo/i.test(line.text));
  const dueLabel = totalLabel && lines.find((line) => /Fällige Zahlung/i.test(line.text));
  const totalBottom = totalLabel ? dueLabel?.bbox.y0 ??
    lines.find((line) => screenshotGroupedDateLike(line.text) && line.bbox.y0 > totalLabel.bbox.y1)?.bbox.y0 ??
    totalLabel.bbox.y1 + (totalLabel.bbox.y1 - totalLabel.bbox.y0) * 4 : 0;
  const navigation = lines.find((line) => /^(?:Startseite|Konto)$/i.test(line.text));
  const bottom = navigation ? navigation.bbox.y0 - (navigation.bbox.y1 - navigation.bbox.y0) * 4.5 : Infinity;
  await worker.setParameters({ tessedit_pageseg_mode: "7" as import("tesseract.js").PSM });
  // Re-read isolated amounts: sparse OCR can omit the decimal comma on dark mode.
  // A disagreement between two valid readings is never silently accepted.
  for (const line of lines) {
    if (grouped && (line.bbox.y1 >= bottom ||
      /^(?:Vorgemerkt|Ausstehend|Membership Rewards|\d+\.\d{3}|[\\/<>‹›»«]+)$/i.test(line.text))) continue;
    const headerMoney = line.bbox.y1 <= top && line.text.includes("€");
    if (line.bbox.y0 <= top && !headerMoney) continue;
    if (headerMoney && screenshotAmount(line.text) !== null && line.confidence >= 65) continue;
    const money = headerMoney || line.bbox.x0 > right * 0.7 || /^[−–+-]?\s*€/.test(line.text);
    const groupedDate = screenshotGroupedDateLike(line.text);
    const date = screenshotDate(line.text, "2000-12-31") !== null || groupedDate;
    const orderCode = /\b(?:AMAZON\.[A-Z.]+|AIRBNB)\s*\*/i.test(line.text);
    if (!money && (!date || line.confidence >= 75) && (!orderCode || line.confidence >= 85)) continue;
    if (orderCode && !money && !date) {
      // Keep German dates, but retry international order codes with the English model.
      await worker.reinitialize("eng");
      await worker.setParameters({ tessedit_pageseg_mode: "7" as import("tesseract.js").PSM, user_defined_dpi: "300" });
    }
    const { x0, y0, x1, y1 } = line.bbox;
    const rectangle = {
      left: Math.max(0, x0 - 12), top: Math.max(0, y0 - 12),
      width: x1 - x0 + 24, height: y1 - y0 + 24,
    };
    if (money && totalLabel && line.bbox.y0 >= totalLabel.bbox.y0 && line.bbox.y1 < totalBottom) {
      // The large balance font needs an independent English-model confirmation.
      await worker.reinitialize("eng");
      await worker.setParameters({ tessedit_pageseg_mode: "7" as import("tesseract.js").PSM, user_defined_dpi: "300" });
      const { data: single } = await worker.recognize(image, { rectangle });
      await worker.setParameters({ tessedit_pageseg_mode: "13" as import("tesseract.js").PSM });
      const { data: raw } = await worker.recognize(image, { rectangle });
      const value = screenshotAmount(single.text);
      if (value !== null && value === screenshotAmount(raw.text) && Math.max(single.confidence, raw.confidence) >= 65) {
        const best = single.confidence >= raw.confidence ? single : raw;
        line.text = best.text.trim();
        line.confidence = best.confidence;
        line.confirmed = true;
      } else line.uncertain = true;
      await worker.reinitialize("deu");
      await worker.setParameters({ tessedit_pageseg_mode: "7" as import("tesseract.js").PSM, user_defined_dpi: "300" });
      continue;
    }
    const { data: retry } = await worker.recognize(image, { rectangle });
    if (orderCode && !money && !date) {
      if (retry.confidence > line.confidence && /\b(?:AMAZON\.[A-Z.]+|AIRBNB)\s*\*/i.test(retry.text)) {
        line.text = retry.text.trim();
        line.confidence = retry.confidence;
      }
      await worker.reinitialize("deu");
      await worker.setParameters({ tessedit_pageseg_mode: "7" as import("tesseract.js").PSM, user_defined_dpi: "300" });
      continue;
    }
    const parse = money ? screenshotAmount : (text: string) => screenshotDate(text, "2000-12-31");
    const readings = [line, retry].map(({ text, confidence }) => ({ text, confidence, value: parse(text) }));
    let valid = readings.filter((reading) => reading.value !== null);
    if (money && valid.length < 2 && !valid.some((reading) => reading.confidence >= 65)) {
      // Raw-line segmentation can read dark-mode digits that single-line OCR misses.
      await worker.setParameters({ tessedit_pageseg_mode: "13" as import("tesseract.js").PSM });
      const { data: raw } = await worker.recognize(image, { rectangle });
      await worker.setParameters({ tessedit_pageseg_mode: "7" as import("tesseract.js").PSM });
      readings.push({ text: raw.text, confidence: raw.confidence, value: parse(raw.text) });
      valid = readings.filter((reading) => reading.value !== null);
    }
    if (new Set(valid.map((reading) => reading.value)).size > 1 ||
      (!valid.some((reading) => reading.confidence >= 65) && valid.length < 2)) line.uncertain = true;
    else {
      const best = valid.reduce((best, reading) => reading.confidence > best.confidence ? reading : best);
      // A date retry may omit the cardholder suffix; retain the original metadata.
      if (money || groupedDate) line.text = best.text.trim();
      line.confidence = best.confidence;
      line.confirmed = valid.length >= 2;
    }
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

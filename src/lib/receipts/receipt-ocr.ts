import { assertImportSize } from "@/lib/import/limits";

const MAX_PIXELS = 24_000_000;

async function pdfText(buffer: ArrayBuffer): Promise<string> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  pdfjs.GlobalWorkerOptions.workerSrc = "/api/pdf-worker";
  const task = pdfjs.getDocument({ data: new Uint8Array(buffer), useSystemFonts: true });
  try {
    const document = await task.promise;
    if (document.numPages > 10) throw new Error("Ein Kassenbon hat höchstens 10 Seiten.");
    const pages: string[] = [];
    for (let number = 1; number <= document.numPages; number++) {
      const page = await document.getPage(number);
      const content = await page.getTextContent();
      const lines: { y: number; items: { x: number; text: string }[] }[] = [];
      for (const item of content.items) {
        if (!("str" in item) || !item.str.trim()) continue;
        const y = item.transform[5];
        let line = lines.find((candidate) => Math.abs(candidate.y - y) <= 2);
        if (!line) lines.push((line = { y, items: [] }));
        line.items.push({ x: item.transform[4], text: item.str });
      }
      pages.push(lines.sort((a, b) => b.y - a.y).map((line) => line.items.sort((a, b) => a.x - b.x).map((item) => item.text).join(" ")).join("\n"));
      page.cleanup();
    }
    return pages.join("\n");
  } finally {
    await task.destroy();
  }
}

// Grayscale + upscale narrow thermal-paper photos so Tesseract sees ~30 px digits.
async function preparedImage(buffer: ArrayBuffer, type: string): Promise<Blob> {
  const bitmap = await createImageBitmap(new Blob([buffer], { type }));
  try {
    if (bitmap.width * bitmap.height > MAX_PIXELS || bitmap.width > 8000 || bitmap.height > 12000)
      throw new Error("Foto zu groß. Bitte auf höchstens 24 Megapixel verkleinern.");
    const scale = Math.min(2, Math.max(1, 1400 / bitmap.width));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const context = canvas.getContext("2d");
    if (!context) return new Blob([buffer], { type });
    context.filter = "grayscale(1) contrast(1.4)";
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    return await new Promise<Blob>((resolve, reject) =>
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Foto konnte nicht vorbereitet werden."))), "image/png"));
  } finally {
    bitmap.close();
  }
}

/** Reads a receipt photo (OCR in the browser, nothing is uploaded) or a text PDF into plain lines. */
export async function readReceiptText(file: File, onProgress?: (progress: number) => void): Promise<string> {
  const buffer = await file.arrayBuffer();
  assertImportSize(buffer.byteLength);
  const bytes = new Uint8Array(buffer);
  if (new TextDecoder().decode(bytes.slice(0, 1024)).includes("%PDF-")) {
    const text = await pdfText(buffer);
    if (text.trim()) return text;
    throw new Error("Dieses PDF enthält keinen Text (Scan). Bitte ein Foto des Kassenbons verwenden.");
  }
  const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.slice(0, 8).join(",") === "137,80,78,71,13,10,26,10";
  const webp = new TextDecoder().decode(bytes.slice(0, 4)) === "RIFF" && new TextDecoder().decode(bytes.slice(8, 12)) === "WEBP";
  if (!jpeg && !png && !webp) throw new Error("Bitte ein Foto (JPEG, PNG, WebP) oder ein PDF des Kassenbons wählen.");
  const image = await preparedImage(buffer, jpeg ? "image/jpeg" : png ? "image/png" : "image/webp");
  const [{ createWorker, OEM }, { localOcrLanguages, localOcrOptions }] = await Promise.all([
    import("tesseract.js"),
    import("@/lib/import/amex-ocr"),
  ]);
  const worker = await createWorker(localOcrLanguages, OEM.LSTM_ONLY, {
    ...localOcrOptions,
    logger: (message: { status: string; progress: number }) => {
      if (message.status === "recognizing text") onProgress?.(message.progress);
    },
  });
  try {
    // PSM 6: one uniform block keeps article name and price on the same line.
    await worker.setParameters({
      tessedit_pageseg_mode: "6" as import("tesseract.js").PSM,
      preserve_interword_spaces: "1",
      user_defined_dpi: "300",
    });
    const { data } = await worker.recognize(image);
    return data.text;
  } finally {
    await worker.terminate();
  }
}

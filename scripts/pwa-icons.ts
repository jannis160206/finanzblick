import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

// Renders the PWA/app icons from src/app/icon.svg. Run with: npm run pwa:icons
const app = path.join(process.cwd(), "src", "app");
const glyph = '<path d="M13 33V24M24 33V16M35 33V10" stroke="#5bddad" stroke-width="6" stroke-linecap="round"/>';
// Maskable icons need a full-bleed background and the glyph inside the central safe zone.
const maskable = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48"><rect width="48" height="48" fill="#173b30"/><g transform="translate(24 24) scale(0.62) translate(-24 -21.5)">${glyph}</g></svg>`;

async function render(svg: string | Buffer, size: number, file: string) {
  await writeFile(path.join(app, file), await sharp(Buffer.isBuffer(svg) ? svg : Buffer.from(svg), { density: 600 }).resize(size, size).png({ compressionLevel: 9 }).toBuffer());
  console.log(`${file} ${size}x${size}`);
}

const standard = await readFile(path.join(app, "icon.svg"));
await render(standard, 192, "icon1.png");
await render(standard, 512, "icon2.png");
await render(maskable, 512, "icon3.png");
await render(maskable, 180, "apple-icon.png");

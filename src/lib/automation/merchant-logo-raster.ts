import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, opendir } from "node:fs/promises";
import { dirname, parse, resolve } from "node:path";
import sharp from "sharp";

export const MAX_LOGO_INPUT = 2 * 1024 * 1024;
export const MAX_LOGO_PIXELS = 4_000_000;
export const MAX_LOCAL_LOGO_PIXELS = 20_000_000;
export const MAX_LOGO_STORED = 256 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
export const logoFilePattern = /^[a-f0-9]{64}\.png$/;

export function logoContentFile(png: Buffer): string {
  return `${createHash("sha256").update(png).digest("hex")}.png`;
}

export async function assertNoSymlinkPath(path: string): Promise<void> {
  const target = resolve(path);
  const root = parse(target).root;
  let part = target;
  while (part !== root) {
    if ((await lstat(part)).isSymbolicLink())
      throw new Error("Logo paths must not contain symlinks");
    part = dirname(part);
  }
}

async function createLogoDirectory(path: string): Promise<void> {
  const target = resolve(path);
  const missing: string[] = [];
  let parent = target;
  while (true) {
    try {
      const stat = await lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error(
          "Logo directory must be a regular directory, not a symlink",
        );
      await assertNoSymlinkPath(parent);
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "ENOENT"
      )
        throw error;
      missing.push(parent);
      parent = dirname(parent);
    }
  }
  for (const directory of missing.reverse()) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST"
      )
        throw error;
    }
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error(
        "Logo directory must be a regular directory, not a symlink",
      );
  }
}

export async function readBoundedLogoFile(
  path: string,
  maxBytes: number,
): Promise<Buffer> {
  if (
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > MAX_LOGO_INPUT
  )
    throw new RangeError("Invalid logo read byte limit");
  await assertNoSymlinkPath(path);
  const stat = await lstat(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > maxBytes)
    throw new Error("Logo file exceeds byte limit or is not a regular file");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.size < 1 ||
      opened.size > maxBytes ||
      opened.dev !== stat.dev ||
      opened.ino !== stat.ino
    )
      throw new Error("Logo file changed during bounded read");
    const bounded = Buffer.alloc(maxBytes + 1);
    let received = 0;
    while (received < bounded.length) {
      const { bytesRead } = await handle.read(
        bounded,
        received,
        bounded.length - received,
        received,
      );
      if (!bytesRead) break;
      received += bytesRead;
    }
    if (received < 1 || received > maxBytes)
      throw new Error("Logo file exceeds byte limit");
    return bounded.subarray(0, received);
  } finally {
    await handle.close();
  }
}

export function logoRasterMime(bytes: Buffer): string | null {
  return bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    ? "image/png"
    : bytes.length >= 3 &&
        bytes[0] === 0xff &&
        bytes[1] === 0xd8 &&
        bytes[2] === 0xff
      ? "image/jpeg"
      : bytes.length >= 12 &&
          bytes.toString("ascii", 0, 4) === "RIFF" &&
          bytes.toString("ascii", 8, 12) === "WEBP"
        ? "image/webp"
        : null;
}

export async function normalizeLogoRaster(
  bytes: Buffer,
  options: {
    mime?: string;
    commonsThumbnail?: boolean;
    suppliedLocalFile?: boolean;
  } = {},
): Promise<Buffer | null> {
  if (!bytes.length || bytes.length > MAX_LOGO_INPUT) return null;
  const fileTypeSize = bytes.length >= 16 ? bytes.readUInt32BE(0) : 0;
  const avif =
    options.suppliedLocalFile &&
    bytes.toString("ascii", 4, 8) === "ftyp" &&
    fileTypeSize >= 16 &&
    fileTypeSize <= 256 &&
    fileTypeSize <= bytes.length &&
    [
      bytes.toString("ascii", 8, 12),
      ...Array.from(
        { length: Math.floor((fileTypeSize - 16) / 4) },
        (_, index) => bytes.toString("ascii", 16 + index * 4, 20 + index * 4),
      ),
    ].some((brand) => brand === "avif" || brand === "avis");
  const mime = logoRasterMime(bytes) ?? (avif ? "image/avif" : null);
  if (!mime || (options.mime && mime !== options.mime)) return null;
  const pixelLimit = options.suppliedLocalFile
    ? MAX_LOCAL_LOGO_PIXELS
    : MAX_LOGO_PIXELS;
  const image = sharp(bytes, {
    limitInputPixels: pixelLimit,
    sequentialRead: true,
    failOn: "warning",
  }).timeout({ seconds: 5 });
  try {
    const info = await image.metadata();
    if (
      !info.width ||
      !info.height ||
      info.width * info.height > pixelLimit ||
      !(
        ["png", "jpeg", "webp"].includes(info.format ?? "") ||
        (mime === "image/avif" && info.format === "heif")
      ) ||
      (info.pages ?? 1) !== 1 ||
      (options.commonsThumbnail && (info.width > 512 || info.height > 512))
    )
      return null;
    const oriented = image.rotate();
    // Trim only supplied raster padding, never crop a remote licensed original.
    if (options.suppliedLocalFile)
      oriented.trim({ threshold: 24, lineArt: true });
    const png = await oriented
      .resize(128, 128, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
    if (png.length > MAX_LOGO_STORED)
      throw new Error("Normalized merchant logo exceeds storage limit");
    return png;
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !/^(?:Input buffer (?:has corrupt header|contains unsupported image (?:format|type))|(?:Input image|Image) exceeds pixel limit|(?:png|jpeg|webp|heif)load(?:_buffer)?:|Vips(?:Jpeg|Png|Webp):|timeout:)/i.test(
        error.message,
      )
    )
      throw error;
    return null;
  }
}

export async function readStoredLogoPng(
  directory: string,
  file: string,
): Promise<Buffer | null> {
  if (!logoFilePattern.test(file)) return null;
  let bytes: Buffer;
  try {
    bytes = await readBoundedLogoFile(
      resolve(directory, file),
      MAX_LOGO_STORED,
    );
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    // Unsafe cache files are not images, but genuine filesystem failures remain visible.
    if (
      error instanceof Error &&
      /^(Logo paths must not|Logo file exceeds|Logo file changed)/.test(
        error.message,
      )
    )
      return null;
    throw error;
  }
  if (!isBoundedStoredPng(bytes) || logoContentFile(bytes) !== file)
    return null;
  return bytes;
}

function isBoundedStoredPng(bytes: Buffer): boolean {
  return (
    bytes.length >= 24 &&
    bytes.length <= MAX_LOGO_STORED &&
    bytes.subarray(0, 8).equals(PNG_SIGNATURE) &&
    bytes.toString("ascii", 12, 16) === "IHDR" &&
    bytes.readUInt32BE(16) >= 1 &&
    bytes.readUInt32BE(16) <= 128 &&
    bytes.readUInt32BE(20) >= 1 &&
    bytes.readUInt32BE(20) <= 128
  );
}

export async function writeStoredLogoPng(
  directory: string,
  png: Buffer,
  maxFiles?: number,
): Promise<string> {
  const file = logoContentFile(png);
  if (!isBoundedStoredPng(png)) throw new Error("Invalid normalized logo");
  if (
    maxFiles !== undefined &&
    (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 1024)
  )
    throw new RangeError("Invalid private logo file quota");
  await createLogoDirectory(directory);
  if (maxFiles !== undefined) {
    const existing = await readStoredLogoPng(directory, file);
    if (existing) {
      if (!existing.equals(png))
        throw new Error(
          "Existing merchant logo does not match its content hash",
        );
      return file;
    }
    let count = 0;
    const entries = await opendir(directory);
    // Count lazily and stop at the cap rather than allocating an unbounded directory listing.
    for await (const entry of entries) {
      void entry;
      if (++count >= maxFiles)
        throw new RangeError("Private logo file quota reached");
    }
  }
  const destination = resolve(directory, file);
  let handle;
  try {
    handle = await open(destination, "wx", 0o600);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !("code" in error) ||
      error.code !== "EEXIST"
    )
      throw error;
    const existing = await readStoredLogoPng(directory, file);
    if (!existing || !existing.equals(png))
      throw new Error("Existing merchant logo does not match its content hash");
  }
  if (handle) {
    try {
      await handle.writeFile(png);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
  return file;
}

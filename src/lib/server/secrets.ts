import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmod, mkdir, open, readFile } from "node:fs/promises";
import { join } from "node:path";

const VERSION = "v1";
const KEY_FILE = "secret.key";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretError extends Error {}

let cached: { path: string; key: Buffer } | undefined;

function decodeKey(text: string, source: string): Buffer {
  const key = Buffer.from(text.trim(), "base64");
  if (key.length !== KEY_BYTES) throw new SecretError(`${source} muss genau ${KEY_BYTES} Byte als Base64 enthalten.`);
  return key;
}

async function readOrCreateKeyFile(path: string): Promise<Buffer> {
  try {
    return decodeKey(await readFile(path, "utf8"), "Die Schlüsseldatei");
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
  const key = randomBytes(KEY_BYTES);
  try {
    const file = await open(path, "wx", 0o600);
    try {
      await file.writeFile(key.toString("base64"));
      await file.sync();
    } finally {
      await file.close();
    }
    await chmod(path, 0o600).catch(() => undefined);
    return key;
  } catch (error) {
    // Another process created the file first: use its key.
    if (error instanceof Error && "code" in error && error.code === "EEXIST") return decodeKey(await readFile(path, "utf8"), "Die Schlüsseldatei");
    throw error;
  }
}

/** Master key for secrets at rest: FINANZBLICK_SECRET_KEY (Base64, 32 bytes) or a key file created once in the data directory. */
export async function masterKey(dataDirectory: string, env: Record<string, string | undefined> = process.env): Promise<Buffer> {
  const configured = env.FINANZBLICK_SECRET_KEY?.trim();
  if (configured) return decodeKey(configured, "FINANZBLICK_SECRET_KEY");
  const path = join(dataDirectory, KEY_FILE);
  if (cached?.path === path) return cached.key;
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const key = await readOrCreateKeyFile(path);
  cached = { path, key };
  return key;
}

/** AES-256-GCM; the context (e.g. user and purpose) is authenticated, so a sealed value cannot be moved elsewhere. */
export function sealSecret(value: string, key: Buffer, context: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(context, "utf8"));
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return [VERSION, iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), data.toString("base64url")].join(".");
}

export function openSecret(sealed: string, key: Buffer, context: string): string {
  const [version, iv, tag, data, ...rest] = sealed.split(".");
  if (version !== VERSION || !iv || !tag || data === undefined || rest.length) throw new SecretError("Unbekanntes Geheimnisformat.");
  const ivBytes = Buffer.from(iv, "base64url");
  const tagBytes = Buffer.from(tag, "base64url");
  if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) throw new SecretError("Unbekanntes Geheimnisformat.");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, ivBytes, { authTagLength: TAG_BYTES });
    decipher.setAAD(Buffer.from(context, "utf8"));
    decipher.setAuthTag(tagBytes);
    return Buffer.concat([decipher.update(Buffer.from(data, "base64url")), decipher.final()]).toString("utf8");
  } catch {
    throw new SecretError("Geheimnis konnte nicht entschlüsselt werden.");
  }
}

export function resetSecretKeyCache() {
  cached = undefined;
}

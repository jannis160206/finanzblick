import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { AccountError } from "./errors";

const HASH_BYTES = 64;
const SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const DUMMY_HASH = `scrypt-v1$${"00".repeat(16)}$${"00".repeat(HASH_BYTES)}`;
const globalPasswords = globalThis as typeof globalThis & {
  finanzblickScryptActive?: number;
};

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  const active = globalPasswords.finanzblickScryptActive ?? 0;
  if (active >= 2)
    throw new AccountError(
      503,
      "Anmeldung ausgelastet. Bitte gleich erneut versuchen.",
    );
  globalPasswords.finanzblickScryptActive = active + 1;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, HASH_BYTES, SCRYPT_OPTIONS, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
  } finally {
    globalPasswords.finanzblickScryptActive =
      (globalPasswords.finanzblickScryptActive ?? 1) - 1;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await derive(password, salt);
  return `scrypt-v1$${salt.toString("hex")}$${hash.toString("hex")}`;
}

export async function verifyPassword(
  password: string,
  encoded: string | null,
): Promise<boolean> {
  const candidate = encoded ?? DUMMY_HASH;
  const match = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{128})$/.exec(candidate);
  if (!match) throw new Error("Invalid stored password hash");
  const hash = await derive(password, Buffer.from(match[1], "hex"));
  return (
    timingSafeEqual(hash, Buffer.from(match[2], "hex")) && encoded !== null
  );
}

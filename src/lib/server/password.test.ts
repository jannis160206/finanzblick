import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password";

describe("bounded password hashing", () => {
  it("uses random salts, verifies exact passwords, and performs the unknown-user path", async () => {
    const password = "test-password-123456";
    const [first, second] = await Promise.all([
      hashPassword(password),
      hashPassword(password),
    ]);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^scrypt-v1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    expect(await verifyPassword(password, first)).toBe(true);
    expect(await verifyPassword(`${password} `, first)).toBe(false);
    expect(await verifyPassword(password, null)).toBe(false);
  });

  it("rejects hashing work above the two-operation concurrency bound", async () => {
    const first = hashPassword("test-password-one-123");
    const second = hashPassword("test-password-two-123");
    await expect(hashPassword("test-password-three-123")).rejects.toMatchObject(
      { status: 503 },
    );
    await Promise.all([first, second]);
    expect(await verifyPassword("test-password-one-123", await first)).toBe(
      true,
    );
  });
});

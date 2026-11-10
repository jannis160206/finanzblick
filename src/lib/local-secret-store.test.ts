import { webcrypto } from "node:crypto";
import { expect, it } from "vitest";
import { createLocalSecretStore, type SecretBackend } from "./local-secret-store";

function memory(): SecretBackend & { values: Map<string, unknown> } {
  const values = new Map<string, unknown>();
  return {
    values,
    get: async (key) => values.get(key),
    put: async (key, value) => { values.set(key, value); },
    delete: async (key) => { values.delete(key); },
  };
}

it("encrypts device secrets with a non-extractable key and reads them back", async () => {
  const backend = memory();
  const store = createLocalSecretStore(backend, webcrypto.subtle as SubtleCrypto);
  expect(await store.read("payslip-password")).toBeNull();
  await store.write("payslip-password", "synthetisch-123", 1_800_000_000_000);
  expect(await store.info("payslip-password")).toEqual({ updatedAt: 1_800_000_000_000 });
  expect(await store.read("payslip-password")).toBe("synthetisch-123");
  const key = backend.values.get("key") as CryptoKey;
  expect(key.extractable).toBe(false);
  const sealed = backend.values.get("secret:payslip-password") as { data: ArrayBuffer };
  expect(Buffer.from(sealed.data).toString("utf8")).not.toContain("synthetisch");
  await store.remove("payslip-password");
  expect(await store.info("payslip-password")).toBeNull();
});

it("does not decrypt a value copied to another name", async () => {
  const backend = memory();
  const store = createLocalSecretStore(backend, webcrypto.subtle as SubtleCrypto);
  await store.write("payslip-password", "synthetisch-123");
  backend.values.set("secret:other", backend.values.get("secret:payslip-password"));
  await expect(store.read("other")).rejects.toThrow();
});

/** Minimal async key-value storage, e.g. one IndexedDB object store. */
export type SecretBackend = {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
};

type SealedEntry = { iv: Uint8Array; data: ArrayBuffer; updatedAt: number };

const isCryptoKey = (value: unknown): value is CryptoKey =>
  typeof value === "object" && value !== null && "algorithm" in value && "usages" in value && "extractable" in value;
const isSealed = (value: unknown): value is SealedEntry =>
  typeof value === "object" && value !== null && "iv" in value && "data" in value && "updatedAt" in value &&
  typeof value.updatedAt === "number";

/** Device-only secrets: AES-GCM with a non-extractable key that never leaves the browser's key storage. */
export function createLocalSecretStore(backend: SecretBackend, subtle: SubtleCrypto) {
  async function key(): Promise<CryptoKey> {
    const existing = await backend.get("key");
    if (isCryptoKey(existing)) return existing;
    const created = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
    await backend.put("key", created);
    return created;
  }
  const additional = (name: string) => new TextEncoder().encode(`finanzblick:${name}`);
  return {
    async info(name: string): Promise<{ updatedAt: number } | null> {
      const entry = await backend.get(`secret:${name}`);
      return isSealed(entry) ? { updatedAt: entry.updatedAt } : null;
    },
    async read(name: string): Promise<string | null> {
      const entry = await backend.get(`secret:${name}`);
      if (!isSealed(entry)) return null;
      const plain = await subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(entry.iv), additionalData: additional(name) }, await key(), entry.data);
      return new TextDecoder().decode(plain);
    },
    async write(name: string, value: string, now = Date.now()): Promise<{ updatedAt: number }> {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = await subtle.encrypt({ name: "AES-GCM", iv, additionalData: additional(name) }, await key(), new TextEncoder().encode(value));
      await backend.put(`secret:${name}`, { iv, data, updatedAt: now } satisfies SealedEntry);
      return { updatedAt: now };
    },
    async remove(name: string): Promise<void> {
      await backend.delete(`secret:${name}`);
    },
  };
}

export type LocalSecretStore = ReturnType<typeof createLocalSecretStore>;

/** One IndexedDB object store, or null where IndexedDB is unavailable (private modes, tests). */
export function indexedDbBackend(database = "finanzblick-secrets", store = "secrets"): SecretBackend | null {
  if (typeof indexedDB === "undefined") return null;
  let opened: Promise<IDBDatabase> | undefined;
  const connection = () => opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains(store)) request.result.createObjectStore(store); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { opened = undefined; reject(request.error ?? new Error("IndexedDB nicht verfügbar")); };
  });
  const run = async <T>(mode: IDBTransactionMode, action: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await connection();
    return new Promise<T>((resolve, reject) => {
      const request = action(db.transaction(store, mode).objectStore(store));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB-Fehler"));
    });
  };
  return {
    get: (key) => run("readonly", (objects) => objects.get(key)),
    put: async (key, value) => { await run("readwrite", (objects) => objects.put(value, key)); },
    delete: async (key) => { await run("readwrite", (objects) => objects.delete(key)); },
  };
}

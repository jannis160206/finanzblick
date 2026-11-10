export class AccountRequestError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

/** Same-origin JSON request to an account API with the session's account header. */
export async function accountRequest<T>(path: string, account: string, init: RequestInit & { json?: unknown } = {},
  fallback = "Der Server ist nicht erreichbar."): Promise<T> {
  const { json, ...rest } = init;
  const response = await fetch(path, {
    ...rest,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "X-Finanzblick-Account": account, ...(json !== undefined ? { "Content-Type": "application/json" } : {}) },
    ...(json !== undefined ? { body: JSON.stringify(json) } : {}),
  });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body && typeof body.error === "string" ? body.error : fallback;
    throw new AccountRequestError(message, response.status);
  }
  return body as T;
}

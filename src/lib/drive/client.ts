import { DriveAuthError, type Fetcher } from "./oauth";

const API = "https://www.googleapis.com/drive/v3";
const TIMEOUT_MS = 20_000;

export class DriveApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

export async function driveJson<T>(accessToken: string, path: string, params: Record<string, string>, fetcher: Fetcher = fetch): Promise<T> {
  const url = new URL(`${API}${path}`);
  url.search = new URLSearchParams(params).toString();
  let response: Response;
  try {
    response = await fetcher(url, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
  } catch {
    throw new DriveApiError("Google Drive ist gerade nicht erreichbar.", 0);
  }
  if (response.status === 401) throw new DriveAuthError("Die Google-Drive-Freigabe ist abgelaufen. Bitte erneut verbinden.", "expired");
  if (!response.ok) throw new DriveApiError(response.status === 403 ? "Google Drive verweigert den Zugriff (Drive API aktiviert?)." : "Google Drive hat einen Fehler gemeldet.", response.status);
  return await response.json() as T;
}

export async function driveAccount(accessToken: string, fetcher: Fetcher = fetch): Promise<{ email?: string; name?: string }> {
  const about = await driveJson<{ user?: { emailAddress?: string; displayName?: string } }>(accessToken, "/about", { fields: "user(displayName,emailAddress)" }, fetcher);
  return {
    ...(about.user?.emailAddress ? { email: about.user.emailAddress.slice(0, 320) } : {}),
    ...(about.user?.displayName ? { name: about.user.displayName.slice(0, 200) } : {}),
  };
}

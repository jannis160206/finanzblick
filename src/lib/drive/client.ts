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

export type DriveFile = { id: string; name: string; mimeType: string; size?: number; md5Checksum?: string; modifiedTime?: string };
const FOLDER = "application/vnd.google-apps.folder";
const quote = (value: string) => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;

/** Folders with exactly this name (not in the trash), newest first. */
export async function findFolders(accessToken: string, name: string, fetcher: Fetcher = fetch): Promise<DriveFile[]> {
  const result = await driveJson<{ files?: DriveFile[] }>(accessToken, "/files", {
    q: `mimeType = '${FOLDER}' and name = ${quote(name)} and trashed = false`,
    fields: "files(id,name,mimeType,modifiedTime)",
    orderBy: "modifiedTime desc",
    pageSize: "10",
    spaces: "drive",
  }, fetcher);
  return result.files ?? [];
}

/** Files directly in a folder (no subfolders, no Google Docs), at most `limit`. */
export async function listFolderFiles(accessToken: string, folderId: string, fetcher: Fetcher = fetch, limit = 1000): Promise<DriveFile[]> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await driveJson<{ files?: (Omit<DriveFile, "size"> & { size?: string })[]; nextPageToken?: string }>(accessToken, "/files", {
      q: `${quote(folderId)} in parents and trashed = false and mimeType != '${FOLDER}'`,
      fields: "nextPageToken,files(id,name,mimeType,size,md5Checksum,modifiedTime)",
      orderBy: "modifiedTime",
      pageSize: "200",
      spaces: "drive",
      ...(pageToken ? { pageToken } : {}),
    }, fetcher);
    for (const { size, ...file } of page.files ?? []) files.push({ ...file, ...(size !== undefined ? { size: Number(size) } : {}) });
    pageToken = page.nextPageToken;
  } while (pageToken && files.length < limit);
  return files.slice(0, limit);
}

/** Downloads file contents, aborting as soon as more than `maxBytes` arrive. */
export async function downloadFile(accessToken: string, fileId: string, maxBytes: number, fetcher: Fetcher = fetch): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetcher(`${API}/files/${encodeURIComponent(fileId)}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(60_000),
      cache: "no-store",
    });
  } catch {
    throw new DriveApiError("Google Drive ist gerade nicht erreichbar.", 0);
  }
  if (response.status === 401) throw new DriveAuthError("Die Google-Drive-Freigabe ist abgelaufen. Bitte erneut verbinden.", "expired");
  if (!response.ok || !response.body) throw new DriveApiError("Datei konnte nicht aus Google Drive geladen werden.", response.status);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new DriveApiError("Datei ist größer als 20 MB.", 413);
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > maxBytes) {
      await reader.cancel();
      throw new DriveApiError("Datei ist größer als 20 MB.", 413);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

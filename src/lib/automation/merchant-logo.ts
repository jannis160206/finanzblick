import { createHash } from "node:crypto";
import { lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  privateMerchantLogoSchema,
  type PrivateMerchantLogo,
} from "./merchant-logo-metadata";
export {
  privateMerchantLogoSchema,
  type PrivateMerchantLogo,
} from "./merchant-logo-metadata";

const MAX_DOWNLOAD = 2 * 1024 * 1024;
const MAX_PIXELS = 4_000_000;
const MAX_STORED = 256 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const licenses = {
  "CC0 1.0": {
    id: "CC0-1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
  CC0: {
    id: "CC0-1.0",
    url: "https://creativecommons.org/publicdomain/zero/1.0/",
  },
  "Public domain": {
    id: "Public-domain",
    url: "https://creativecommons.org/publicdomain/mark/1.0/",
  },
  "CC BY 4.0": {
    id: "CC-BY-4.0",
    url: "https://creativecommons.org/licenses/by/4.0/",
  },
  "CC BY-SA 4.0": {
    id: "CC-BY-SA-4.0",
    url: "https://creativecommons.org/licenses/by-sa/4.0/",
  },
} as const;

function canonicalLicenseUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (!URL.canParse(value)) return value;
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname !== "creativecommons.org" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    return value;
  url.protocol = "https:";
  url.pathname = url.pathname.replace(/deed\.(?:en|de)\/?$/, "");
  return url.href;
}

function fixedUrl(value: string, host: string, path: string): URL {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.hostname !== host ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.pathname !== path
  )
    throw new Error("Disallowed merchant data URL");
  return url;
}

function allowedRequestUrl(value: string): URL {
  const url = new URL(value);
  if (url.hostname === "overpass-api.de")
    return fixedUrl(value, "overpass-api.de", "/api/interpreter");
  if (url.hostname === "www.wikidata.org")
    return fixedUrl(value, "www.wikidata.org", "/w/api.php");
  if (url.hostname === "commons.wikimedia.org")
    return fixedUrl(value, "commons.wikimedia.org", "/w/api.php");
  if (
    url.protocol !== "https:" ||
    !["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname) ||
    url.port ||
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    !(
      (url.hostname === "upload.wikimedia.org" &&
        /^\/wikipedia\/commons\/[a-f0-9]\/[a-f0-9]{2}\/[^/]+$/.test(
          url.pathname,
        )) ||
      /^\/wikipedia\/commons\/thumb\/[a-f0-9]\/[a-f0-9]{2}\/[^/]+\/(?:[1-9]\d{0,1}|[1-4]\d{2}|50\d|51[0-2])px-[^/]+\.png$/.test(
        url.pathname,
      )
    )
  )
    throw new Error("Disallowed merchant data URL");
  return url;
}

/** Streaming limits apply even when Content-Length is absent or incorrect. */
export async function fetchMerchantBytes(
  url: string,
  options: {
    maxBytes: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    fetch?: typeof fetch;
    body?: string;
    retries?: number;
  },
): Promise<Buffer> {
  const target = allowedRequestUrl(url);
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    options.maxBytes < 1 ||
    options.maxBytes > 4 * 1024 * 1024
  )
    throw new Error("Invalid merchant response limit");
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 10_000);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeout])
    : timeout;
  signal.throwIfAborted();
  const retries = z
    .number()
    .int()
    .min(0)
    .max(2)
    .parse(options.retries ?? 0);
  let response: Response;
  for (let attempt = 0; ; attempt++) {
    response = await (options.fetch ?? fetch)(target, {
      method: options.body === undefined ? "GET" : "POST",
      body: options.body,
      headers: {
        "User-Agent":
          "Finanzblick-local-merchant-import/2.0 (+https://github.com/jannis160206/finanzblick)",
        ...(options.body === undefined
          ? {}
          : { "Content-Type": "application/x-www-form-urlencoded" }),
      },
      redirect: "error",
      credentials: "omit",
      signal,
    });
    if (![429, 503].includes(response.status) || attempt >= retries) break;
    await response.body?.cancel();
    const retryAfter = response.headers.get("retry-after");
    const seconds =
      retryAfter && /^\d+$/.test(retryAfter)
        ? Number(retryAfter)
        : 2 ** attempt;
    if (seconds > 5)
      throw new Error(
        `Merchant source requires a later retry: HTTP ${response.status}`,
      );
    await delay(Math.max(1, seconds) * 1000, undefined, { signal });
  }
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Merchant data request failed: HTTP ${response.status}`);
  }
  if (response.redirected || (response.url && response.url !== target.href))
    throw new Error("Merchant data redirects are forbidden");
  const length = response.headers.get("content-length");
  if (
    length !== null &&
    (!/^\d+$/.test(length) || Number(length) > options.maxBytes)
  ) {
    await response.body?.cancel();
    throw new Error("Merchant response exceeds byte limit");
  }
  if (!response.body) throw new Error("Empty merchant data response");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let received = 0;
  const abort = () => {
    void reader.cancel(signal.reason);
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    while (true) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      received += chunk.value.byteLength;
      if (received > options.maxBytes) {
        await reader.cancel();
        throw new Error("Merchant response exceeds byte limit");
      }
      chunks.push(Buffer.from(chunk.value));
    }
    if (!received) throw new Error("Empty merchant data response");
    return Buffer.concat(chunks, received);
  } finally {
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function fetchMerchantJson(
  url: string,
  options: Parameters<typeof fetchMerchantBytes>[1],
): Promise<unknown> {
  const bytes = await fetchMerchantBytes(url, options);
  return JSON.parse(bytes.toString("utf8")) as unknown;
}

export type MerchantLogoResult =
  | { status: "downloaded"; logo: PrivateMerchantLogo }
  | { status: "skipped"; reason: string };

const logoClaimsSchema = z.object({
  claims: z.object({
    P154: z
      .array(
        z.object({
          rank: z.enum(["preferred", "normal", "deprecated"]),
          mainsnak: z.object({
            snaktype: z.enum(["value", "somevalue", "novalue"]),
            datavalue: z
              .object({ type: z.string(), value: z.unknown() })
              .optional(),
          }),
        }),
      )
      .max(32)
      .optional(),
  }),
});
const metadataSchema = z.object({
  query: z.object({
    pages: z.record(
      z.string(),
      z.object({
        missing: z.unknown().optional(),
        imageinfo: z
          .array(
            z.object({
              url: z.string().url().max(2000),
              size: z.number().int().nonnegative(),
              width: z.number().int().positive(),
              height: z.number().int().positive(),
              mime: z.string().max(100),
              thumburl: z.string().url().max(2000).optional(),
              thumbmime: z.string().max(100).optional(),
              thumbwidth: z.number().int().positive().optional(),
              thumbheight: z.number().int().positive().optional(),
              extmetadata: z.record(
                z.string(),
                z.object({ value: z.string().max(16_000) }),
              ),
            }),
          )
          .max(1)
          .optional(),
      }),
    ),
  }),
});

function plainMetadata(value: string): string {
  return value
    .replace(/<[^>]*>/g, " ")
    .replace(/&(?:nbsp|amp|quot|lt|gt|#39);/g, (entity) => {
      return (
        {
          "&nbsp;": " ",
          "&amp;": "&",
          "&quot;": '"',
          "&lt;": "<",
          "&gt;": ">",
          "&#39;": "'",
        }[entity] ?? entity
      );
    })
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function commonsMediaUrl(
  value: string,
  kind: "original" | "thumbnail",
): string {
  const url = new URL(value);
  if (url.search) {
    if (
      url.searchParams.size !== 3 ||
      url.searchParams.get("utm_source") !== "commons.wikimedia.org" ||
      url.searchParams.get("utm_campaign") !== "imageinfo" ||
      url.searchParams.get("utm_content") !== kind
    )
      throw new Error("Disallowed Commons media query");
    url.search = "";
  }
  return allowedRequestUrl(url.href).href;
}

export async function retrieveMerchantLogo(
  wikidataId: string,
  databasePath: string,
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    retries?: number;
  } = {},
): Promise<MerchantLogoResult> {
  if (!/^Q[1-9]\d{0,11}$/.test(wikidataId))
    throw new Error("Invalid Wikidata entity ID");
  const entityUrl = new URL("https://www.wikidata.org/w/api.php");
  entityUrl.search = new URLSearchParams({
    action: "wbgetclaims",
    entity: wikidataId,
    property: "P154",
    format: "json",
  }).toString();
  const data = logoClaimsSchema.parse(
    await fetchMerchantJson(entityUrl.href, {
      ...options,
      maxBytes: 256 * 1024,
    }),
  );
  const claims = (data.claims.P154 ?? []).filter(
    (claim) => claim.rank !== "deprecated",
  );
  const preferred = claims.filter((claim) => claim.rank === "preferred");
  const selected = preferred.length ? preferred : claims;
  if (selected.length !== 1)
    return {
      status: "skipped",
      reason: selected.length ? "Ambiguous P154 logos" : "No P154 logo",
    };
  const snak = selected[0].mainsnak;
  const filename = snak.datavalue?.value;
  if (
    snak.snaktype !== "value" ||
    snak.datavalue?.type !== "string" ||
    typeof filename !== "string" ||
    filename.length > 240 ||
    /[/\\\x00-\x1f|#]/.test(filename) ||
    !/\.(?:png|jpe?g|webp|svg)$/i.test(filename)
  )
    return {
      status: "skipped",
      reason: "P154 is not a supported, unambiguous image filename",
    };
  const commonsUrl = new URL("https://commons.wikimedia.org/w/api.php");
  commonsUrl.search = new URLSearchParams({
    action: "query",
    titles: `File:${filename}`,
    prop: "imageinfo",
    iiprop: "url|size|mime|thumbmime|extmetadata",
    iiextmetadatafilter:
      "LicenseShortName|LicenseUrl|License|UsageTerms|Copyrighted|AttributionRequired|Artist|Credit|Restrictions",
    iiextmetadatalanguage: "en",
    iiurlwidth: "128",
    iiurlheight: "128",
    format: "json",
  }).toString();
  const metadata = metadataSchema.parse(
    await fetchMerchantJson(commonsUrl.href, {
      ...options,
      maxBytes: 128 * 1024,
    }),
  );
  const pages = Object.values(metadata.query.pages);
  if (pages.length !== 1)
    throw new Error("Commons response must contain one requested file");
  const page = pages[0];
  if (Object.hasOwn(page, "missing") || !page.imageinfo?.length)
    return { status: "skipped", reason: "Commons file is missing" };
  const info = page.imageinfo[0];
  const fields = info.extmetadata;
  const shortName = fields.LicenseShortName?.value;
  const license =
    shortName && Object.hasOwn(licenses, shortName)
      ? licenses[shortName as keyof typeof licenses]
      : undefined;
  const declaredPublicDomain =
    shortName === "Public domain" &&
    !fields.LicenseUrl?.value &&
    fields.License?.value === "pd" &&
    fields.Copyrighted?.value === "False" &&
    fields.AttributionRequired?.value === "false" &&
    fields.UsageTerms?.value === "Public domain";
  if (
    !license ||
    (canonicalLicenseUrl(fields.LicenseUrl?.value) !== license.url &&
      !declaredPublicDomain)
  )
    return {
      status: "skipped",
      reason: "Commons licensing is absent or not explicitly allowlisted",
    };
  const restriction = plainMetadata(
    fields.Restrictions?.value ?? "",
  ).toLowerCase();
  const trademark = ["trademark", "trademarked"].includes(restriction);
  if (restriction && !trademark)
    return { status: "skipped", reason: "Commons lists usage restrictions" };
  const artist = plainMetadata(fields.Artist?.value ?? "");
  const credit = plainMetadata(fields.Credit?.value ?? "");
  if (
    /(?:logos\.fandom\.com|logopedia|logowik\.com|brandsoftheworld\.com|logos-world\.net|1000logos\.net|theslap\.com)/i.test(
      credit,
    )
  )
    return {
      status: "skipped",
      reason: "Commons lists unreviewed upstream logo provenance",
    };
  if (!artist || artist.length + credit.length > 1500)
    return {
      status: "skipped",
      reason: "Missing or oversized Commons attribution",
    };
  if (
    info.size < 1 ||
    info.size > MAX_DOWNLOAD ||
    info.width * info.height > MAX_PIXELS ||
    !(
      ["image/png", "image/jpeg", "image/webp"].includes(info.mime) ||
      (/\.svg$/i.test(filename) && info.mime === "image/svg+xml")
    )
  )
    return { status: "skipped", reason: "Commons image exceeds raster limits" };
  let downloadUrl = commonsMediaUrl(info.url, "original");
  let downloadMime = info.mime;
  if (/\.svg$/i.test(filename)) {
    const original = allowedRequestUrl(downloadUrl);
    const originalPath =
      /^\/wikipedia\/commons\/([a-f0-9]\/[a-f0-9]{2}\/[^/]+)$/.exec(
        original.pathname,
      );
    const thumbnail = info.thumburl
      ? allowedRequestUrl(commonsMediaUrl(info.thumburl, "thumbnail"))
      : null;
    const renderedWidth =
      thumbnail && /\/(\d+)px-[^/]+\.png$/.exec(thumbnail.pathname)?.[1];
    const expected =
      originalPath &&
      renderedWidth &&
      `/wikipedia/commons/thumb/${originalPath[1]}/${renderedWidth}px-${originalPath[1].split("/").at(-1)}.png`;
    if (
      info.mime !== "image/svg+xml" ||
      !info.thumburl ||
      !info.thumbwidth ||
      !info.thumbheight ||
      info.thumbmime !== "image/png" ||
      info.thumbwidth > 128 ||
      info.thumbheight > 128 ||
      !expected ||
      decodeURIComponent(original.pathname.split("/").at(-1)!) !==
        filename.replace(/ /g, "_") ||
      thumbnail?.pathname !== expected
    ) {
      return {
        status: "skipped",
        reason: "No provenance-matched Commons PNG thumbnail for SVG",
      };
    }
    downloadUrl = thumbnail!.href;
    downloadMime = "image/png";
  }
  const bytes = await fetchMerchantBytes(downloadUrl, {
    ...options,
    maxBytes: MAX_DOWNLOAD,
  });
  const signatureMatches =
    (downloadMime === "image/png" &&
      bytes.subarray(0, 8).equals(PNG_SIGNATURE)) ||
    (downloadMime === "image/jpeg" &&
      bytes.length >= 3 &&
      bytes[0] === 0xff &&
      bytes[1] === 0xd8 &&
      bytes[2] === 0xff) ||
    (downloadMime === "image/webp" &&
      bytes.length >= 12 &&
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP");
  if (!signatureMatches)
    return {
      status: "skipped",
      reason: "Downloaded image does not match the licensed raster format",
    };
  const image = sharp(bytes, {
    limitInputPixels: MAX_PIXELS,
    sequentialRead: true,
    failOn: "warning",
  }).timeout({ seconds: 5 });
  let png: Buffer;
  try {
    const imageInfo = await image.metadata();
    if (
      !imageInfo.width ||
      !imageInfo.height ||
      imageInfo.width * imageInfo.height > MAX_PIXELS ||
      !["png", "jpeg", "webp"].includes(imageInfo.format ?? "") ||
      (imageInfo.pages ?? 1) !== 1 ||
      (/\.svg$/i.test(filename) &&
        (imageInfo.width > 512 || imageInfo.height > 512))
    )
      return {
        status: "skipped",
        reason: "Downloaded image is not a safe raster",
      };
    png = await image
      .rotate()
      .resize(128, 128, { fit: "inside", withoutEnlargement: true })
      .png()
      .toBuffer();
  } catch (error) {
    // Only decoder/transform failures are skips; network and filesystem errors propagate.
    if (
      !(error instanceof Error) ||
      !/^(?:Input buffer (?:has corrupt header|contains unsupported image (?:format|type))|Image exceeds pixel limit|(?:png|jpeg|webp)load(?:_buffer)?:|Vips(?:Jpeg|Png|Webp):|timeout:)/i.test(
        error.message,
      )
    )
      throw error;
    return {
      status: "skipped",
      reason: "Raster decoding or normalization failed",
    };
  }
  if (png.length > MAX_STORED)
    throw new Error("Normalized merchant logo exceeds storage limit");
  const file = `${createHash("sha256").update(png).digest("hex")}.png`;
  const sourceUrl = `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename)}`;
  const logoResult = privateMerchantLogoSchema.safeParse({
    file,
    license: license.id,
    attribution: `${artist}${credit ? `; ${credit}` : ""}; Wikimedia Commons; ${sourceUrl}; ${license.id}; resized to PNG${trademark ? "; trademark rights may apply" : ""}; P154 reference: Wikidata ${wikidataId} (CC0-1.0)`,
    sourceUrl,
  });
  if (!logoResult.success)
    return {
      status: "skipped",
      reason: "Commons attribution or source exceeds storage metadata limits",
    };
  const logo = logoResult.data;
  const directory = join(dirname(databasePath), "merchant-logos");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Merchant logo directory must not be a symlink");
  const destination = join(directory, logo.file);
  let handle;
  try {
    handle = await open(destination, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await readPrivateMerchantLogo(databasePath, logo);
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
  return { status: "downloaded", logo };
}

export async function readPrivateMerchantLogo(
  databasePath: string,
  input: unknown,
): Promise<Buffer | null> {
  const parsed = privateMerchantLogoSchema.safeParse(input);
  if (!parsed.success) return null;
  const logo = parsed.data;
  const directory = join(dirname(databasePath), "merchant-logos");
  const file = join(directory, logo.file);
  let data: Buffer;
  try {
    const directoryStat = await lstat(directory);
    const stat = await lstat(file);
    if (
      directoryStat.isSymbolicLink() ||
      !directoryStat.isDirectory() ||
      stat.isSymbolicLink() ||
      !stat.isFile() ||
      stat.size < 24 ||
      stat.size > MAX_STORED
    )
      return null;
    const handle = await open(file, "r");
    try {
      const openedStat = await handle.stat();
      if (!openedStat.isFile() || openedStat.size > MAX_STORED) return null;
      // A concurrent file change must not turn a small cache read into an unbounded allocation.
      const bounded = Buffer.alloc(MAX_STORED + 1);
      let received = 0;
      while (received < bounded.length) {
        const chunk = await handle.read(
          bounded,
          received,
          bounded.length - received,
          received,
        );
        if (!chunk.bytesRead) break;
        received += chunk.bytesRead;
      }
      data = bounded.subarray(0, received);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (
    data.length < 24 ||
    data.length > MAX_STORED ||
    !data.subarray(0, 8).equals(PNG_SIGNATURE) ||
    data.toString("ascii", 12, 16) !== "IHDR" ||
    data.readUInt32BE(16) < 1 ||
    data.readUInt32BE(16) > 128 ||
    data.readUInt32BE(20) < 1 ||
    data.readUInt32BE(20) > 128 ||
    `${createHash("sha256").update(data).digest("hex")}.png` !== logo.file
  )
    return null;
  return data;
}

export async function merchantAttribution(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Keep Next/account runtime imports out of the operator-only CLI import path.
  const [{ authorizeApi, isAccountMode }, { accountErrorResponse }] =
    await Promise.all([
      import("@/lib/server/auth"),
      import("@/lib/server/http"),
    ]);
  const denied = await authorizeApi(request);
  if (denied) return denied;
  const headers = {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  };
  const missing = () => new Response("Not found", { status: 404, headers });
  try {
    if (!isAccountMode()) return missing();
    const { id } = await params;
    if (!id || id.length > 80 || /[\x00-\x1f]/.test(id)) return missing();
    const [{ getAccountRuntime }, { AutomationStore }] = await Promise.all([
      import("@/lib/server/runtime"),
      import("@/lib/automation/store"),
    ]);
    const { database } = await getAccountRuntime();
    const store = new AutomationStore(database);
    const merchant = store.getMerchant(id);
    const version = new URL(request.url).searchParams.get("v");
    if (version !== null && !/^[a-f0-9]{64}$/.test(version)) return missing();
    const archived =
      version !== null ? store.logoAttribution(id, version) : null;
    if ((version !== null && !archived) || (!merchant && !archived))
      return missing();
    const logoMetadata = version !== null ? archived?.logo : merchant?.logo;
    const lines = [
      `Händler: ${archived?.canonicalName ?? merchant?.canonicalName}`,
      `Datenquelle: ${merchant?.source ?? "Archivierte Logo-Version"}`,
      `Datenlizenz: ${merchant?.license ?? "Nicht angegeben"}`,
      `Daten-Quellenangabe: ${merchant?.attribution ?? "Nicht angegeben"}`,
    ];
    if (logoMetadata) {
      const parsed = privateMerchantLogoSchema.safeParse(logoMetadata);
      if (!parsed.success) return missing();
      const logo = parsed.data;
      lines.push(
        "",
        `Logo-Lizenz: ${logo.license}`,
        `Logo-Originalquelle: ${new URL(logo.sourceUrl).href}`,
        `Logo-Quellenangabe und Bearbeitung: ${logo.attribution}`,
        "",
        "Die Logo-Lizenz klärt keine unabhängig geltenden Markenrechte oder sonstigen Rechte.",
      );
    } else lines.push("", "Logo: Nicht verfügbar.");
    return new Response(`${lines.join("\n")}\n`, { headers });
  } catch (error) {
    return accountErrorResponse(error);
  }
}

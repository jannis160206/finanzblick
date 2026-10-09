import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  privateMerchantLogoSchema,
  type PrivateMerchantLogo,
} from "./merchant-logo-metadata";
import {
  logoContentFile,
  logoRasterMime,
  normalizeLogoRaster,
  readStoredLogoPng,
  writeStoredLogoPng,
} from "./merchant-logo-raster";
import {
  publicLogoRightsSchema,
  type PublicLogoRights,
} from "./merchant-logo-grant-metadata";
export {
  privateMerchantLogoSchema,
  type PrivateMerchantLogo,
} from "./merchant-logo-metadata";

const MAX_DOWNLOAD = 2 * 1024 * 1024;
const MAX_PIXELS = 4_000_000;
export const commonsLogoFilenameSchema = z
  .string()
  .min(1)
  .max(240)
  .regex(/\.(?:png|jpe?g|webp|svg)$/i)
  .refine((filename) => !/[/\\\x00-\x1f|#]/.test(filename));
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

function provenanceMatchedCommonsPngThumbnail(
  original: URL,
  info: {
    thumburl?: string;
    thumbmime?: string;
    thumbwidth?: number;
    thumbheight?: number;
  },
  originalIsPng: boolean,
): string | null {
  if (
    !info.thumburl ||
    !info.thumbwidth ||
    !info.thumbheight ||
    info.thumbwidth > 128 ||
    info.thumbheight > 128 ||
    info.thumbmime !== "image/png"
  )
    return null;
  const source = /^\/wikipedia\/commons\/([a-f0-9]\/[a-f0-9]{2}\/[^/]+)$/.exec(
    original.pathname,
  );
  const thumbnail = allowedRequestUrl(
    commonsMediaUrl(info.thumburl, "thumbnail"),
  );
  const width =
    thumbnail && /\/(\d+)px-[^/]+\.png$/.exec(thumbnail.pathname)?.[1];
  const filename = source?.[1].split("/").at(-1);
  const expected =
    source &&
    width &&
    filename &&
    `/wikipedia/commons/thumb/${source[1]}/${width}px-${filename}${originalIsPng ? "" : ".png"}`;
  if (!expected || thumbnail.pathname !== expected) return null;
  return thumbnail.href;
}

type CommonsRasterResult =
  | {
      status: "downloaded";
      png: Buffer;
      sourceUrl: string;
      attribution: string;
      publicRights: PublicLogoRights;
      publicLicense: PrivateMerchantLogo["license"] | null;
    }
  | { status: "skipped"; reason: string };

async function retrieveCommonsRaster(
  wikidataId: string,
  policy: "public-license" | "operator-private",
  options: {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    retries?: number;
    filename?: string;
  } = {},
): Promise<CommonsRasterResult> {
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
  const candidates = preferred.length ? preferred : claims;
  const requestedFilename =
    policy === "operator-private" && options.filename !== undefined
      ? commonsLogoFilenameSchema.parse(options.filename)
      : undefined;
  const selected = requestedFilename
    ? candidates.filter(
        (claim) => claim.mainsnak.datavalue?.value === requestedFilename,
      )
    : candidates;
  if (requestedFilename && selected.length === 0)
    return {
      status: "skipped",
      reason: "Selected logo is not an active P154 candidate",
    };
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
  const publicLicense =
    license &&
    (canonicalLicenseUrl(fields.LicenseUrl?.value) === license.url ||
      declaredPublicDomain)
      ? license.id
      : null;
  if (
    policy === "public-license" &&
    (!license ||
      (canonicalLicenseUrl(fields.LicenseUrl?.value) !== license.url &&
        !declaredPublicDomain))
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
    policy === "public-license" &&
    /(?:logos\.fandom\.com|logopedia|logowik\.com|brandsoftheworld\.com|logos-world\.net|1000logos\.net|theslap\.com)/i.test(
      credit,
    )
  )
    return {
      status: "skipped",
      reason: "Commons lists unreviewed upstream logo provenance",
    };
  if (
    (policy === "public-license" && !artist) ||
    artist.length + credit.length > 1500
  )
    return {
      status: "skipped",
      reason: "Missing or oversized Commons attribution",
    };
  const oversizedOriginal =
    info.size > MAX_DOWNLOAD || info.width * info.height > MAX_PIXELS;
  const authorizedRasterThumbnail =
    policy === "operator-private" &&
    oversizedOriginal &&
    (["image/png", "image/jpeg"].includes(info.mime) ||
      (/\.svg$/i.test(filename) && info.mime === "image/svg+xml"));
  if (
    info.size < 1 ||
    (oversizedOriginal && !authorizedRasterThumbnail) ||
    !(
      ["image/png", "image/jpeg", "image/webp"].includes(info.mime) ||
      (/\.svg$/i.test(filename) && info.mime === "image/svg+xml")
    )
  )
    return { status: "skipped", reason: "Commons image exceeds raster limits" };
  let downloadUrl = commonsMediaUrl(info.url, "original");
  const originalUrl = new URL(downloadUrl);
  const originalName = originalUrl.pathname.split("/").at(-1);
  if (
    originalUrl.hostname !== "upload.wikimedia.org" ||
    !/^\/wikipedia\/commons\/[a-f0-9]\/[a-f0-9]{2}\/[^/]+$/.test(
      originalUrl.pathname,
    ) ||
    !originalName ||
    decodeURIComponent(originalName) !== filename.replace(/ /g, "_")
  )
    return {
      status: "skipped",
      reason: "Commons original does not match requested P154 file",
    };
  let downloadMime = info.mime;
  const svg = /\.svg$/i.test(filename);
  const downloadThumbnail = svg || authorizedRasterThumbnail;
  if (downloadThumbnail) {
    const thumbnail = provenanceMatchedCommonsPngThumbnail(
      originalUrl,
      info,
      info.mime === "image/png",
    );
    if (!thumbnail || (svg && info.mime !== "image/svg+xml")) {
      return {
        status: "skipped",
        reason: svg
          ? "No provenance-matched Commons PNG thumbnail for SVG"
          : "No provenance-matched Commons PNG thumbnail for oversized raster",
      };
    }
    downloadUrl = thumbnail;
    downloadMime = "image/png";
  }
  const bytes = await fetchMerchantBytes(downloadUrl, {
    ...options,
    maxBytes: MAX_DOWNLOAD,
  });
  if (logoRasterMime(bytes) !== downloadMime)
    return {
      status: "skipped",
      reason: "Downloaded image does not match the licensed raster format",
    };
  const png = await normalizeLogoRaster(bytes, {
    mime: downloadMime,
    commonsThumbnail: downloadThumbnail,
  });
  if (!png)
    return {
      status: "skipped",
      reason: "Raster decoding or normalization failed",
    };
  const sourceUrl = `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(filename)}`;
  const publicRights = publicLogoRightsSchema.safeParse({
    license: publicLicense,
    licenseName: plainMetadata(shortName ?? "") || null,
    licenseUrl: plainMetadata(fields.LicenseUrl?.value ?? "") || null,
    usageTerms: plainMetadata(fields.UsageTerms?.value ?? "") || null,
    restrictions: restriction || null,
    artist: artist || null,
    credit: credit || null,
  });
  if (!publicRights.success)
    return {
      status: "skipped",
      reason: "Commons rights metadata exceeds limits",
    };
  const attribution = `${artist || "Commons artist not specified"}${credit ? `; ${credit}` : ""}; Wikimedia Commons; ${sourceUrl}; ${publicLicense ?? "No verified public licence"}; resized to PNG${trademark ? "; trademark rights may apply" : ""}; P154 reference: Wikidata ${wikidataId} (CC0-1.0)`;
  if (
    attribution.length > 2000 ||
    !privateMerchantLogoSchema.shape.sourceUrl.safeParse(sourceUrl).success
  )
    return {
      status: "skipped",
      reason: "Commons attribution or source exceeds storage metadata limits",
    };
  return {
    status: "downloaded",
    png,
    sourceUrl,
    publicLicense,
    publicRights: publicRights.data,
    attribution,
  };
}

/** This path returns raster/provenance only, never metadata accepted by global merchants. */
export async function retrieveAuthorizedCommonsRaster(
  wikidataId: string,
  options: Parameters<typeof retrieveCommonsRaster>[2] = {},
): Promise<CommonsRasterResult> {
  return retrieveCommonsRaster(wikidataId, "operator-private", options);
}

export async function retrieveMerchantLogo(
  wikidataId: string,
  databasePath: string,
  options: Parameters<typeof retrieveCommonsRaster>[2] = {},
): Promise<MerchantLogoResult> {
  const result = await retrieveCommonsRaster(
    wikidataId,
    "public-license",
    options,
  );
  if (result.status === "skipped") return result;
  const { png, sourceUrl, attribution, publicLicense } = result;
  const logoResult = privateMerchantLogoSchema.safeParse({
    file: logoContentFile(png),
    license: publicLicense,
    attribution,
    sourceUrl,
  });
  if (!logoResult.success)
    return {
      status: "skipped",
      reason: "Commons attribution or source exceeds storage metadata limits",
    };
  const logo = logoResult.data;
  await writeStoredLogoPng(join(dirname(databasePath), "merchant-logos"), png);
  return { status: "downloaded", logo };
}

export async function readPrivateMerchantLogo(
  databasePath: string,
  input: unknown,
): Promise<Buffer | null> {
  const parsed = privateMerchantLogoSchema.safeParse(input);
  if (!parsed.success) return null;
  return readStoredLogoPng(
    join(dirname(databasePath), "merchant-logos"),
    parsed.data.file,
  );
}

export async function merchantAttribution(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  // Keep Next/account runtime imports out of the operator-only CLI import path.
  const [
    { authorizeApi, isAccountMode },
    { accountErrorResponse, requestSessionToken },
  ] = await Promise.all([
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
    Vary: "Cookie",
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
    const user = database.currentUser(requestSessionToken(request));
    if (!user) return missing();
    const store = new AutomationStore(database);
    const merchant = store.getMerchant(id);
    const version = new URL(request.url).searchParams.get("v");
    if (version !== null && !/^[a-f0-9]{64}$/.test(version)) return missing();
    const grant = /^[a-zA-Z0-9_-]{1,80}$/.test(id)
      ? store.authorizedLogo(user.id, id, version ?? undefined)
      : null;
    if (grant) {
      const logo = grant.logo;
      const rights = logo.publicRights;
      const lines = [
        `Händler: ${grant.canonicalName}`,
        `Logo-Berechtigung: Private Nutzung ausschließlich für dieses Konto`,
        `Berechtigungsgrundlage: ${logo.permission}`,
        `Rechte-Referenz (Betreiber-/Nutzererklärung; kein geprüfter Lizenznachweis): ${logo.rightsReference}`,
        `Logo-Quellenangabe und Bearbeitung: ${logo.attribution}`,
        `Logo-Originalquelle: ${
          logo.provenance.kind === "commons"
            ? logo.provenance.sourceUrl
            : `Lokal bereitgestellt: ${logo.provenance.sourceLabel}`
        }`,
        `Öffentliche Logo-Lizenz: ${rights?.license ?? "Nicht verifiziert / nicht angegeben"}`,
      ];
      if (rights)
        lines.push(
          `Öffentliche Lizenzbezeichnung: ${rights.licenseName ?? "Nicht angegeben"}`,
          `Öffentliche Lizenz-URL (Quellenmetadaten): ${rights.licenseUrl ?? "Nicht angegeben"}`,
          `Öffentliche Nutzungsbedingungen: ${rights.usageTerms ?? "Nicht angegeben"}`,
          `Öffentliche Einschränkungen: ${rights.restrictions ?? "Nicht angegeben"}`,
          `Öffentliche Künstlerangabe: ${rights.artist ?? "Nicht angegeben"}`,
          `Öffentliche Quellenangabe: ${rights.credit ?? "Nicht angegeben"}`,
        );
      lines.push(
        "",
        "Die private Rechteerklärung ist keine globale Freigabe und ersetzt keine öffentliche Lizenz.",
      );
      return new Response(`${lines.join("\n")}\n`, { headers });
    }
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

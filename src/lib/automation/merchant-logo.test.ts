import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchMerchantBytes,
  fetchMerchantJson,
  privateMerchantLogoSchema,
  readPrivateMerchantLogo,
  retrieveMerchantLogo,
} from "./merchant-logo";

const directories: string[] = [];
async function privateDatabase() {
  const directory = resolve(
    ".local-data",
    `merchant-logo-test-${randomUUID()}`,
  );
  directories.push(directory);
  await mkdir(directory, { recursive: true });
  return join(directory, "accounts.sqlite");
}
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});
const filename = "Example logo.png";
const upload =
  "https://upload.wikimedia.org/wikipedia/commons/a/ab/Example_logo.png";
const claim = (name = filename, rank = "normal") => ({
  rank,
  mainsnak: {
    snaktype: "value",
    datavalue: { type: "string", value: name },
  },
});
const entity = (claims = [claim()]) => ({
  claims: { P154: claims },
});
const imageinfo = (overrides = {}) => ({
  url: upload,
  size: 1024,
  width: 300,
  height: 150,
  mime: "image/png",
  extmetadata: {
    LicenseShortName: { value: "CC BY 4.0" },
    LicenseUrl: { value: "https://creativecommons.org/licenses/by/4.0/" },
    Artist: { value: '<a href="https://example.org">Example Artist</a>' },
    Credit: { value: "Original creator" },
  },
  ...overrides,
});
const commons = (overrides = {}) => ({
  query: { pages: { "7": { imageinfo: [imageinfo(overrides)] } } },
});
async function png() {
  return sharp({
    create: {
      width: 300,
      height: 150,
      channels: 4,
      background: { r: 10, g: 20, b: 30, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}
function network(responses: Response[]) {
  const request = vi.fn<typeof fetch>();
  for (const response of responses) request.mockResolvedValueOnce(response);
  return request;
}

describe("fixed, bounded merchant data network", () => {
  it("rejects arbitrary hosts, userinfo, paths, ports and non-HTTPS before fetching", async () => {
    const request = vi.fn<typeof fetch>();
    for (const url of [
      "https://evil.example/image.png",
      "http://www.wikidata.org/w/api.php",
      "https://www.wikidata.org.evil.example/w/api.php",
      "https://user:pass@www.wikidata.org/w/api.php",
      "https://www.wikidata.org:444/w/api.php",
      "https://commons.wikimedia.org/wiki/File:Example.png",
      "https://overpass-api.de/arbitrary",
      "https://upload.wikimedia.org/other/example.png",
      "https://upload.wikimedia.org/wikipedia/commons/a/ab/image.png?redirect=x",
      "https://upload.wikimedia.org/wikipedia/commons/a/ab/../../evil.png",
    ])
      await expect(
        fetchMerchantBytes(url, { maxBytes: 10, fetch: request }),
      ).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects non-2xx, oversized declared/streamed bodies and invalid JSON", async () => {
    for (const response of [
      new Response("bad", { status: 403 }),
      new Response("123", { headers: { "Content-Length": "20" } }),
      new Response("123456"),
      new Response(null),
    ]) {
      const request = network([response]);
      await expect(
        fetchMerchantBytes("https://www.wikidata.org/w/api.php", {
          maxBytes: 5,
          fetch: request,
        }),
      ).rejects.toThrow();
    }
    await expect(
      fetchMerchantJson("https://www.wikidata.org/w/api.php", {
        maxBytes: 100,
        fetch: network([new Response("not-json")]),
      }),
    ).rejects.toThrow();
  });

  it("forbids redirects explicitly and passes abort signals", async () => {
    const redirected = new Response("ok");
    Object.defineProperty(redirected, "redirected", { value: true });
    const request = network([redirected]);
    await expect(
      fetchMerchantBytes(upload, { maxBytes: 10, fetch: request }),
    ).rejects.toThrow("redirects");
    expect(request.mock.calls[0][1]).toMatchObject({
      redirect: "error",
      credentials: "omit",
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      fetchMerchantBytes(upload, {
        maxBytes: 10,
        signal: controller.signal,
        fetch: network([new Response("ok")]),
      }),
    ).rejects.toThrow();
  });
});

describe("Commons-generated raster logos", () => {
  const svgMetadata = () => ({
    query: {
      pages: {
        "7": {
          imageinfo: [
            {
              ...imageinfo(),
              url: "https://upload.wikimedia.org/wikipedia/commons/a/ab/Example_logo.svg",
              mime: "image/svg+xml",
              thumburl:
                "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Example_logo.svg/250px-Example_logo.svg.png",
              thumbmime: "image/png",
              thumbwidth: 128,
              thumbheight: 64,
            },
          ],
        },
      },
    },
  });
  it("downloads a provenance-matched Commons PNG, never the source SVG", async () => {
    const request = network([
      Response.json(entity([claim("Example logo.svg")])),
      Response.json(svgMetadata()),
      new Response(new Uint8Array(await png())),
    ]);
    const result = await retrieveMerchantLogo("Q123", await privateDatabase(), {
      fetch: request,
    });
    expect(result.status).toBe("downloaded");
    expect(String(request.mock.calls[2][0])).toContain("thumb.wikimedia.org");
    expect(String(request.mock.calls[2][0])).toMatch(/\.svg\.png$/);
    expect(
      request.mock.calls
        .map((call) => String(call[0]))
        .filter((url) => url.endsWith(".svg")),
    ).toEqual([]);
  });
  it("retains public Commons-only retrieval with the exact imageinfo tracking triplets and thumbnail alias", async () => {
    const metadata = svgMetadata();
    const info = metadata.query.pages["7"].imageinfo[0];
    info.url +=
      "?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=original";
    info.thumburl +=
      "?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail";
    const request = network([
      Response.json(entity([claim("Example logo.svg")])),
      Response.json(metadata),
      new Response(new Uint8Array(await png())),
    ]);
    expect(
      await retrieveMerchantLogo("Q123", await privateDatabase(), {
        fetch: request,
      }),
    ).toMatchObject({ status: "downloaded", logo: { license: "CC-BY-4.0" } });
    expect(String(request.mock.calls[2][0])).toBe(
      "https://thumb.wikimedia.org/wikipedia/commons/thumb/a/ab/Example_logo.svg/250px-Example_logo.svg.png",
    );
    expect(
      request.mock.calls.every(
        ([url]) =>
          !String(url).includes("de.wikipedia.org") &&
          !String(url).endsWith(".svg"),
      ),
    ).toBe(true);
  });
  it.each([
    { thumburl: undefined },
    { thumbmime: "image/svg+xml" },
    { thumbwidth: 129 },
    {
      thumburl:
        "https://upload.wikimedia.org/wikipedia/commons/thumb/a/ab/Other.svg/128px-Other.svg.png",
    },
    {
      thumburl:
        "https://thumb.wikimedia.org/wikipedia/commons/thumb/b/bb/Example_logo.svg/128px-Example_logo.svg.png",
    },
  ])(
    "rejects incomplete or mismatched thumbnail provenance %#",
    async (overrides) => {
      const metadata = svgMetadata();
      Object.assign(metadata.query.pages["7"].imageinfo[0], overrides);
      const request = network([
        Response.json(entity([claim("Example logo.svg")])),
        Response.json(metadata),
      ]);
      expect(
        await retrieveMerchantLogo("Q123", await privateDatabase(), {
          fetch: request,
        }),
      ).toMatchObject({ status: "skipped" });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  it("accepts only affirmative public-domain declarations when no license URL exists", async () => {
    const declaration = {
      Artist: { value: "Example creator" },
      LicenseShortName: { value: "Public domain" },
      License: { value: "pd" },
      Copyrighted: { value: "False" },
      AttributionRequired: { value: "false" },
      UsageTerms: { value: "Public domain" },
      Restrictions: { value: "trademarked" },
    };
    const request = network([
      Response.json(entity()),
      Response.json(commons({ extmetadata: declaration })),
      new Response(new Uint8Array(await png())),
    ]);
    const result = await retrieveMerchantLogo("Q123", await privateDatabase(), {
      fetch: request,
    });
    expect(result).toMatchObject({
      status: "downloaded",
      logo: {
        license: "Public-domain",
        attribution: expect.stringContaining("trademark rights may apply"),
      },
    });
    for (const overrides of [
      { Copyrighted: { value: "True" } },
      { License: { value: "fairuse" } },
      { AttributionRequired: { value: "true" } },
      { UsageTerms: { value: "" } },
      { LicenseUrl: { value: "https://evil.example" } },
      { Restrictions: { value: "trademarked, noncommercial" } },
    ]) {
      const denied = network([
        Response.json(entity()),
        Response.json(
          commons({ extmetadata: { ...declaration, ...overrides } }),
        ),
      ]);
      expect(
        await retrieveMerchantLogo("Q123", await privateDatabase(), {
          fetch: denied,
        }),
      ).toMatchObject({ status: "skipped" });
      expect(denied).toHaveBeenCalledTimes(2);
    }
  });
});

describe("explicit Commons license gate and private PNG cache", () => {
  it("accepts only documented canonical-equivalent CC0 URLs, never a guessed or missing license", async () => {
    const original = imageinfo().extmetadata;
    const declaration = {
      ...original,
      LicenseShortName: { value: "CC0" },
      LicenseUrl: {
        value: "http://creativecommons.org/publicdomain/zero/1.0/deed.en",
      },
    };
    const request = network([
      Response.json(entity()),
      Response.json(commons({ extmetadata: declaration })),
      new Response(new Uint8Array(await png())),
    ]);
    expect(
      await retrieveMerchantLogo("Q123", await privateDatabase(), {
        fetch: request,
      }),
    ).toMatchObject({ status: "downloaded", logo: { license: "CC0-1.0" } });
    for (const url of [
      "",
      "not a URL",
      "https://creativecommons.org.evil.example/publicdomain/zero/1.0/",
      "https://creativecommons.org/publicdomain/zero/1.0/?permission=private",
      "https://creativecommons.org/licenses/by-nc/4.0/",
    ]) {
      const denied = network([
        Response.json(entity()),
        Response.json(
          commons({
            extmetadata: { ...declaration, LicenseUrl: { value: url } },
          }),
        ),
      ]);
      expect(
        await retrieveMerchantLogo("Q123", await privateDatabase(), {
          fetch: denied,
        }),
      ).toMatchObject({ status: "skipped" });
      expect(denied).toHaveBeenCalledTimes(2);
    }
  });
  it.each([
    "logos.fandom.com",
    "Logopedia",
    "logowik.com",
    "brandsoftheworld.com",
  ])(
    "does not proxy unresolved collection-origin artwork through Commons: %s",
    async (source) => {
      const request = network([
        Response.json(entity()),
        Response.json(
          commons({
            extmetadata: {
              ...imageinfo().extmetadata,
              Credit: { value: source },
            },
          }),
        ),
      ]);
      expect(
        await retrieveMerchantLogo("Q123", await privateDatabase(), {
          fetch: request,
        }),
      ).toMatchObject({
        status: "skipped",
        reason: expect.stringContaining("provenance"),
      });
      expect(request).toHaveBeenCalledTimes(2);
    },
  );
  it("downloads only after checking licensing, normalizes and idempotently caches content", async () => {
    const databasePath = await privateDatabase();
    const image = await png();
    const run = async () => {
      const request = network([
        Response.json(entity()),
        Response.json(commons()),
        new Response(new Uint8Array(image)),
      ]);
      const result = await retrieveMerchantLogo("Q123", databasePath, {
        fetch: request,
      });
      expect(request).toHaveBeenCalledTimes(3);
      expect(new URL(String(request.mock.calls[0][0])).hostname).toBe(
        "www.wikidata.org",
      );
      const entityRequest = new URL(String(request.mock.calls[0][0]));
      expect(entityRequest.searchParams.get("action")).toBe("wbgetclaims");
      expect(entityRequest.searchParams.get("property")).toBe("P154");
      expect(entityRequest.searchParams.get("entity")).toBe("Q123");
      expect(entityRequest.searchParams.has("props")).toBe(false);
      expect(new URL(String(request.mock.calls[1][0])).hostname).toBe(
        "commons.wikimedia.org",
      );
      expect(String(request.mock.calls[2][0])).toBe(upload);
      expect(result.status).toBe("downloaded");
      if (result.status !== "downloaded") throw new Error("Expected download");
      expect(result.logo.file).toMatch(/^[a-f0-9]{64}\.png$/);
      expect(result.logo.license).toBe("CC-BY-4.0");
      expect(result.logo.attribution).toContain("Example Artist");
      expect(result.logo.attribution).not.toContain("<a");
      expect(result.logo.sourceUrl).toBe(
        "https://commons.wikimedia.org/wiki/File:Example%20logo.png",
      );
      const bytes = await readPrivateMerchantLogo(databasePath, result.logo);
      expect(bytes).not.toBeNull();
      expect(await sharp(bytes!).metadata()).toMatchObject({
        format: "png",
        width: 128,
        height: 64,
      });
      expect(
        await readFile(
          join(databasePath, "..", "merchant-logos", result.logo.file),
        ),
      ).toEqual(bytes);
      return result.logo;
    };
    expect(await run()).toEqual(await run());
  });

  it.each([
    [
      "CC0 1.0",
      "https://creativecommons.org/publicdomain/zero/1.0/",
      "CC0-1.0",
    ],
    [
      "CC BY-SA 4.0",
      "https://creativecommons.org/licenses/by-sa/4.0/",
      "CC-BY-SA-4.0",
    ],
    [
      "Public domain",
      "https://creativecommons.org/publicdomain/mark/1.0/",
      "Public-domain",
    ],
  ])(
    "requires explicit matching Commons metadata for %s before downloading and serving",
    async (shortName, licenseUrl, license) => {
      const databasePath = await privateDatabase();
      const request = network([
        Response.json(entity()),
        Response.json(
          commons({
            extmetadata: {
              ...imageinfo().extmetadata,
              LicenseShortName: { value: shortName },
              LicenseUrl: { value: licenseUrl },
            },
          }),
        ),
        new Response(new Uint8Array(await png())),
      ]);
      const result = await retrieveMerchantLogo("Q123", databasePath, {
        fetch: request,
      });
      expect(result.status).toBe("downloaded");
      if (result.status !== "downloaded") throw new Error("Expected download");
      expect(result.logo.license).toBe(license);
      expect(result.logo.attribution).toContain("Wikidata Q123 (CC0-1.0)");
      expect(
        await readPrivateMerchantLogo(databasePath, result.logo),
      ).not.toBeNull();
    },
  );

  it("reports no logo, ambiguity or malformed P154 without file requests", async () => {
    const databasePath = await privateDatabase();
    for (const claims of [
      [],
      [claim(), claim("Other.png")],
      [claim("../../path.png")],
      [claim("Logo.png", "deprecated")],
    ]) {
      const request = network([Response.json(entity(claims))]);
      const result = await retrieveMerchantLogo("Q123", databasePath, {
        fetch: request,
      });
      expect(result).toMatchObject({
        status: "skipped",
        reason: expect.any(String),
      });
      expect(request).toHaveBeenCalledTimes(1);
    }
  });

  it("allows only a unique preferred P154 claim", async () => {
    const databasePath = await privateDatabase();
    const request = network([
      Response.json(entity([claim("Other.png"), claim(filename, "preferred")])),
      Response.json(commons({ extmetadata: {} })),
    ]);
    await retrieveMerchantLogo("Q123", databasePath, { fetch: request });
    const url = new URL(String(request.mock.calls[1][0]));
    expect(url.searchParams.get("titles")).toBe(`File:${filename}`);
  });

  it("does not download unlicensed, mismatched, restricted or unattributed Commons files", async () => {
    const databasePath = await privateDatabase();
    const original = imageinfo().extmetadata;
    for (const extmetadata of [
      {},
      { ...original, LicenseShortName: { value: "Fair use" } },
      {
        ...original,
        LicenseShortName: { value: "__proto__" },
        LicenseUrl: undefined,
      },
      { ...original, LicenseUrl: { value: "https://evil.example/license" } },
      { ...original, Restrictions: { value: "personality rights" } },
      { ...original, Artist: { value: "" } },
    ]) {
      const request = network([
        Response.json(entity()),
        Response.json(commons({ extmetadata })),
      ]);
      const result = await retrieveMerchantLogo("Q123", databasePath, {
        fetch: request,
      });

      expect(result).toMatchObject({
        status: "skipped",
        reason: expect.any(String),
      });
      expect(request).toHaveBeenCalledTimes(2);
    }
  });

  it("reports oversized/non-raster Commons files before downloading", async () => {
    const databasePath = await privateDatabase();
    for (const overrides of [
      { size: 2 * 1024 * 1024 + 1 },
      { width: 3000, height: 2000 },
      { mime: "image/svg+xml" },
    ]) {
      const request = network([
        Response.json(entity()),
        Response.json(commons(overrides)),
      ]);
      expect(
        await retrieveMerchantLogo("Q123", databasePath, { fetch: request }),
      ).toMatchObject({
        status: "skipped",
        reason: expect.stringContaining("limits"),
      });
      expect(request).toHaveBeenCalledTimes(2);
    }
  });

  it("reports invalid raster downloads and does not silently swallow API failures", async () => {
    const databasePath = await privateDatabase();
    const request = network([
      Response.json(entity()),
      Response.json(commons()),
      new Response("not an image"),
    ]);
    expect(
      await retrieveMerchantLogo("Q123", databasePath, { fetch: request }),
    ).toEqual({
      status: "skipped",
      reason: "Downloaded image does not match the licensed raster format",
    });
    const corrupt = network([
      Response.json(entity()),
      Response.json(commons()),
      new Response(
        new Uint8Array([
          137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82,
        ]),
      ),
    ]);
    expect(
      await retrieveMerchantLogo("Q123", databasePath, { fetch: corrupt }),
    ).toEqual({
      status: "skipped",
      reason: "Raster decoding or normalization failed",
    });
    for (const responses of [
      [new Response("bad", { status: 429 })],
      [Response.json({ error: "invalid" })],
      [Response.json(entity()), Response.json({ error: "invalid" })],
      [
        Response.json(entity()),
        Response.json(commons({ url: "https://evil.example/logo.png" })),
      ],
    ]) {
      await expect(
        retrieveMerchantLogo("Q123", databasePath, {
          fetch: network(responses),
        }),
      ).rejects.toThrow();
    }
    const invalidId = vi.fn<typeof fetch>();
    await expect(
      retrieveMerchantLogo("https://evil.example", databasePath, {
        fetch: invalidId,
      }),
    ).rejects.toThrow("entity ID");
    expect(invalidId).not.toHaveBeenCalled();
  });

  it("never serves missing, unlicensed, traversal, tampered or oversized cache files", async () => {
    const databasePath = await privateDatabase();
    const request = network([
      Response.json(entity()),
      Response.json(commons()),
      new Response(new Uint8Array(await png())),
    ]);
    const result = await retrieveMerchantLogo("Q123", databasePath, {
      fetch: request,
    });
    if (result.status !== "downloaded") throw new Error("Expected download");
    for (const input of [
      null,
      { ...result.logo, file: "../accounts.sqlite" },
      { ...result.logo, file: result.logo.file.toUpperCase() },
      { ...result.logo, license: "Unlicensed" },
      { ...result.logo, attribution: "" },
      { ...result.logo, sourceUrl: "https://evil.example/logo" },
      {
        ...result.logo,
        sourceUrl:
          "https://commons.wikimedia.org/wiki/Special:Redirect/file/Test.png",
      },
      {
        ...result.logo,
        sourceUrl: `${result.logo.sourceUrl}?redirect=https://evil.example`,
      },
      { ...result.logo, file: `${"0".repeat(64)}.png` },
    ])
      expect(await readPrivateMerchantLogo(databasePath, input)).toBeNull();
    expect(privateMerchantLogoSchema.safeParse(result.logo).success).toBe(true);
    const destination = join(
      databasePath,
      "..",
      "merchant-logos",
      result.logo.file,
    );
    await writeFile(destination, Buffer.alloc(300_000));
    expect(await readPrivateMerchantLogo(databasePath, result.logo)).toBeNull();
    await writeFile(destination, "not a PNG; definitely corrupt data");
    expect(await readPrivateMerchantLogo(databasePath, result.logo)).toBeNull();
    await writeFile(
      destination,
      await sharp({
        create: { width: 1, height: 1, channels: 4, background: "red" },
      })
        .png()
        .toBuffer(),
    );
    expect(await readPrivateMerchantLogo(databasePath, result.logo)).toBeNull();
  });
});

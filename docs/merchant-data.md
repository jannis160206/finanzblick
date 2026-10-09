# Austrian merchant reference data

The existing `merchants` SQLite table is the sole matching reference. Offline
curated seeds remain available without network access. Imported reference data
does not include statements, balances, transactions, account identifiers, or
learned user categories. Neither the worker nor HTTP requests trigger imports.

## Operator-only geographic import

Use the configured account database and environment:

```powershell
npm run merchants:import -- --bbox 48.18,16.33,48.22,16.39
# Optional explicitly licensed raster logos:
npm run merchants:import -- --bbox 48.18,16.33,48.22,16.39 --logos
```

`--bbox` is required: **south,west,north,east**, decimal degrees, comma-separated.
There is no all-Austria download. Each side is at most 1 degree, the area at most
0.25 square degrees, and coordinates must lie within Austria's outer envelope.
The Overpass query additionally intersects the bbox with the administrative
country area `ISO3166-1=AT`; an envelope alone is not a country filter.
It selects named `shop`, `amenity`, and `tourism` nodes/ways/relations only.

Each invocation makes one POST to `https://overpass-api.de/api/interpreter`.
The result is limited to 1,000 elements, 4 MiB, 25 seconds per request, and an
Overpass server-side 20-second/8-MiB working-memory budget. It requests at most
1,001 elements to detect truncation: oversized tiles fail and must be split.
Incomplete Overpass responses, non-2xx responses, malformed data, and network
failures explicitly fail the command. Invalid merchant names/metadata are
reported as skipped. The combined reference index cannot exceed 10,000 entries
or 40,000 unique normalized aliases.

The CLI upserts the existing curated local seeds before importing.
Stable OSM identities make repeat imports upserts, not duplicate insertions.
The same normalized name is **not** sufficient to merge unrelated outlets.
Only matching `brand:wikidata` plus a matching brand/name label collapses a
chain's outlets. Differently named sub-brands remain distinct. Ambiguous names
remain collisions for manual review. Category mapping is deliberately small:
unknown or contradictory types yield `null`, not a guessed category. OSM
addresses may supply a city; a chain spanning cities has no single city.
The optional `wikidataId` persists that brand identity evidence. Older
`osm-brand-Q…-hash` rows retain the same evidence through their importer-generated
ID. Curated BIPA is independently linked to
<https://www.wikidata.org/wiki/Q864933> (public CC0 identity data, no image rights).
The matcher resolves duplicate records only when entity, canonical name, region
and default category/purpose requirements agree. Same names without this evidence remain collisions;
different categories and sub-brand names remain open. No source attribution is
deleted, and existing canonical IDs remain stable.
`requiresCategoryEvidence` distinguishes a reference's usual business category
from evidence of the actual purchase purpose. Marketplace/fuel references can
identify a merchant without automatically categorizing a multipurpose purchase.
Existing and newly imported fuel references require that extra evidence.
Explicit OSM `alt_name`, `short_name`, and `official_name` values become bounded
aliases; invalid/excess alternatives are counted in `aliasSkippedCount`.

Import adjacent small tiles incrementally. Coverage is limited to what was
named and mapped in those tiles at that time; this is not an Austrian business
registry or complete merchant catalogue. Deleted/renamed OSM objects are not
automatically reconciled. Adjacent-tile refreshes retain existing aliases;
conflicting categories or cities stay empty rather than being overwritten by
the latest tile. Previously unknown categories stay unknown pending deliberate
reference correction. Review stale rows deliberately. Large coverage may hit
the index caps.

OSM rows store source `osm`, license `ODbL-1.0`, and attribution
`© OpenStreetMap contributors` with the OSM copyright URL:
<https://www.openstreetmap.org/copyright>. Observe ODbL requirements when
redistributing a derived reference database; data is not silently relicensed.
Wikidata P154 is CC0 reference data, but **does not license the image**.

## Optional private logos

`--logos` examines at most 20 distinct, unambiguously associated Wikidata
entities per run (at most three additional requests per entity; 61 total
requests including Overpass). Requests are sequential, with a 10-second
per-request and 180-second total network deadline; raster processing has a
five-second timeout. Preferred P154 is accepted only if unique; otherwise the
logo is explicitly skipped. Only original PNG, JPEG, and WebP files are
accepted. SVG, animations, large images, missing metadata, unsupported licenses,
and listed usage restrictions are rejected/reported. This intentionally means
many brands have **no logo**.

Commons must explicitly provide matching license name and HTTPS license URL for
CC0 1.0, Public Domain Mark 1.0, CC BY 4.0, or CC BY-SA 4.0, and an attributable
artist. No fair-use, unknown, or inferred license is accepted. Commons metadata
is not a guarantee that trademark or other non-copyright rights are cleared;
operators must review suitability. Attribution records retain artist, credit,
Commons source, license, the resizing modification, and the Wikidata P154
entity reference with its separate `CC0-1.0` data license.

Only fixed HTTPS hosts/paths are allowed: `www.wikidata.org/w/api.php`,
`commons.wikimedia.org/w/api.php`, and original-file paths on
`upload.wikimedia.org/wikipedia/commons/`. Redirects are forbidden.
There are no Google, brand-CDN, generic logo-collection, bank, or cloud-LLM
requests and no arbitrary operator-supplied download URLs.

Downloads are bounded to 2 MiB and 4 megapixels. Installed `sharp` decodes and
normalizes them to metadata-free PNGs at most 128 pixels on either side.
Files are content-addressed `<lowercase-sha256>.png`, at most 256 KiB each,
under `merchant-logos` beside the **private account database**, never `public`.
Directories/files use restrictive modes where supported. Existing files are
hash-checked, and serving rejects symlinks, non-PNG data, oversized files,
invalid file names, missing explicit licensing, and hash mismatches.

Authenticated `GET /api/merchants/{id}/logo` looks up that merchant in the shared
store; request input never supplies a filesystem path or download URL.
There is no endpoint for starting imports. Responses are PNG with
`Cache-Control: private, no-store`, `nosniff`, same-origin resource policy,
`X-Merchant-Logo-License`, `X-Merchant-Logo-Source`, and
`X-Merchant-Logo-Attribution` (percent-encoded UTF-8, decode with
`decodeURIComponent`). Logos in the UI link to authenticated
`GET /api/merchants/{id}/attribution`: readable, private, no-store plain text
showing the canonical merchant name, data source/license/attribution, logo
license, full attribution/modification notice, and the allowlisted Commons
source URL. No text is interpreted as HTML. It loads no third-party resources and
uses a restrictive CSP and no-referrer policy. Response headers alone are not
a visible attribution notice. Non-account
development mode has no server reference database and returns 404.
Geography-only refreshes keep previously cached licensed logos.
An explicit `--logos` refresh does not retain an older logo when its current
Wikidata/Commons association or licensing check is skipped.

The CLI prints an explicit JSON report including each skipped merchant/logo and
`skippedCount`, `logoDownloadedCount`, and `logoSkippedCount` per-merchant totals.
Requests use only geographic coordinates, OSM reference identities, Wikidata
entity IDs, and Commons file names—never financial data. Tests mock all network
requests. Back up the database and private logo directory together; deleting
the cache produces missing-logo responses, not live-network fallbacks.

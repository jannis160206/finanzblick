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

For geography, `--bbox` is required: **south,west,north,east**, decimal degrees, comma-separated.
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
ID. Curated brands are independently linked to public Wikidata identities
(CC0 facts, **not image rights**). Verified on 2026-10-09:

| Reference | Entity |
| --- | --- |
| BILLA | [Q537781](https://www.wikidata.org/wiki/Q537781) |
| PENNY | [Q284688](https://www.wikidata.org/wiki/Q284688) |
| Mueller drugstores | [Q1958759](https://www.wikidata.org/wiki/Q1958759) |
| SPAR international brand | [Q610492](https://www.wikidata.org/wiki/Q610492) |
| HOFER Austria | [Q15815751](https://www.wikidata.org/wiki/Q15815751) |
| Lidl | [Q151954](https://www.wikidata.org/wiki/Q151954) |
| dm-drogerie markt | [Q266572](https://www.wikidata.org/wiki/Q266572) |
| BIPA | [Q864933](https://www.wikidata.org/wiki/Q864933) |
| IKEA | [Q54078](https://www.wikidata.org/wiki/Q54078) |
| Austrian Federal Railways | [Q83822](https://www.wikidata.org/wiki/Q83822) |
| Amazon | [Q3884](https://www.wikidata.org/wiki/Q3884) |
| Spotify | [Q689141](https://www.wikidata.org/wiki/Q689141) |
| Netflix | [Q907311](https://www.wikidata.org/wiki/Q907311) |

The matcher resolves duplicate records only when entity, canonical name, region
and default category/purpose requirements agree. Same names without this evidence remain collisions;
different categories and sub-brand names remain open. No source attribution is
deleted, and existing canonical IDs remain stable.
Verified identity groups and ambiguous alias postings are compiled once per
worker start. A previous equivalent table ID can be retained, preserving its
licensed private logo metadata; unresolved collisions cannot be resolved merely
by requesting a preferred ID.
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
requests including Overpass, before opt-in bounded retries). Requests are sequential, with a 10-second
per-request and 180-second total network deadline; raster processing has a
five-second timeout. Preferred P154 is accepted only if unique; otherwise the
logo is explicitly skipped. Original PNG, JPEG, and WebP files are accepted.
SVG is **never downloaded or executed locally**: the importer requests a Commons
PNG thumbnail and checks its host, hash-directory path and filename against the
licensed original. Current Commons uses `thumb.wikimedia.org` and bucketed raster
sizes (e.g. a 250px URL for 128px presentation); actual PNG dimensions are checked
and limited to 512px before normalizing to 128px. Animations, large images, missing
metadata, unsupported licenses and nontrademark usage restrictions are rejected.
This intentionally means
many brands have **no logo**.

Commons must explicitly provide matching license name and HTTPS license URL for
CC0 1.0, Public Domain Mark 1.0, CC BY 4.0, or CC BY-SA 4.0, and an attributable
artist. A missing public-domain license URL is accepted **only** when Commons
affirmatively declares all of `License=pd`, `LicenseShortName=Public domain`,
`UsageTerms=Public domain`, `Copyrighted=False`, and `AttributionRequired=false`.
No URL is invented. A sole `trademarked`/`trademark` advisory is retained in
attribution, not treated as a copyright prohibition. Additional restrictions,
fair-use and inferred licenses remain rejected. Known unresolved upstream
provenance (`logos.fandom.com`, `theslap.com` in source credit) is skipped; the
importer does not visit those sites. BIPA currently lacks P154; current HOFER and
Amazon files have unresolved provenance. They therefore retain initials.
Commons metadata
is not a guarantee that trademark or other non-copyright rights are cleared;
operators must review suitability. Attribution records retain artist, credit,
Commons source, license, the resizing modification, and the Wikidata P154
entity reference with its separate `CC0-1.0` data license.

Only fixed HTTPS hosts/paths are allowed: `www.wikidata.org/w/api.php`,
`commons.wikimedia.org/w/api.php`, and original-file paths on
`upload.wikimedia.org/wikipedia/commons/`, plus bounded, provenance-matched PNG
thumbnail paths on `upload.wikimedia.org`/`thumb.wikimedia.org`. Only the exact
three Commons `utm_*` metadata tags are stripped; other media query parameters
are rejected. Redirects are forbidden.
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
Seed refreshes also retain valid logos for the unchanged identity; a changed
name, region or entity does not inherit the old image.
An explicit `--logos` refresh does not retain an older logo when its current
Wikidata/Commons association or licensing check is skipped.

### Logo-only refresh and transaction marks

```powershell
# No Overpass request; uses only public entities already in merchants.
npm run merchants:import -- --logos-only --limit 20
# Target a bounded selection, avoiding starvation behind repeated absent logos.
npm run merchants:import -- --logos-only --entities Q689141,Q907311
# Deliberately recheck current source/license, including cached logos:
npm run merchants:import -- --logos-only --entities Q537781,Q284688 --refresh
```

The limit is 1-20 **network entity lookups** per invocation; cache reuse is free.
Lookups remain sequential. Logo-only requests permit at most two retries for
HTTP 429/503, honor numeric Retry-After up to five seconds, and stop explicitly
when the source asks for a later retry. The total deadline remains 180 seconds.
An unchanged cache is idempotent. Network/storage failures fail visibly and do
not clear existing logo metadata; an explicit refresh with a definite license/
association rejection clears it. Writes change only logo metadata, entity
evidence and its timestamp, using an optimistic revision guard. They never
rewrite financial snapshots, categories, aliases, locks or backfill cursors.

The transaction list batches **visible known IDs**, not bank text, to authenticated
`POST /api/merchants/marks` (100 IDs / 16 KiB). It performs bounded local queries
and file integrity checks, not remote downloads or per-transaction matching.
Proven same-entity/name/region references can supply an image with that asset's
own attribution. Same names without entity proof cannot. The account-scoped
client cache is bounded to 500 entries and is reset/aborted on account changes;
there is no polling. An old `merchantLogo=false` flag cannot hide a newly imported
logo, and no transaction backfill is needed for image updates.

Desktop and mobile keep the same 32px cell. Missing/unlicensed images fall back
to canonical initials; transfers have no mark. Manually renamed rows that cleared
their global ID never reacquire a logo by guessing their name. A changed image
version resets failed-image state. Versions hash both the PNG reference and its
full validated license/source/credits, so a credit-only change also gets a new
version. Attribution links carry the same version. Old attribution is archived
atomically in `merchant_logo_attributions` (at most 10,000 immutable records,
no financial data); this is a credit history, not another matching catalogue.
It remains available even for an old image still visible in an open tab.
Verified `?v=<sha256>` assets use private,
one-day immutable browser caching with `Vary: Cookie`; wrong versions return 404.
Unversioned URLs remain no-store. No image is hotlinked.

The CLI prints an explicit JSON report including each skipped merchant/logo and
`skippedCount`, `logoDownloadedCount`, and `logoSkippedCount` per-merchant totals.
Requests use only geographic coordinates, OSM reference identities, Wikidata
entity IDs, and Commons file names—never financial data. Tests mock all network
requests. Back up the database and private logo directory together; deleting
the cache produces missing-logo responses, not live-network fallbacks.

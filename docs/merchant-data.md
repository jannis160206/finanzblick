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
| McDonald's | [Q38076](https://www.wikidata.org/wiki/Q38076) |
| Burger King | [Q177054](https://www.wikidata.org/wiki/Q177054) |
| MediaMarkt | [Q2381223](https://www.wikidata.org/wiki/Q2381223) |
| H&M | [Q188326](https://www.wikidata.org/wiki/Q188326) |
| C&A | [Q701338](https://www.wikidata.org/wiki/Q701338) |
| OBI | [Q300518](https://www.wikidata.org/wiki/Q300518) |
| Bauhaus retailer, not the art school | [Q672043](https://www.wikidata.org/wiki/Q672043) |
| Hornbach | [Q685926](https://www.wikidata.org/wiki/Q685926) |
| XXXLutz | [Q70339467](https://www.wikidata.org/wiki/Q70339467) |
| Moemax, not an XXXLutz alias | [Q56388481](https://www.wikidata.org/wiki/Q56388481) |
| Fressnapf | [Q875796](https://www.wikidata.org/wiki/Q875796) |
| Thalia books | [Q2408854](https://www.wikidata.org/wiki/Q2408854) |
| A1 Austria, not the multinational parent | [Q279847](https://www.wikidata.org/wiki/Q279847) |
| Drei Austria, not the global 3 brand entity | [Q28956333](https://www.wikidata.org/wiki/Q28956333) |
| Magenta Austria | [Q63537385](https://www.wikidata.org/wiki/Q63537385) |

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
logo is explicitly skipped.
Wikidata requests use `wbgetclaims&property=P154`, not a full entity's unrelated
claims. This keeps large company records inside the original byte budget.
Original PNG, JPEG, and WebP files are accepted.
SVG is **never downloaded or executed locally**: the importer requests a Commons
PNG thumbnail and checks its host, hash-directory path and filename against the
licensed original. Current Commons uses `thumb.wikimedia.org` and bucketed raster
sizes (e.g. a 250px URL for 128px presentation); actual PNG dimensions are checked
and limited to 512px before normalizing to 128px. Animations, large images, missing
metadata, unsupported licenses and nontrademark usage restrictions are rejected.
This intentionally means
many brands have **no logo**.

Commons must explicitly provide matching license name and HTTPS license URL for
CC0 1.0 (also Commons' `CC0` label), Public Domain Mark 1.0, CC BY 4.0, or CC BY-SA 4.0, and an attributable
artist. A missing public-domain license URL is accepted **only** when Commons
affirmatively declares all of `License=pd`, `LicenseShortName=Public domain`,
`UsageTerms=Public domain`, `Copyrighted=False`, and `AttributionRequired=false`.
Known `creativecommons.org` HTTP/HTTPS and English/German `deed` URL forms are
canonicalized to the same explicitly named license; missing, foreign, credentialed
or query-bearing license URLs do not become permissions. No URL is invented.
A sole `trademarked`/`trademark` advisory is retained in
attribution, not treated as a copyright prohibition. Additional restrictions,
fair-use and inferred licenses remain rejected. Known unresolved upstream
provenance (Logopedia, Logowik, Brands of the World and known collection domains
in source credit) is skipped; the
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
# Visit all already-known public entities once in sequential groups of 20.
# Rechecking current license/provenance is deliberate, including cached assets:
npm run merchants:import -- --all-logos --refresh
# If the 200-entity cap is reached, continue with the returned nextAfter value:
npm run merchants:import -- --all-logos --refresh --after Q123
```

The limit is 1-20 **network entity lookups** per invocation; cache reuse is free.
For `--all-logos`, `--limit` controls each sequential batch (1-20); an invocation
visits at most 200 public entities with a ten-minute overall deadline. IDs are
deduplicated and sorted into a stable cursor order. Missing/rejected logos do not
starve later entities. Batch progress prints the last completed cursor; after a
source failure, repeat from that cursor (already stored assets remain intact).
This scans known public reference IDs, not the internet for private bank texts.
It cannot be combined with geographic/entity-selection modes. Private use is
not treated as a universal copyright exception: only explicit permitted or
affirmatively public-domain artwork enters the cache.
Lookups remain sequential. Logo-only requests permit at most two retries for
HTTP 429/503, honor numeric Retry-After up to five seconds, and stop explicitly
when the source asks for a later retry. The total deadline remains 180 seconds.
An unchanged cache is idempotent. Network/storage failures fail visibly and do
not clear existing logo metadata; an explicit refresh with a definite license/
association rejection clears it. Writes change only logo metadata, entity
evidence and its timestamp, using an optimistic revision guard. They never
rewrite financial snapshots, categories, aliases, locks or backfill cursors.

The transaction list batches **visible known IDs, existing aliases and missing-identity
booking references** to authenticated `POST /api/merchants/marks`
(100 references / 16 KiB). Long receipt references are split by UTF-8 byte size
as well as count. It performs bounded local queries and file integrity checks,
not remote downloads or per-row database queries.
Proven same-entity/name/region references can supply an image with that asset's
own attribution. Same names without entity proof cannot. The account-scoped
client cache is bounded to 500 entries and is reset/aborted on account changes;
there is no polling. Returning to the visible browser tab/window refreshes only
its displayed metadata, throttled to once per 30 seconds; it does not clear
currently working images. A partial, missing or malformed named response cannot
discard independently valid ID logos. Transport/validation failures are reported
and are never cached as a definitive missing image. The contextual
`Logos erneut laden` action retries visible metadata and clears the warning only
after successful loading. This also recovers after a temporary server outage or
a stale development API. Image transport failures are reported as well; a
successful metadata refresh retries failed images even when their asset/version
has not changed, without remounting already working images. A process serving old
route code still needs restarting.
An old `merchantLogo=false` flag cannot hide a newly imported
logo, and no transaction backfill is needed for image updates.

Desktop and mobile keep the same 32px cell. Missing/unlicensed images fall back
to canonical initials; transfers have no mark. Rows without an ID may now resolve
their existing merchant alias against exact local canonical names or factual
aliases, but never fuzzy spelling or a conflicting identity. The legacy
`Audi | Abo` subscription annotation resolves the display name `Audi`; other
arbitrary suffixes are not stripped. This only supplies an image and attribution:
it never edits a transaction, category, lock, confirmed name or learned rule.
If both ID and alias are absent, the server reads only the authenticated account's
snapshot and resolves the requested ledger/receipt references through the existing
worker evidence and exact/regex index. Fuzzy hits, collisions, conflicting evidence,
qualified unrelated companies, transfers and confirmed empty names remain without
an inferred logo. Account-confirmed aliases take precedence using exact name lookup.
The shared display index is cached per database connection and invalidated after
local or external database changes; finance snapshots are never cached in it.
Locked historical rows can therefore show the same logo as newer rows without
changing any identity, category, review flag, rule, lock or backfill checkpoint.
Visible names, IDs and booking references share the 100-reference batch limit and
500-entry account cache; inputs stay on the authenticated same-origin API.
Unknown and ambiguous names still use initials. A changed image
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

## Authorized private logos for one account

When an operator has private usage rights, the separate authorized import accepts
an explicit **existing account username** and a required human rights reference.
A declaration such as `User confirmed private usage rights, 2026-10-09` is valid
input: it is recorded as an **operator/user assertion**, not represented as an
actual licence document or independently verified licence. Account grants never
become public licences and never enter `merchants.logo_json`.

```powershell
# Explicit database path; this command does NOT load .env.local.
npm run merchants:authorized-logos -- --database ".local-data\accounts.sqlite" --account "YOUR_USERNAME" --rights-reference "User confirmed private usage rights, 2026-10-09" --commons
# Deliberate source refresh, or continuation after a returned cursor:
npm run merchants:authorized-logos -- --database ".local-data\accounts.sqlite" --account "YOUR_USERNAME" --rights-reference "User confirmed private usage rights, 2026-10-09" --commons --refresh --batch-size 20
# Use --after Q123 only with --commons to continue a capped/interrupted scan.
```

The scan uses only already-known public Wikidata identities, including legacy
OSM brand IDs. It does not seed, rename or mutate merchants, aliases, categories,
transactions, finance snapshots or sessions. Available shared publicly licensed
images are reused for all accounts; previously imported private images are reused
within the selected account. `--refresh` deliberately rechecks Commons.
The operator declaration can authorize a file without an allowlisted public CC
licence; source artist, credit, licence name/URL, usage terms and trademark
advisories remain **separate public-source metadata**. Nontrademark restrictions,
ambiguous P154 and unsafe images still skip. The explicit private permission
does not depend on Commons' public licence type or upstream copyright labels.
Upstream Logopedia/collection credit tags are retained as source-reported
attribution, not visited, erased, or relabelled as a licence. A known P154 asset
may be imported only from the allowlisted Commons resource/thumbnail under
the account's declaration; normal shared/public imports still reject such
unreviewed upstream provenance and retain their original public licence gate.
There is no Google/brand-CDN/collection scraping, hotlink or invented artwork.
Requests contain only public QIDs and their Commons file identifiers, never bank
text, account IDs, usernames, rights references, amounts or financial metadata.

The factual seed references in `merchant-identities.ts` extend the same merchant
catalogue to verified transport, streaming, restaurant, retail and insurance
brands. Identities are checked against Wikidata labels/descriptions
(`wbgetentities`, `props=labels|descriptions`) and each entity's P154 response
(`wbgetclaims`, `property=P154`). These references assert neither a public image
licence nor a purchase purpose. Product identities such as Disney+, Steam,
PlayStation, Lieferando and Uber Eats remain distinct from their parent companies.
Uber Trip uses the Uber rideshare brand identity, not Uber Eats; fuel-station
identities retain their explicit category-evidence requirement. Missing P154
does not justify using an unrelated parent-company or similarly named logo.

Each run visits at most 200 deduplicated public entities, in sequential batches
of 1–20, with a ten-minute total deadline and the existing ten-second network/
five-second raster deadlines. HTTP 429/503 permit at most two bounded retries;
source failures fail visibly and leave prior grants intact. Progress supplies a
completed batch cursor; `nextAfter` resumes a capped scan. Skips identify public
QIDs/merchant IDs and reasons, including `No P154 logo`.

Missing P154 does not necessarily mean missing artwork. An explicit reviewed
Commons manifest can name verified brand artwork independently of P154:

```powershell
npm run merchants:authorized-logos -- --database ".local-data\accounts.sqlite" --account "YOUR_USERNAME" --rights-reference "User confirmed private usage rights, 2026-10-09" --commons-manifest "scripts\data\merchant-logo-reviewed-files.json"
```

The checked-in manifest contains public factual file references and subject
evidence, not images or personal rights. Every entry requires an existing merchant
ID, its exact current QID, a bounded Commons filename and explicit reviewed
subject evidence. Unknown, mismatched or duplicate identities fail before any
request. The importer uses the same Commons metadata, allowlist, sequential
downloads, thumbnail/raster safeguards, private quotas and tenant grants.
Credits explicitly say **operator-reviewed file association**, not P154 proof;
the evidence is retained in account-scoped provenance. No public licence is
invented, no global logo is written and no financial data changes.
Five previously absent P154 logos (BIPA, Lieferando, Zooplus, Austrian Post and
Sky X) have verified Commons references. Toyota's symbol is explicitly reviewed
instead of silently overriding P154 rank selection.

Artwork with no verified suitable source still requires **operator-supplied local
files**, not fabricated logos. The scan report identifies remaining gaps.
HOFER/Amazon collection credit labels no longer prevent
authorized per-account Commons import when a safe, unambiguous P154 file exists.
Place a JSON manifest beside the supplied files:

```json
{
  "entries": [
    {
      "merchantId": "at-bipa",
      "file": "bipa.png",
      "attribution": "Rights holder attribution supplied by the operator",
      "rightsReference": "Optional file-specific private rights reference"
    }
  ]
}
```

```powershell
npm run merchants:authorized-logos -- --database ".local-data\accounts.sqlite" --account "YOUR_USERNAME" --rights-reference "User confirmed private usage rights, 2026-10-09" --manifest ".local-data\provided-logos\manifest.json"
```

The manifest is bounded to 128 KiB / 200 distinct **known merchant IDs**.
`attribution` is required; entry-specific `rightsReference` overrides the required
command reference. Files must be relative PNG/JPEG/WebP paths under the manifest
directory. Absolute paths, traversal, alternate streams, symlink/junction paths,
local SVG and mismatched raster formats are rejected. Existing 2 MiB input,
4-million-pixel, single-frame, 128×128 output and 256 KiB output-byte limits
remain unchanged. Commons SVG is never read locally: only the allowlisted,
provenance-matched server PNG thumbnail is downloaded (reported 128px thumbnail,
bucket URL at most 512px, decoded raster at most 512px).
For the authorized path only, an original PNG/JPEG exceeding 2 MiB or 4 million
pixels can use Commons' already-returned PNG thumbnail instead. The thumbnail
must report PNG / at most 128×128 presentation, use the exact original hash
directories and filename-derived thumbnail path (converted JPEG uses `.jpg.png`
or `.jpeg.png`), and decode to at most 512px per side. Actual download still
cannot exceed 2 MiB, and output limits remain unchanged. The oversized original
is never fetched. Missing, non-PNG or mismatched thumbnails skip explicitly;
no URL/path is guessed or requested. Normal public and existing SVG limits stay
unchanged.

When Wikidata lists multiple current logo variants, private import can take
`--logo-choices "<private JSON file>"`. The bounded file contains at most 200
distinct known entities, for example:
`[{"wikidataId":"Q649646","filename":"Valentino logo.svg"}]`.
The exact filename must occur in the current nondeprecated P154 candidate set
(preferred ranks take precedence). A choice never permits arbitrary Commons
files, foreign URLs or guesses. Unknown/duplicate entities fail before requests;
missing or deprecated variants skip visibly. Without a choice, ambiguous variants
remain open. Actual SVGs are never downloaded; authorized oversized SVG originals
also use only a provenance-matched, size-bounded server PNG thumbnail.

`scripts\data\merchant-logo-choices.json` contains reproducible factual variant
choices for the known seeded/imported catalog, including Shell's current
yellow/red pictogram photographic crop instead of its standalone wordmark:

```powershell
npm run merchants:authorized-logos -- --database ".local-data\accounts.sqlite" --account "YOUR_USERNAME" --rights-reference "User confirmed private usage rights, 2026-10-09" --commons --logo-choices "scripts\data\merchant-logo-choices.json"
```

Choices are still checked against current P154 on every explicit invocation.
They grant no rights and are not fabricated illustrations. The Shell candidate
is a small photograph, not a clean vector; a rights-holder-supplied clean raster
can replace it through the local manifest without weakening any source checks.
For a smaller custom catalog, provide only its known QIDs; unknown choices are
intentionally rejected before requests. After a Commons scan, apply the reviewed
file manifest to select its independently verified symbols/wordmarks.

Private content-hashed PNGs live in `merchant-authorized-logos/<account-hash>/`
beside the database, never under a public web directory. One bounded, expiring
operator-import lock per account prevents concurrent quota races; no extra
worker/service is introduced. Limits include 1,024 files per account / 10,000
private files overall, 2,000
current/history metadata records per account and 10,000 overall. Repeated
identical imports reuse the file and version, including at the metadata cap.
Finite asset reservations also count partial/orphaned writes and deleted-account
files against the storage quota; deleting metadata does not silently reset it.
Keep the database and both logo directories together in private backups.

Authenticated marks resolve that account's grants first, then existing shared
public logos, without changing the frontend response contract. Logo and
attribution endpoints derive the account from the session cookie, not request
IDs/paths. New versions bind the account, merchant ID, exact canonical-name
snapshot, content and permission/credit metadata. Explicit reimport after a
canonical rename therefore creates a new current version even when image and
rights are unchanged; further identical imports remain idempotent and reuse
the same file. Old private PNGs and credits remain account-scoped in the history.
Previously stored account/content/permission-only hashes remain valid for
existing current marks and owner-only versioned image/attribution reads; reads
never rewrite those rows or require a schema reset. No repeat import is needed
for unchanged existing grants. To refresh a renamed local grant, repeat its
original local manifest import (no network); renamed Commons grants can refresh
their identity through the cached `--commons` path without downloading again.
Another account cannot read private images, permission references or archived
credits even with the exact merchant/version. Versioned images retain private
immutable browser caching and `Vary: Cookie`; attribution remains private
no-store plain text with an explicit declaration/not-document label.

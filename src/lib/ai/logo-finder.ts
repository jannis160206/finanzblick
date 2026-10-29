import { randomUUID } from "node:crypto";
import { mkdir, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { liveLogoDirectory } from "@/lib/automation/merchant-live-logo-directory";
import { normalizeLocalLogoName } from "@/lib/automation/merchant-local-logos";
import { normalizeLogoRaster } from "@/lib/automation/merchant-logo-raster";
import { chat, type ChatOptions } from "./client";
import { extractJsonArray } from "./categorize";

const USER_AGENT = "Finanzblick/1.0 (private dashboard; local merchant logos)";
const MAX_DIRECTORY_FILES = 190;
const IMAGE_FILE = /\.(?:png|jpe?g|webp|avif)$/i;

export type LogoOutcome =
  | { status: "exists"; file: string }
  | { status: "saved"; file: string; source: string; entity: string }
  | { status: "not-found"; reason: string };

export type LogoFinderOptions = {
  directory?: string;
  fetcher?: typeof fetch;
  ai?: ChatOptions | false;
  signal?: AbortSignal;
};

// Windows-safe file name whose normalized form still matches the merchant alias.
export function logoFileName(name: string) {
  const base = name.normalize("NFKC").replace(/[<>:"/\\|?*\x00-\x1f]/g, " ").replace(/\s+/g, " ")
    .trim().replace(/[. ]+$/, "").slice(0, 90);
  if (normalizeLocalLogoName(base) !== normalizeLocalLogoName(name) || normalizeLocalLogoName(base).length < 2)
    return undefined;
  return `${base}.png`;
}

async function existingLogo(directory: string, name: string) {
  const wanted = normalizeLocalLogoName(name);
  let files: string[];
  try {
    files = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { count: 0 };
    throw error;
  }
  const images = files.filter((file) => IMAGE_FILE.test(file));
  const match = images.find((file) => normalizeLocalLogoName(file.replace(IMAGE_FILE, "")) === wanted);
  return { count: images.length, match };
}

const searchSchema = z.object({ search: z.array(z.object({ id: z.string().regex(/^Q\d+$/) })).max(10) });
const entitySchema = z.object({
  entities: z.record(z.string(), z.object({
    id: z.string(),
    labels: z.record(z.string(), z.object({ value: z.string() })).optional(),
    aliases: z.record(z.string(), z.array(z.object({ value: z.string() }))).optional(),
    descriptions: z.record(z.string(), z.object({ value: z.string() })).optional(),
    claims: z.record(z.string(), z.array(z.object({
      mainsnak: z.object({ datavalue: z.object({ value: z.unknown() }).optional() }),
      rank: z.string().optional(),
    }).loose())).optional(),
  }).loose()),
});
const imageInfoSchema = z.object({
  query: z.object({
    pages: z.record(z.string(), z.object({
      imageinfo: z.array(z.object({ thumburl: z.string().url().optional(), url: z.string().url() })).optional(),
    }).loose()),
  }),
});

type Candidate = { id: string; label: string; names: string[]; description: string; logo: string };

async function getJson(url: URL, fetcher: typeof fetch, signal?: AbortSignal) {
  const response = await fetcher(url, {
    headers: { Accept: "application/json", "User-Agent": USER_AGENT },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000),
    cache: "no-store",
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

async function wikidataCandidates(name: string, fetcher: typeof fetch, signal?: AbortSignal): Promise<Candidate[]> {
  const search = new URL("https://www.wikidata.org/w/api.php");
  search.search = new URLSearchParams({
    action: "wbsearchentities", search: name, language: "de", uselang: "de", type: "item", limit: "6", format: "json",
  }).toString();
  const ids = searchSchema.parse(await getJson(search, fetcher, signal)).search.map((item) => item.id);
  if (!ids.length) return [];
  const entities = new URL("https://www.wikidata.org/w/api.php");
  entities.search = new URLSearchParams({
    action: "wbgetentities", ids: ids.join("|"), props: "labels|aliases|descriptions|claims",
    languages: "de|en|mul", format: "json",
  }).toString();
  const parsed = entitySchema.parse(await getJson(entities, fetcher, signal));
  return ids.flatMap((id) => {
    const entity = parsed.entities[id];
    const logo = entity?.claims?.P154?.find((claim) => claim.rank !== "deprecated")?.mainsnak.datavalue?.value;
    if (typeof logo !== "string" || !logo.trim()) return [];
    const labels = Object.values(entity.labels ?? {}).map((label) => label.value);
    const aliases = Object.values(entity.aliases ?? {}).flat().map((alias) => alias.value);
    return [{
      id, logo,
      label: entity.labels?.de?.value ?? entity.labels?.mul?.value ?? entity.labels?.en?.value ?? labels[0] ?? id,
      names: [...new Set([...labels, ...aliases])],
      description: entity.descriptions?.de?.value ?? entity.descriptions?.en?.value ?? "",
    }];
  });
}

async function chooseCandidate(name: string, context: string | undefined, candidates: Candidate[], ai: ChatOptions | false) {
  const wanted = normalizeLocalLogoName(name);
  const exact = candidates.filter((candidate) => candidate.names.some((value) => normalizeLocalLogoName(value) === wanted));
  if (exact.length === 1) return exact[0];
  if (!candidates.length || !ai) return undefined;
  // The model must positively confirm the brand; otherwise no logo is stored.
  const options = candidates.map((candidate) => `${candidate.id}: ${candidate.label} – ${candidate.description}`).join("\n");
  const answer = await chat([
    { role: "system", content: "Du ordnest einen Händlernamen aus einer österreichischen Bankbuchung dem richtigen Wikidata-Unternehmen zu. Antworte nur mit JSON: [{\"id\":\"Q…\",\"confidence\":0-100}] oder [{\"id\":null,\"confidence\":0}] wenn keiner sicher passt." },
    { role: "user", content: `Händler: ${name}${context ? `\nBuchungstext: ${context}` : ""}\nKandidaten:\n${options}` },
  ], { ...ai, maxTokens: 40 });
  const parsed = z.array(z.object({ id: z.string().nullable(), confidence: z.coerce.number() }))
    .safeParse(extractJsonArray(answer.content));
  const choice = parsed.success ? parsed.data[0] : undefined;
  if (!choice?.id || choice.confidence < 90) return undefined;
  return candidates.find((candidate) => candidate.id === choice.id);
}

async function downloadCommonsLogo(file: string, fetcher: typeof fetch, signal?: AbortSignal) {
  const info = new URL("https://commons.wikimedia.org/w/api.php");
  info.search = new URLSearchParams({
    action: "query", titles: `File:${file}`, prop: "imageinfo", iiprop: "url", iiurlwidth: "256", format: "json",
  }).toString();
  const pages = imageInfoSchema.parse(await getJson(info, fetcher, signal)).query.pages;
  const image = Object.values(pages)[0]?.imageinfo?.[0];
  const source = image?.thumburl ?? image?.url;
  if (!source) return undefined;
  const url = new URL(source);
  if (url.protocol !== "https:" || !["upload.wikimedia.org", "thumb.wikimedia.org"].includes(url.hostname)) return undefined;
  const response = await fetcher(url, {
    headers: { "User-Agent": USER_AGENT },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
    redirect: "error",
    cache: "no-store",
  });
  if (!response.ok) return undefined;
  const bytes = Buffer.from(await response.arrayBuffer());
  const png = await normalizeLogoRaster(bytes, { suppliedLocalFile: true });
  return png ? { png, source: `https://commons.wikimedia.org/wiki/File:${encodeURIComponent(file.replace(/ /g, "_"))}` } : undefined;
}

export async function findMerchantLogo(
  name: string, context: string | undefined, options: LogoFinderOptions = {},
): Promise<LogoOutcome> {
  const file = logoFileName(name);
  if (!file) return { status: "not-found", reason: "Ungültiger Händlername" };
  const directory = options.directory ?? liveLogoDirectory();
  const existing = await existingLogo(directory, name);
  if (existing.match) return { status: "exists", file: existing.match };
  if (existing.count >= MAX_DIRECTORY_FILES) return { status: "not-found", reason: "Logo-Ordner ist voll" };
  const fetcher = options.fetcher ?? fetch;
  const candidates = await wikidataCandidates(name, fetcher, options.signal);
  const chosen = await chooseCandidate(name, context, candidates, options.ai ?? {});
  if (!chosen) return { status: "not-found", reason: "Kein eindeutiges Unternehmen mit Logo gefunden" };
  const logo = await downloadCommonsLogo(chosen.logo, fetcher, options.signal);
  if (!logo) return { status: "not-found", reason: "Logo konnte nicht sicher geladen werden" };
  await mkdir(directory, { recursive: true });
  // The live importer ignores the temporary name, so it never sees a partial file.
  const temporary = join(directory, `.ai-${randomUUID()}.tmp`);
  await writeFile(temporary, logo.png, { flag: "wx" });
  try {
    await rename(temporary, join(directory, file));
  } catch (error) {
    await unlink(temporary).catch(() => {});
    throw error;
  }
  return { status: "saved", file, source: logo.source, entity: chosen.id };
}

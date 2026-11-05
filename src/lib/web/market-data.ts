// Public market data for savings planning. Only fixed public series are requested; no personal data leaves the device.
export type Observation = { value: number; period: string; source: string; url: string };
export type InterestRates = { ecbDeposit?: Observation; overnight?: Observation; fixedUpToOneYear?: Observation };
export type ExchangeRate = Observation & { currency: string };

const ECB = "https://data-api.ecb.europa.eu/service/data";
const EUROSTAT = "https://ec.europa.eu/eurostat/api/dissemination/statistics/1.0/data";
const TTL = 6 * 60 * 60 * 1000;
const TIMEOUT = 8000;
export const currencyCode = /^[A-Z]{3}$/;

type Entry = { at: number; value: unknown };
const store = globalThis as typeof globalThis & { finanzblickMarketCache?: Map<string, Entry> };
const cache = () => (store.finanzblickMarketCache ??= new Map());

// Fresh values are reused for six hours; when a source is down, the last known value is kept.
export async function cached<T>(key: string, load: () => Promise<T>, ttl = TTL): Promise<T> {
  const hit = cache().get(key);
  if (hit && Date.now() - hit.at < ttl) return hit.value as T;
  try {
    const value = await load();
    cache().set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    if (hit) return hit.value as T;
    throw error;
  }
}

export function clearMarketCache() {
  cache().clear();
}

async function getText(url: string, fetcher: typeof fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(TIMEOUT), headers: { Accept: "text/csv, application/json" }, cache: "no-store" });
  if (!response.ok) throw new Error(`Quelle antwortet mit ${response.status}`);
  return response.text();
}

function splitCsv(line: string) {
  const cells: string[] = [];
  let cell = "", quoted = false;
  for (const char of line) {
    if (char === '"') quoted = !quoted;
    else if (char === "," && !quoted) { cells.push(cell); cell = ""; }
    else cell += char;
  }
  cells.push(cell);
  return cells;
}

// ECB SDMX csv: one row per series with its latest observation.
export function parseEcbCsv(text: string): { key: string; period: string; value: number }[] {
  const [head, ...rows] = text.trim().split(/\r?\n/);
  if (!head) return [];
  const columns = splitCsv(head);
  const key = columns.indexOf("KEY"), period = columns.indexOf("TIME_PERIOD"), value = columns.indexOf("OBS_VALUE");
  if (key < 0 || period < 0 || value < 0) return [];
  return rows.map(splitCsv).map((cells) => ({ key: cells[key], period: cells[period], value: Number(cells[value]) }))
    .filter((row) => row.key && /^\d{4}-\d{2}/.test(row.period) && Number.isFinite(row.value));
}

async function ecbLatest(series: string, fetcher: typeof fetch) {
  const url = `${ECB}/${series}?lastNObservations=1&format=csvdata`;
  return { rows: parseEcbCsv(await getText(url, fetcher)), url };
}

// Harmonised consumer price inflation for Austria, annual rate of the latest month (Eurostat, ECOICOP 2).
export function inflation(fetcher: typeof fetch = fetch): Promise<Observation> {
  return cached("inflation:AT", async () => {
    const url = `${EUROSTAT}/prc_hicp_minr?geo=AT&unit=RCH_A&coicop18=TOTAL&lastTimePeriod=1`;
    const data = JSON.parse(await getText(url, fetcher)) as { value?: Record<string, number>; dimension?: { time?: { category?: { index?: Record<string, number> } } } };
    const period = Object.keys(data.dimension?.time?.category?.index ?? {})[0];
    const value = data.value?.["0"];
    if (!period || typeof value !== "number" || !Number.isFinite(value)) throw new Error("Inflation nicht verfügbar");
    return { value, period, source: "Eurostat · HVPI Österreich", url: "https://ec.europa.eu/eurostat/databrowser/view/prc_hicp_minr/default/table" };
  });
}

// ECB deposit facility rate plus average Austrian bank rates for household savings.
export function interestRates(fetcher: typeof fetch = fetch): Promise<InterestRates> {
  return cached("rates:AT", async () => {
    const [deposit, banks] = await Promise.allSettled([
      ecbLatest("FM/D.U2.EUR.4F.KR.DFR.LEV", fetcher),
      ecbLatest("MIR/M.AT.B.L21+L22.A+F.R.A.2250.EUR.N", fetcher),
    ]);
    const result: InterestRates = {};
    if (deposit.status === "fulfilled" && deposit.value.rows[0])
      result.ecbDeposit = { value: deposit.value.rows[0].value, period: deposit.value.rows[0].period, source: "EZB · Einlagesatz", url: deposit.value.url };
    if (banks.status === "fulfilled") {
      for (const row of banks.value.rows) {
        const observation = { value: row.value, period: row.period, url: banks.value.url };
        if (row.key.includes(".L21.A.")) result.overnight = { ...observation, source: "OeNB/EZB · täglich fällige Spareinlagen, Österreich" };
        if (row.key.includes(".L22.F.")) result.fixedUpToOneYear = { ...observation, source: "OeNB/EZB · gebundene Spareinlagen bis 1 Jahr, Österreich" };
      }
    }
    if (!result.ecbDeposit && !result.overnight && !result.fixedUpToOneYear) throw new Error("Zinsen nicht verfügbar");
    return result;
  });
}

// ECB reference rates: how much foreign currency one euro buys.
export function exchangeRates(currencies: string[], fetcher: typeof fetch = fetch): Promise<ExchangeRate[]> {
  const wanted = [...new Set(currencies.map((code) => code.toUpperCase()))].filter((code) => currencyCode.test(code) && code !== "EUR").slice(0, 10).sort();
  if (!wanted.length) return Promise.resolve([]);
  return cached(`fx:${wanted.join("+")}`, async () => {
    const { rows, url } = await ecbLatest(`EXR/D.${wanted.join("+")}.EUR.SP00.A`, fetcher);
    return rows.map((row) => ({ currency: row.key.split(".")[2], value: row.value, period: row.period, source: "EZB · Referenzkurs", url }))
      .filter((row) => wanted.includes(row.currency));
  });
}

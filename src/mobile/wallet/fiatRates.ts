/**
 * Daily fiat prices for History › Gains (docs/HISTORY-V2-PLAN.md §4):
 *   BSV/USD  — WhatsOnChain daily rate (txHistoryFetch.fetchDailyRates)
 *   USD/GBP  — Bank of England series XUDLUSS (US$ per £, London 4pm, business days; free CSV)
 * Both are cached in localStorage by UTC day; a day with no rate (weekend, bank holiday, gap) uses the
 * nearest earlier day's rate.
 */
import { Capacitor, CapacitorHttp } from '@capacitor/core';

export type DayRates = Map<string, number>;

export { dayKey, nearestPrevious } from './txHistory';
import { dayKey, nearestPrevious } from './txHistory';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Bank of England CSV ("DATE,XUDLUSS" / "01 Sep 2026,1.3538") → day → US$ per £. */
export const parseBoeCsv = (csv: string): DayRates => {
  const m: DayRates = new Map();
  for (const line of csv.split(/\r?\n/)) {
    const r = line.match(/^(\d{1,2}) ([A-Z][a-z]{2}) (\d{4}),\s*([\d.]+)/);
    if (!r) continue;
    const mon = MONTHS.indexOf(r[2]);
    const v = Number(r[4]);
    if (mon < 0 || !(v > 0)) continue;
    m.set(`${r[3]}-${String(mon + 1).padStart(2, '0')}-${r[1].padStart(2, '0')}`, v);
  }
  return m;
};

const boeDate = (ms: number) => {
  const d = new Date(ms);
  return `${String(d.getUTCDate()).padStart(2, '0')}/${MONTHS[d.getUTCMonth()]}/${d.getUTCFullYear()}`;
};

export const boeUrl = (fromMs: number, toMs: number) =>
  `https://www.bankofengland.co.uk/boeapps/database/_iadb-fromshowcolumns.asp?csv.x=yes&Datefrom=${boeDate(fromMs)}&Dateto=${boeDate(toMs)}&SeriesCodes=XUDLUSS&CSVF=TN&UsingCodes=Y&VPD=Y&VFD=N`;

// ─── Cache ───────────────────────────────────────────────────────────────────

const read = (key: string): DayRates => {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(key) ?? '{}') as Record<string, number>));
  } catch {
    return new Map();
  }
};
const write = (key: string, m: DayRates) => {
  try {
    localStorage.setItem(key, JSON.stringify(Object.fromEntries(m)));
  } catch {
    /* cache is a nice-to-have */
  }
};
export const BSV_USD_KEY = 'bwx.fx.bsvusd';
export const USD_PER_GBP_KEY = 'bwx.fx.usdpergbp';

/** Merge fresh BSV/USD daily rates into the cache and return everything cached. */
export const cacheBsvUsd = (fresh: DayRates) => {
  const m = read(BSV_USD_KEY);
  fresh.forEach((v, k) => m.set(k, v));
  write(BSV_USD_KEY, m);
  return m;
};

/** US$ per £ for every day from `fromMs`, cached; fetches only what the cache lacks. Never throws. */
export const usdPerGbp = async (fromMs: number, toMs = Date.now()): Promise<DayRates> => {
  const m = read(USD_PER_GBP_KEY);
  const days = [...m.keys()].sort();
  const have = days.length > 0 && days[0] <= dayKey(fromMs + 4 * 86_400_000);
  const start = have ? Date.parse(`${days[days.length - 1]}T00:00:00Z`) + 86_400_000 : fromMs - 7 * 86_400_000;
  if (start > toMs - 86_400_000 && have) return m;
  try {
    const url = boeUrl(start, toMs);
    // The Bank's CSV has no CORS header: on a phone use native networking.
    const text = Capacitor.isNativePlatform()
      ? String((await CapacitorHttp.request({ method: 'GET', url, responseType: 'text' })).data ?? '')
      : await (await fetch(url)).text();
    parseBoeCsv(text).forEach((v, k) => m.set(k, v));
    write(USD_PER_GBP_KEY, m);
  } catch {
    /* fall back to whatever is cached */
  }
  return m;
};

/** Fiat per BSV on a day: USD directly, GBP = USD ÷ (US$ per £). Undefined when unknown. */
export const bsvFiat = (day: string, bsvUsd: DayRates, currency: 'USD' | 'GBP', usdGbp?: DayRates) => {
  const usd = nearestPrevious(bsvUsd, day);
  if (usd === undefined) return undefined;
  if (currency === 'USD') return usd;
  const per = usdGbp && nearestPrevious(usdGbp, day);
  return per ? usd / per : undefined;
};

import { App as CapApp } from '@capacitor/app';
import { CHANNEL } from '../channel';
import { PUSH_ORIGIN } from '../push/logic';
import { YoursNative } from '../native';

/**
 * Tester check-ins (bwalletx.com/testers, privacy policy "Tester check-ins"). Google Play build only.
 *
 * Once a day, while the app is open, the Play build tells the bwalletx server: a random install id made on
 * this phone, the tester code (or Google email) the tester typed in Settings › Testing, the installer package
 * (com.android.vending = installed from Google Play) and the app version. Nothing else: no keys, addresses,
 * balances or activity. Nothing is sent until the tester links the app, and unlinking stops it.
 */
declare const __MOBILE_VERSION__: string;

export const TESTER_LINK_KEY = 'bwallet.testerLink';
export const TESTER_INSTALL_KEY = 'bwallet.testerInstallId';
export const TESTER_LAST_KEY = 'bwallet.testerLastCheckin';
export const TESTER_STATUS_KEY = 'bwallet.testerStatus';

export const testersEnabled = (c = CHANNEL) => c === 'android-play';
export const utcDay = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
/** A tester code (BWT-XXXX-XXXX) or an email address. */
export function cleanLink(s: string): string | null {
  const v = s.trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return v.toLowerCase();
  const c = v.toUpperCase().replace(/\s+/g, '');
  return /^BWT-[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c) ? c : null;
}
export const shouldCheckIn = (link: string | null, last: string | null, today: string) => !!link && last !== today;

const get = (k: string) => {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
};
const set = (k: string, v: string | null) => {
  try {
    if (v === null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* private storage */
  }
};

export function installId(): string {
  let id = get(TESTER_INSTALL_KEY);
  if (!id) {
    const b = crypto.getRandomValues(new Uint8Array(16));
    id = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
    set(TESTER_INSTALL_KEY, id);
  }
  return id;
}
export const testerLink = () => get(TESTER_LINK_KEY);
export type TesterStatus = { day: number; of: number; counted: number; playVerified: boolean } | { error: string };
export const lastStatus = (): TesterStatus | null => {
  try {
    return JSON.parse(get(TESTER_STATUS_KEY) ?? 'null');
  } catch {
    return null;
  }
};
export function setTesterLink(v: string | null) {
  set(TESTER_LINK_KEY, v);
  set(TESTER_LAST_KEY, null);
  set(TESTER_STATUS_KEY, null);
}

async function installer(): Promise<string | null> {
  try {
    return (await YoursNative.installerPackage()).installer ?? null;
  } catch {
    return null;
  }
}

/** Send today's check-in if linked and not yet sent today. Returns the server's answer, or null if skipped. */
export async function checkIn(force = false, f: typeof fetch = fetch): Promise<TesterStatus | null> {
  if (!testersEnabled()) return null;
  const link = testerLink();
  const today = utcDay();
  if (!force && !shouldCheckIn(link, get(TESTER_LAST_KEY), today)) return null;
  if (!link) return null;
  try {
    const r = await f(`${PUSH_ORIGIN}/v1/testers/checkin`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        installId: installId(),
        link,
        installer: await installer(),
        version: typeof __MOBILE_VERSION__ === 'string' ? __MOBILE_VERSION__ : null,
      }),
    });
    const j = await r.json().catch(() => ({}));
    const s: TesterStatus = r.ok
      ? { day: j.day, of: j.of, counted: j.counted, playVerified: !!j.playVerified }
      : { error: j.error || `Error ${r.status}` };
    if (r.ok) set(TESTER_LAST_KEY, today);
    set(TESTER_STATUS_KEY, JSON.stringify(s));
    return s;
  } catch {
    return null; // offline: try again next open
  }
}

export function initTesterCheckins() {
  if (!testersEnabled()) return;
  void checkIn();
  void CapApp.addListener('resume', () => void checkIn());
}

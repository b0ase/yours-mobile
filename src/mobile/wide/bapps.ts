import { useSyncExternalStore } from 'react';

/**
 * PROTOTYPE (demo/desktop-shell): the pinned bApps registry, the manifest reader and the sidebar badge
 * store for BappHost.tsx (shell protocol v2, @bwalletx/connect 0.4.0).
 */

export type BappEntry = { id: string; name: string; origin: string; icon: string };

const DEV_ORIGIN_RE = /^http:\/\/(localhost|127\.0\.0\.1)(:\d{2,5})?$/;
/** A local bMovies dev server (e.g. VITE_BMOVIES_ORIGIN=http://localhost:3111) is honoured only in dev builds. */
const devOrigin = (v: unknown): string | null =>
  import.meta.env.DEV || import.meta.env.VITE_BAPP_DEV === '1' ? (typeof v === 'string' && DEV_ORIGIN_RE.test(v) ? v : null) : null;

/** Pinned bApps. Exact origins only: this list IS the allowlist. */
export const BAPPS: readonly BappEntry[] = [
  {
    id: 'bmovies',
    name: 'bMovies',
    origin: devOrigin(import.meta.env.VITE_BMOVIES_ORIGIN) ?? 'https://bmovies.app',
    icon: '/icons/icon-192.png',
  },
];

export const BAPP_ROUTE = '/m/bapp/';
export const bappFromPath = (pathname: string): BappEntry | null =>
  pathname.startsWith(BAPP_ROUTE) ? (BAPPS.find((b) => b.id === pathname.slice(BAPP_ROUTE.length).split('/')[0]) ?? null) : null;

/* ---------- sidebar badge store (bapp:badge) ---------- */
const badges = new Map<string, number>();
const subs = new Set<() => void>();
export const setBadge = (id: string, n: number) => {
  badges.set(id, n);
  subs.forEach((f) => f());
};
const subscribe = (f: () => void) => (subs.add(f), () => subs.delete(f));
/** Live badge count for a bApp's sidebar entry (0 = none). */
export const useBappBadge = (id: string) => useSyncExternalStore(subscribe, () => badges.get(id) ?? 0);

/* ---------- manifest (only the parts the wallet draws) ---------- */
type Rec = Record<string, unknown>;
export type Section = { id: string; label: string; path: string; icon?: string };
export type Wide = { sections: Section[]; minWidth: number; home: string; name: string; icon: string | null };

export const isPath = (p: unknown): p is string => {
  if (typeof p !== 'string' || !p || p.length > 512 || p[0] !== '/' || p[1] === '/' || p[1] === '\\') return false;
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\\\u0000-\u001f\u007f\s]/.test(p)) return false;
  try {
    return new URL(p, 'https://bapp.invalid').origin === 'https://bapp.invalid';
  } catch {
    return false;
  }
};
const SECTION_ID = /^[a-z0-9][a-z0-9-]{0,23}$/;
const SLOT_LABELS: Record<string, string> = { wallet: 'Wallet', exchange: 'Exchange', feed: 'Feed', chat: 'Chat' };

/** Read the bApp's sections from its manifest; v1 manifests fall back to their path slots. Never throws. */
export function readWide(raw: unknown): Wide | null {
  const obj = (v: unknown): Rec => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Rec) : {});
  const m = obj(raw);
  if (m.version !== 1 || typeof m.name !== 'string') return null;
  const w = obj(m.wide);
  let sections: Section[] = [];
  if (Array.isArray(w.sections))
    sections = w.sections
      .map(obj)
      .filter((s) => typeof s.id === 'string' && SECTION_ID.test(s.id) && typeof s.label === 'string' && s.label.trim() && isPath(s.path))
      .slice(0, 16)
      .map((s) => ({
        id: s.id as string,
        label: (s.label as string).slice(0, 24),
        path: s.path as string,
        icon: typeof s.icon === 'string' ? s.icon : undefined,
      }));
  else {
    const slots = obj(m.slots);
    sections = ['wallet', 'exchange', 'feed', 'chat']
      .map((k) => [k, obj(slots[k])] as const)
      .filter(([, s]) => s.enabled === true && isPath(s.path))
      .map(([k, s]) => ({ id: k, label: String(s.label ?? SLOT_LABELS[k]).slice(0, 24), path: s.path as string, icon: k }));
  }
  const mw = w.minWidth;
  const minWidth = typeof mw === 'number' && Number.isInteger(mw) && mw >= 320 && mw <= 4096 ? mw : 720;
  const sbIcon = obj(w.sidebar).icon;
  const icon = isPath(sbIcon) ? sbIcon : isPath(m.icon) ? m.icon : null;
  return { sections, minWidth, home: isPath(m.home) ? m.home : '/', name: m.name.slice(0, 40), icon };
}


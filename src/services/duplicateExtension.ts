/**
 * Detect a second bWalletX (or Yours-family) extension in the same Chrome profile (owner, 28 Oct 2026: an unpacked
 * test build loaded next to the installed one). Both inject window.CWI into every page, so a site's payment can be
 * answered by either, and both run their own background sync against the same coins.
 *
 * No "management" permission: each extension's content script adds its own id to a shared attribute on <html>. A
 * content script that sees another id records it in its own chrome.storage.local; the wallet page warns once.
 */

export const MARK_ATTR = 'data-bwalletx-ext';
export const SEEN_KEY = 'bwxOtherExtension';
export const WARNED_KEY = 'bwxOtherExtensionWarned';

export const DUPLICATE_WARNING =
  'Another wallet extension is installed in this Chrome profile (two bWalletX copies, or another Yours-based wallet). Both answer payment requests and sync the same coins, which can make sends fail. Keep one: turn the other off in chrome://extensions.';

/** Pure: our id added to the attribute's id list, and the other ids already there. */
export function mergeMark(current: string | null, ownId: string): { next: string; others: string[] } {
  const ids = (current ?? '').split(/\s+/).filter(Boolean);
  const others = ids.filter((i) => i !== ownId);
  return { next: [...new Set([...ids, ownId])].join(' '), others };
}

type Store = {
  get: (k: string) => Promise<Record<string, unknown>>;
  set: (v: Record<string, unknown>) => Promise<void>;
};

/** Content script side. Marks the page, checks now and again shortly after (the other script may run later). */
export function markAndDetect(
  doc: Document,
  ownId: string | undefined,
  store: Store,
  later = (f: () => void) => setTimeout(f, 1500),
) {
  if (!ownId || !doc?.documentElement) return;
  const check = () => {
    const el = doc.documentElement;
    const { next, others } = mergeMark(el.getAttribute(MARK_ATTR), ownId);
    el.setAttribute(MARK_ATTR, next);
    if (others.length) void store.set({ [SEEN_KEY]: { ids: others, at: Date.now() } }).catch(() => undefined);
  };
  check();
  later(check);
}

/** Wallet page side: the warning to show, once per detection. Returns null when there is nothing (new) to say. */
export async function duplicateWarningOnce(store: Store): Promise<string | null> {
  try {
    const v = await store.get(SEEN_KEY);
    const w = await store.get(WARNED_KEY);
    const seen = v[SEEN_KEY] as { ids?: string[]; at?: number } | undefined;
    if (!seen?.ids?.length) return null;
    const warnedAt = (w[WARNED_KEY] as number | undefined) ?? 0;
    if ((seen.at ?? 0) <= warnedAt) return null;
    await store.set({ [WARNED_KEY]: Date.now() });
    return DUPLICATE_WARNING;
  } catch {
    return null;
  }
}

/** chrome.storage.local as a Store (undefined outside an extension). */
export const chromeLocalStore = (): Store | undefined => {
  type Local = {
    get: (k: string, cb: (v: Record<string, unknown>) => void) => void;
    set: (v: Record<string, unknown>, cb: () => void) => void;
  };
  const s = (globalThis as { chrome?: { storage?: { local?: Local } } }).chrome?.storage?.local;
  if (!s) return undefined;
  return {
    get: (k) => new Promise((res) => s.get(k, (v: Record<string, unknown>) => res(v ?? {}))),
    set: (v) => new Promise((res) => s.set(v, () => res())),
  };
};

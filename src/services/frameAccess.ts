/**
 * The wallet inside iframes. The provider content scripts run in sub-frames
 * (manifest all_frames) so a game framed by another site (TERRORNODE on tokenblaster.lol inside bChatX's room
 * player) can pay. Every rule here takes its inputs from Chrome's MessageSender in the background (sender.frameId,
 * sender.origin, sender.tab.url, sender.documentLifecycle), never from anything the page put in a message.
 *
 * - A sub-frame may use the wallet only when its own origin AND the tab's top-level URL are https, and its document
 *   is active. A sandboxed frame has the opaque origin "null" and is refused; so are http, data:, blob:, file: etc.
 *   (No loopback exception inside frames: local development uses a top-level page.)
 * - Grants stay keyed to the frame's own origin (the site actually asking).
 * - The first time a (frame origin, top origin) pair asks for anything beyond the read-only calls, the wallet asks
 *   afresh ("www.tokenblaster.lol inside www.bchatx.com"), and remembers the answer per pair. A top-level grant to
 *   the frame's site never carries into an unknown parent by itself.
 * - Family-in-family pairs (both hosts on the owner's family list) skip that one extra question; their normal sheets
 *   still show both origins.
 */

import { familySite } from '../mobile/theme/themeSites';

const bareHost = (h: string): string =>
  h
    .replace(/^https?:\/\//, '')
    .replace(/\/.*$/, '')
    .toLowerCase();

/** What Chrome tells the background about a message's sender (chrome.runtime.MessageSender, the parts we use). */
export interface FrameSender {
  frameId?: number;
  origin?: string;
  url?: string;
  documentLifecycle?: string;
  tab?: { url?: string };
}

export type FramePolicy =
  | { ok: true; framed: false }
  | { ok: true; framed: true; frameHost: string; topHost: string }
  | { ok: false; error: string };

export const FRAME_REFUSED = 'bWalletX only works inside a secure (https) site';

const httpsHost = (raw: string | undefined | null): string | null => {
  if (!raw || raw === 'null') return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || !u.host || u.username || u.password) return null;
    return u.host.toLowerCase();
  } catch {
    return null;
  }
};

/** May this sender use the wallet, and is it framed? Top frames (frameId 0) are left to the existing rules. */
export const framePolicy = (sender: FrameSender | undefined): FramePolicy => {
  if (!sender || sender.frameId === undefined || sender.frameId === 0) return { ok: true, framed: false };
  // Prerendered or back/forward-cached documents never ask.
  if (sender.documentLifecycle !== undefined && sender.documentLifecycle !== 'active')
    return { ok: false, error: FRAME_REFUSED };
  // sender.origin is Chrome's: the frame's real (possibly opaque) origin. A sandboxed frame without allow-same-origin
  // reports "null"; one without allow-scripts never runs the page code that would call the wallet at all.
  const frameHost = httpsHost(sender.origin);
  if (!frameHost) return { ok: false, error: FRAME_REFUSED };
  // The tab's own URL (needs the "tabs" permission, which the manifest has): the top-level document.
  const topHost = httpsHost(sender.tab?.url);
  if (!topHost) return { ok: false, error: FRAME_REFUSED };
  return { ok: true, framed: true, frameHost, topHost };
};

/**
 * Hosts that count as family for framing besides THEME_SITES (familySite). tokenblaster.lol is TokenBlaster's
 * live domain (themeSites lists tokenblaster.com) and its arcade games play inside bChatX rooms.
 */
const FRAME_FAMILY_EXTRA: readonly string[] = ['tokenblaster.lol'];

export const isFamilyHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '');
  if (familySite(h)) return true;
  const bare = h.startsWith('www.') ? h.slice(4) : h;
  return FRAME_FAMILY_EXTRA.includes(bare);
};

/** Both sides on the family list: the extra pair question is skipped (sheets still show both origins). */
export const isFamilyPair = (frameHost: string, topHost: string): boolean =>
  isFamilyHost(frameHost) && isFamilyHost(topHost);

/**
 * Calls that neither spend nor sign nor use a key: allowed for an approved-https frame without the pair question
 * (their usual permission rules still apply). Everything else (createAction, signAction, createSignature,
 * encrypt/decrypt, HMAC, certificates, spending grants, mintPrivate, twetch.*, …) needs the pair approved first.
 */
const PAIR_FREE_ACTIONS: ReadonlySet<string> = new Set([
  'isAuthenticated',
  'waitForAuthentication',
  'getVersion',
  'getNetwork',
  'getHeight',
  'getHeaderForHeight',
  'getPublicKey',
  'listOutputs',
  'listActions',
]);

export const needsPairApproval = (action: unknown): boolean =>
  typeof action !== 'string' || !PAIR_FREE_ACTIONS.has(action);

export const pairKey = (frameHost: string, topHost: string): string =>
  `${frameHost.toLowerCase()}|${topHost.toLowerCase()}`;

/** "www.tokenblaster.lol (inside www.bchatx.com)"; several recent parents are all named. */
export const framedLabel = (frameHost: string, topHosts: readonly string[]): string =>
  topHosts.length ? `${frameHost} (inside ${topHosts.join(', ')})` : frameHost;

/** Approved (frame, top) pairs, persisted. */
export class FramePairs {
  private set: Set<string> | undefined;
  private loading: Promise<Set<string>> | undefined;
  constructor(
    private deps: {
      load: () => Promise<string[]>;
      save: (keys: string[]) => Promise<void>;
    },
  ) {}
  private ready(): Promise<Set<string>> {
    if (this.set) return Promise.resolve(this.set);
    this.loading ??= this.deps
      .load()
      .catch(() => [] as string[])
      .then((keys) => (this.set = new Set(keys.filter((k) => typeof k === 'string'))));
    return this.loading;
  }
  async has(frameHost: string, topHost: string): Promise<boolean> {
    return (await this.ready()).has(pairKey(frameHost, topHost));
  }
  async add(frameHost: string, topHost: string): Promise<void> {
    const s = await this.ready();
    s.add(pairKey(frameHost, topHost));
    await this.deps.save([...s]);
  }
  /** Forget every pair a frame site is part of (its grants were revoked). */
  async forgetFrame(frameHost: string): Promise<void> {
    const s = await this.ready();
    const pre = `${frameHost.toLowerCase()}|`;
    for (const k of [...s]) if (k.startsWith(pre)) s.delete(k);
    await this.deps.save([...s]);
  }
}

/**
 * Which parents an originator was recently framed by, so every sheet for that site names them. Kept per originator
 * (wallet prompts carry only the originator); a site seen framed in the last FRAMED_TTL_MS gets the "inside …" line
 * on all its sheets, even one it raised at top level meanwhile: over-warning, never under-warning.
 */
export const FRAMED_TTL_MS = 10 * 60 * 1000;
export class FramedContext {
  private seen = new Map<string, Map<string, number>>();
  note(originator: string, topHost: string, now: number): void {
    const m = this.seen.get(originator) ?? new Map<string, number>();
    m.set(topHost, now);
    this.seen.set(originator, m);
  }
  topsFor(originator: string | undefined, now: number): string[] {
    if (!originator) return [];
    const m = this.seen.get(originator);
    if (!m) return [];
    for (const [top, at] of m) if (now - at > FRAMED_TTL_MS) m.delete(top);
    if (!m.size) this.seen.delete(originator);
    return [...m.keys()];
  }
  /** Seen framed by a parent outside the family: such a site's sheets never open as an in-page sheet. */
  framedByStranger(originator: string | undefined, now: number): boolean {
    if (!originator) return false;
    return this.topsFor(originator, now).some((top) => !isFamilyPair(originator, top));
  }
}

/** "www.tokenblaster.lol (inside www.bchatx.com)": the site asking, and the page(s) it was framed by. */
export const originLabel = (originator: string, embeddedIn?: readonly string[]): string =>
  embeddedIn?.length
    ? `${bareHost(originator)} (inside ${embeddedIn.map((h) => bareHost(h)).join(', ')})`
    : bareHost(originator);

/** A framed site's sheet keeps its buttons off this long after it appears (clickjacking guard). */
export const FRAMED_ARM_MS = 1500;

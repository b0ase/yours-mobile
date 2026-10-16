/**
 * Back to where you were after iOS kills the web view (owner, 15 Oct 2026). When the WKWebView's content process
 * is terminated for memory, Capacitor reloads the page (WebViewDelegationHandler.webViewWebContentProcessDidTerminate)
 * and the app cold-starts on the Wallet. We remember the route (and the Feed's sub-feed) as the user moves, with an
 * "alive" flag that is cleared whenever the app goes to the background. A cold start that finds the flag still set
 * ended abnormally while on screen, so ResumeAfterCrash.tsx reopens the saved route. A normal relaunch (the app was
 * backgrounded first, or the record is old) starts as usual.
 */

export const RESUME_KEY = 'bwallet:resume';
/** Older than this, a crashed session is not resumed. */
export const RESUME_MAX_AGE_MS = 10 * 60_000;

export type ResumeRecord = {
  route: string;
  /** Feed › sub-feed on screen (FeedPage's FeedId), if any. */
  feed?: string;
  /** True while the app is in the foreground; cleared on going to the background. */
  alive: boolean;
  at: number;
  /** 1 once this route was reopened after a crash; a second crash there without moving on is not resumed again. */
  resumes?: number;
};

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Routes that are never resumed: the start screen and onboarding. */
const NEVER = new Set(['/', '/create-wallet', '/restore-wallet', '/import-wallet', '/master-restore', '/sweep']);

const read = (store: Store): ResumeRecord | null => {
  try {
    const r = JSON.parse(store.getItem(RESUME_KEY) ?? 'null') as ResumeRecord | null;
    return r && typeof r.route === 'string' && typeof r.at === 'number' ? r : null;
  } catch {
    return null;
  }
};

const write = (store: Store, r: ResumeRecord) => {
  try {
    store.setItem(RESUME_KEY, JSON.stringify(r));
  } catch {
    /* storage unavailable */
  }
};

/** The record to resume at cold start, or null: only after an abnormal end, recent, on a resumable route. */
export const crashedSession = (store: Store, now: number): ResumeRecord | null => {
  const r = read(store);
  if (!r || !r.alive || (r.resumes ?? 0) > 0 || now - r.at > RESUME_MAX_AGE_MS || now < r.at) return null;
  if (NEVER.has(r.route.split('?')[0])) return null;
  return r;
};

/** The user is on `route` with the app on screen. Onboarding / start routes are not recorded. */
export const noteRoute = (store: Store, route: string, now: number) => {
  if (NEVER.has(route.split('?')[0])) return;
  const r = read(store);
  write(store, { route, feed: r?.feed, alive: true, at: now, resumes: r?.route === route ? r.resumes : undefined });
};

/** The saved route was just reopened after a crash (see `resumes`). */
export const markResumed = (store: Store, now: number) => {
  const r = read(store);
  if (r) write(store, { ...r, alive: true, at: now, resumes: 1 });
};

/** The Feed's sub-feed changed. */
export const noteFeed = (store: Store, feed: string, now: number) => {
  const r = read(store);
  if (r) write(store, { ...r, feed, at: now });
};

/** The app went to the background: a later cold start is a normal launch. */
export const markClean = (store: Store) => {
  const r = read(store);
  if (r?.alive) write(store, { ...r, alive: false });
};

/** Back in the foreground. */
export const markAlive = (store: Store, now: number) => {
  const r = read(store);
  if (r && !r.alive) write(store, { ...r, alive: true, at: now, resumes: undefined });
};

const local = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

// Read once at load, before this run writes anything.
const atLoad = (() => {
  const s = local();
  return s ? crashedSession(s, Date.now()) : null;
})();
let feedPending = atLoad?.feed ?? null;

/** The route to reopen after a crash (read at load), or null. */
export const crashRoute = () => atLoad?.route ?? null;

/** The sub-feed to reopen after a crash, once (the first FeedPage to mount takes it). */
export const takeCrashFeed = (): string | null => {
  const f = feedPending;
  feedPending = null;
  return f;
};

/** Records the Feed's sub-feed (FeedPage). */
export const rememberFeed = (feed: string) => {
  const s = local();
  if (s) noteFeed(s, feed, Date.now());
};

export const localResumeStore = local;

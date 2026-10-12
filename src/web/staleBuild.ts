/**
 * Picks up a newer web build without ever reloading under the user (owner, 12 Oct 2026: desktop.bwalletx.com/media
 * "awkwardly refreshes when the browser window is opened").
 *
 * A tab keeps the build it first loaded (an SPA never refetches index.html), so tabs opened before a deploy showed an
 * older layout next to newer ones (owner, 9 Oct 2026). The first fix reloaded the page as soon as the tab came back
 * into view and a newer main-*.js was live. Desktop deploys many times a day, so that reload hit almost every return
 * to the tab: the page flashed, the scroll and the open view were lost and the stream player stopped.
 *
 * Now focus only *checks* (at most once a minute). A newer build is applied on the next in-app navigation, which
 * already changes the whole view, and never while audio or video is playing. The keys stay encrypted in localStorage
 * and the unlock session in sessionStorage, both survive that load.
 *
 * `installStaleBuildCheck` is inlined into the page as a classic script (vite.config.web.ts), so it must stay
 * self-contained: no imports, no closures over module scope.
 */
export type StaleEnv = {
  doc: Pick<Document, 'querySelector' | 'querySelectorAll' | 'addEventListener' | 'visibilityState'>;
  win: Pick<Window, 'addEventListener'> & { history: Pick<History, 'pushState'>; location: Pick<Location, 'assign'> };
  fetchText: (url: string) => Promise<string>;
  now: () => number;
};

export function installStaleBuildCheck(env?: StaleEnv): { check: () => Promise<void>; stale: () => boolean } | null {
  const e: StaleEnv = env || {
    doc: document,
    win: window,
    fetchText: (u) => fetch(u, { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')),
    now: () => Date.now(),
  };
  const GAP_MS = 60_000;
  const m = e.doc.querySelector('script[type=module][src*="main-"]');
  if (!m) return null;
  const mine = (m.getAttribute('src') || '').split('/').pop();
  let busy = false;
  let last = 0;
  let stale = false;
  const check = async () => {
    if (stale || busy || e.doc.visibilityState !== 'visible' || e.now() - last < GAP_MS) return;
    busy = true;
    last = e.now();
    try {
      const x = /assets\/(main-[^"']+\.js)/.exec(await e.fetchText('/'));
      if (x && x[1] !== mine) stale = true;
    } catch {
      /* offline: try again on the next focus */
    } finally {
      busy = false;
    }
  };
  const playing = () =>
    Array.prototype.some.call(e.doc.querySelectorAll('audio,video'), (el: HTMLMediaElement) => !el.paused && !el.ended);
  const push = e.win.history.pushState;
  e.win.history.pushState = function (this: History, data: unknown, unused: string, url?: string | URL | null) {
    // A newer build is out: load it as this navigation's page instead of swapping the view in place.
    if (stale && url != null && !playing()) {
      e.win.location.assign(String(url));
      return;
    }
    return push.call(this, data, unused, url);
  } as History['pushState'];
  e.doc.addEventListener('visibilitychange', () => void check());
  e.win.addEventListener('focus', () => void check());
  return { check, stale: () => stale };
}

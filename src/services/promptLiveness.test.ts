/**
 * BRC-219 (Wallet Permission Prompt Liveness): no clock on a prompt that is up; a pending request fails only when its
 * prompt was never shown, its surface is gone, or its caller is gone. These drive the caller-gone registry and the
 * tracked sheet maps background.ts uses (every pending-sheet map is a TrackedSheets wired to one CallerRegistry).
 */
import { describe, expect, test } from 'bun:test';
import {
  ASKED_AGAIN_MS,
  AskedAgain,
  CallerRegistry,
  PROMPT_CALLER_GONE_CODE,
  TrackedSheets,
  attachLivePort,
  promptCallerGoneError,
  siteStillAsking,
  unlockSurfaceGone,
  type SheetRef,
} from './promptLiveness';
import { withPromptNotShownCode } from './promptWatchdog';

/** The background's wiring in miniature: a tracked map, the registry, and the closer (here: delete + record). */
const wired = () => {
  const reg = new CallerRegistry();
  const closed: string[] = [];
  const granted: string[] = [];
  const close = (refs: SheetRef[]) => {
    for (const r of refs) if (sheets.delete(r.id)) closed.push(r.id);
  };
  const sheets: TrackedSheets<{ request: { originator?: string; type?: string } }> = new TrackedSheets('permission', {
    siteOf: (o) => o,
    raised: (ref) => {
      if (reg.raise(ref)) close([ref]);
    },
    settled: (kind, id) => reg.settle(kind, id),
  });
  /** processPermissionResponse: Allow grants only a request that is still pending. */
  const allow = (id: string) => {
    if (!sheets.has(id)) return false;
    sheets.delete(id);
    granted.push(id);
    return true;
  };
  return { reg, sheets, closed, granted, allow, gone: (t: string) => close(reg.callerGone(t)) };
};

describe('caller gone: Allow racing a tab close', () => {
  test('the tab closes first: its payment sheet is closed, and the Allow that arrives next grants nothing', () => {
    const w = wired();
    w.reg.start('tabA-doc1', 'shop.example', 'createAction');
    w.sheets.set('spend-1', { request: { originator: 'shop.example', type: 'spending' } });
    w.gone('tabA-doc1'); // port disconnect processed before the Allow message
    expect(w.allow('spend-1')).toBe(false);
    expect(w.granted).toEqual([]);
    expect(w.closed).toEqual(['spend-1']);
  });

  test('the spending request arrives after the caller left: closed at once, never shown long enough to Allow', () => {
    const w = wired();
    w.reg.start('doc1', 'shop.example', 'createAction');
    w.gone('doc1'); // nothing to close yet: the call is still building
    w.sheets.set('spend-late', { request: { originator: 'shop.example', type: 'spending' } });
    expect(w.closed).toEqual(['spend-late']);
    expect(w.allow('spend-late')).toBe(false);
  });

  test('a port that closes before its call is even registered still counts (gone first, then start)', () => {
    const w = wired();
    w.gone('doc-quick');
    expect(w.reg.start('doc-quick', 'shop.example', 'createAction')).toBe(false);
    w.sheets.set('spend-q', { request: { originator: 'shop.example', type: 'spending' } });
    expect(w.closed).toEqual(['spend-q']);
  });

  test('the caller-gone error carries its code to the site', () => {
    const e = promptCallerGoneError();
    expect(e.code).toBe(PROMPT_CALLER_GONE_CODE);
    expect(withPromptNotShownCode({ success: false, error: e.message })).toMatchObject({
      code: PROMPT_CALLER_GONE_CODE,
      status: 410,
    });
  });
});

describe('caller gone: no per-site counting (the count leak)', () => {
  test("another document's never-answered call does not keep a closed document's sheet alive", () => {
    const w = wired();
    // Tab A posts something that is never answered (it never even becomes a call), and makes one call that hangs.
    w.reg.start('tabA', 'shop.example', 'getPublicKey');
    // Tab B pays.
    w.reg.start('tabB', 'shop.example', 'createAction');
    w.sheets.set('spend-B', { request: { originator: 'shop.example', type: 'spending' } });
    w.gone('tabB');
    expect(w.closed).toEqual(['spend-B']);
    expect(w.allow('spend-B')).toBe(false);
  });

  test("a payment sheet is owned by the site's createAction calls only: another document's read does not own it", () => {
    const w = wired();
    w.reg.start('tabA', 'shop.example', 'listOutputs');
    w.reg.start('tabB', 'shop.example', 'createAction');
    w.sheets.set('spend-B', { request: { originator: 'shop.example', type: 'spending' } });
    w.gone('tabA'); // tab A closes: B's payment is untouched
    expect(w.closed).toEqual([]);
    expect(w.allow('spend-B')).toBe(true);
  });

  test('an answered call owns nothing any more; another site is never touched', () => {
    const w = wired();
    w.reg.start('doc1', 'shop.example', 'createAction');
    w.reg.start('doc2', 'other.example', 'createAction');
    w.sheets.set('other', { request: { originator: 'other.example', type: 'spending' } });
    w.reg.end('doc1');
    w.gone('doc1');
    expect(w.closed).toEqual([]);
    expect(w.reg.inFlight('shop.example')).toBe(0);
  });
});

describe('caller gone: a joined (deduped) request', () => {
  test('the tab reloads while its Retry joined from the new page: the sheet stays; both gone closes it', () => {
    const w = wired();
    w.reg.start('doc-old', 'game.example', 'createAction');
    w.sheets.set('spend-1', { request: { originator: 'game.example', type: 'spending' } });
    w.reg.start('doc-new', 'game.example', 'createAction');
    w.reg.join('doc-old', 'doc-new'); // createActionDedupe: one call, two callers
    w.gone('doc-old'); // the old page unloaded
    expect(w.closed).toEqual([]);
    expect(w.sheets.has('spend-1')).toBe(true);
    w.gone('doc-new');
    expect(w.closed).toEqual(['spend-1']);
  });
});

describe('TrackedSheets behaves like a Map and reports raise / settle once', () => {
  test('set of a new id raises; re-set does not; delete and clear settle', () => {
    const raised: string[] = [];
    const settled: string[] = [];
    const m = new TrackedSheets<{ request: { originator?: string; type?: string } }>('swap', {
      siteOf: (o) => o.toUpperCase(),
      raised: (r) => raised.push(`${r.kind}:${r.id}:${r.site}:${r.payment ? 'pay' : '-'}`),
      settled: (k, id) => settled.push(`${k}:${id}`),
    });
    m.set('a', { request: { originator: 'x.example', type: 'spending' } });
    m.set('a', { request: { originator: 'x.example' } });
    m.set('b', { request: { originator: 'y.example' } });
    expect(m.size).toBe(2);
    expect(m.delete('a')).toBe(true);
    expect(m.delete('a')).toBe(false);
    m.clear();
    expect(raised).toEqual(['swap:a:X.EXAMPLE:pay', 'swap:b:Y.EXAMPLE:-']);
    expect(settled).toEqual(['swap:a', 'swap:b']);
  });
});

describe('AskedAgain: a payment this site already asked for says so', () => {
  test('same site and outputs within the window -> seconds since; otherwise null', () => {
    let now = 1_000_000;
    const a = new AskedAgain(() => now);
    expect(a.note('game.example', 'h1')).toBeNull();
    now += 20_000;
    expect(a.note('game.example', 'h1')).toBe(20);
    expect(a.note('game.example', 'h2')).toBeNull();
    expect(a.note('other.example', 'h1')).toBeNull();
    now += ASKED_AGAIN_MS + 1;
    expect(a.note('game.example', 'h1')).toBeNull();
  });
});

describe('unlockSurfaceGone: no clock on the unlock screen, only its loss', () => {
  const up = { waiting: 1, setup: false, unlocking: false, panels: 0, popupWindow: false, inPageSheet: false };
  test('nothing can show it any more -> gone; anything up, setup or an unlock finishing -> not', () => {
    expect(unlockSurfaceGone(up)).toBe(true);
    expect(unlockSurfaceGone({ ...up, panels: 1 })).toBe(false);
    expect(unlockSurfaceGone({ ...up, popupWindow: true })).toBe(false);
    expect(unlockSurfaceGone({ ...up, inPageSheet: true })).toBe(false);
    expect(unlockSurfaceGone({ ...up, waiting: 0 })).toBe(false);
    expect(unlockSurfaceGone({ ...up, setup: true })).toBe(false);
    expect(unlockSurfaceGone({ ...up, unlocking: true })).toBe(false);
  });
});

describe('siteStillAsking', () => {
  test('a sheet of the site on screen, or the unlock screen up -> still asking', () => {
    const none = { shownSheets: 0, otherSheets: 0, walletWaiters: 0 };
    expect(siteStillAsking(none)).toBe(false);
    expect(siteStillAsking({ ...none, shownSheets: 1 })).toBe(true);
    expect(siteStillAsking({ ...none, walletWaiters: 1 })).toBe(true);
  });
});

/** A chrome.runtime.Port stand-in: the content script posts its token; Chrome disconnects it when the page goes. */
const fakePort = () => {
  let onMsg: (m: unknown) => void = () => undefined;
  let onDisc: () => void = () => undefined;
  return {
    port: {
      onMessage: { addListener: (fn: (m: unknown) => void) => (onMsg = fn) },
      onDisconnect: { addListener: (fn: () => void) => (onDisc = fn) },
    },
    post: (m: unknown) => onMsg(m),
    unload: () => onDisc(),
  };
};
const deferred = <T>() => {
  let resolve!: (v: T) => void;
  const p = new Promise<T>((r) => (resolve = r));
  return { p, resolve };
};
const flush = () => new Promise((r) => setTimeout(r, 0));

describe('re-review: a reload while locked, through the background wiring (onConnect -> callerGone -> close)', () => {
  /** One site call as background.ts runs it: register, wait for unlock under guard, then ask (raise a payment sheet). */
  const siteCall = (w: ReturnType<typeof wired>, token: string, unlock: Promise<void>, sheetID: string) => {
    const p = fakePort();
    attachLivePort(p.port, w.reg, (refs) => {
      for (const r of refs) if (w.sheets.delete(r.id)) w.closed.push(r.id);
    });
    p.post({ token });
    w.reg.start(token, 'game.example', 'createAction');
    const answered = w.reg
      .guard(token, unlock)
      .then(() => {
        w.sheets.set(sheetID, { request: { originator: 'game.example', type: 'spending' } });
        return 'asked';
      })
      .catch((e: { code?: string }) => e.code)
      .finally(() => w.reg.end(token)); // sendResponse
    return { ...p, answered };
  };

  test('locked, the page reloads and retries: the old call ends at once, and after unlock the new sheet stays', async () => {
    const w = wired();
    const unlock = deferred<void>();
    const old = siteCall(w, 'doc-old', unlock.p, 'spend-old');
    old.unload(); // reload instead of unlocking
    expect(await old.answered).toBe(PROMPT_CALLER_GONE_CODE); // (a) its unlock wait was rejected promptly
    expect(w.reg.inFlight('game.example')).toBe(0);
    const fresh = siteCall(w, 'doc-new', unlock.p, 'spend-new');
    unlock.resolve();
    expect(await fresh.answered).toBe('asked');
    await flush();
    expect(w.closed).toEqual([]);
    expect(w.sheets.has('spend-old')).toBe(false); // the dead call never asked
    expect(w.allow('spend-new')).toBe(true); // the live page's payment is approvable
  });

  test("a dead call that hangs (never answers) does not close the live page's later sheets", () => {
    const w = wired();
    const hung = fakePort();
    attachLivePort(hung.port, w.reg, () => undefined);
    hung.post({ token: 'doc-old' });
    w.reg.start('doc-old', 'game.example', 'createAction'); // e.g. the never-answering step, past every wait
    hung.unload();
    w.reg.start('doc-new', 'game.example', 'createAction');
    w.sheets.set('spend-new', { request: { originator: 'game.example', type: 'spending' } });
    expect(w.closed).toEqual([]); // (b) a call that died before the sheet existed is not its owner
    expect(w.allow('spend-new')).toBe(true);
  });

  test('a live candidate that dies later still closes the sheet it could own', () => {
    const w = wired();
    const p = fakePort();
    attachLivePort(p.port, w.reg, (refs) => {
      for (const r of refs) if (w.sheets.delete(r.id)) w.closed.push(r.id);
    });
    p.post({ token: 'doc-1' });
    w.reg.start('doc-1', 'game.example', 'createAction');
    w.sheets.set('spend-1', { request: { originator: 'game.example', type: 'spending' } });
    p.unload();
    expect(w.closed).toEqual(['spend-1']);
  });
});

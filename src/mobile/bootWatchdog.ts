/**
 * Boot watchdog and boot trace (owner's iPhone, 13 Nov 2026: an account switch left a permanent black screen).
 *
 * - Each boot records the stages it reaches, with ms since start, in localStorage `bwallet.bootTrace` (the previous
 *   boot's trace moves to `bwallet.bootTrace.prev`, so the one that stalled survives the force-quit and reopen).
 * - If the app has not reached "ready" (ServiceProvider's services loaded) within BOOT_TIMEOUT_MS, a plain DOM notice
 *   with a Reload button covers the screen. No React: it must work when React never mounted.
 *
 * It only helps while the page's JavaScript still runs: a WebView whose web process stops responding cannot fire
 * this timer (that needs a native watchdog).
 */

export const BOOT_TRACE_KEY = 'bwallet.bootTrace';
export const BOOT_TRACE_PREV_KEY = 'bwallet.bootTrace.prev';
export const BOOT_TIMEOUT_MS = 15_000;
const OVERLAY_ID = 'bwallet-boot-watchdog';

export interface BootTrace {
  startedAt: string;
  stages: { stage: string; ms: number }[];
  ready?: boolean;
}

export type WatchdogDecision = 'done' | 'wait' | 'show';

/** Pure: what the watchdog does at `now`. */
export const bootWatchdogDecision = (s: {
  now: number;
  startedAt: number;
  ready: boolean;
  shown: boolean;
  timeoutMs?: number;
}): WatchdogDecision => {
  if (s.ready || s.shown) return 'done';
  return s.now - s.startedAt >= (s.timeoutMs ?? BOOT_TIMEOUT_MS) ? 'show' : 'wait';
};

/** Pure: the trace with one more stage (stages capped so a looping caller cannot grow it without bound). */
export const addStage = (trace: BootTrace, stage: string, ms: number, ready = false): BootTrace => ({
  ...trace,
  stages: [...trace.stages, { stage, ms: Math.round(ms) }].slice(-50),
  ...(ready ? { ready: true } : {}),
});

let trace: BootTrace | undefined;
let t0 = 0;
let ready = false;
let shown = false;
let timer: ReturnType<typeof setTimeout> | undefined;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const save = () => {
  try {
    if (trace) localStorage.setItem(BOOT_TRACE_KEY, JSON.stringify(trace));
  } catch {
    // diagnostics never change behaviour
  }
};

/** Record a boot stage. A no-op until startBootWatchdog ran (the extension, tests). */
export const markBootStage = (stage: string) => {
  if (!trace) return;
  trace = addStage(trace, stage, now() - t0);
  save();
};

/** The app reached its first useful screen: stop the watchdog and take down its notice if it is up. */
export const markBootReady = (stage = 'ready') => {
  if (!trace || ready) return;
  ready = true;
  trace = addStage(trace, stage, now() - t0, true);
  save();
  if (timer) clearTimeout(timer);
  timer = undefined;
  try {
    document.getElementById(OVERLAY_ID)?.remove();
  } catch {
    // no document
  }
};

const showNotice = () => {
  shown = true;
  markBootStage('watchdog: notice shown');
  try {
    console.warn('[boot] not ready after', Math.round((now() - t0) / 1000), 's; stages:', JSON.stringify(trace));
  } catch {
    // ignore
  }
  try {
    const box = document.createElement('div');
    box.id = OVERLAY_ID;
    box.setAttribute('role', 'alertdialog');
    box.style.cssText =
      'position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;' +
      'justify-content:center;gap:16px;padding:24px;background:#010101;color:#fff;text-align:center;' +
      'font:16px/1.4 Inter,system-ui,-apple-system,sans-serif';
    const title = document.createElement('div');
    title.textContent = 'bWalletX is taking longer than usual to open.';
    title.style.cssText = 'font-weight:600;max-width:320px';
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = 'Reload';
    button.style.cssText =
      'padding:12px 32px;border:0;border-radius:999px;background:#f5c518;color:#000;font:inherit;font-weight:700';
    button.addEventListener('click', () => {
      markBootStage('watchdog: reload tapped');
      location.reload();
    });
    const hint = document.createElement('div');
    hint.textContent = 'If this keeps happening, close the app and open it again.';
    hint.style.cssText = 'font-size:13px;opacity:0.6;max-width:300px';
    box.append(title, button, hint);
    document.body.appendChild(box);
  } catch {
    // no document: nothing to show
  }
};

const tick = (timeoutMs: number) => {
  const d = bootWatchdogDecision({ now: now(), startedAt: t0, ready, shown, timeoutMs });
  if (d === 'show') showNotice();
  // A suspended WebView fires late timers early or not at all: re-arm until it is time.
  else if (d === 'wait') timer = setTimeout(() => tick(timeoutMs), Math.max(250, timeoutMs - (now() - t0)));
};

/** Start this boot's trace and watchdog. Call once, as early as possible in the page's entry point. */
export const startBootWatchdog = (timeoutMs = BOOT_TIMEOUT_MS) => {
  if (trace) return;
  t0 = now();
  try {
    const prev = localStorage.getItem(BOOT_TRACE_KEY);
    if (prev) localStorage.setItem(BOOT_TRACE_PREV_KEY, prev);
  } catch {
    // ignore
  }
  trace = { startedAt: new Date().toISOString(), stages: [] };
  markBootStage('main: start');
  timer = setTimeout(() => tick(timeoutMs), timeoutMs);
};

/** Tests only. */
export const __resetBootWatchdogForTests = () => {
  if (timer) clearTimeout(timer);
  trace = undefined;
  t0 = 0;
  ready = false;
  shown = false;
  timer = undefined;
};

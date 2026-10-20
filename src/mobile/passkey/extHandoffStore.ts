/**
 * Browser glue for the extension passkey hand-off (rules live in extHandoff.ts). The request and the parked words
 * live in chrome.storage.session: memory only, never written to disk, gone when the browser closes. Only the
 * extension's own pages and its service worker can read it (the default for session storage).
 */
import {
  HANDOFF_ENABLED,
  confirmHandoff,
  handoffUrl,
  newHandoffSession,
  receiveHandoff,
  type ConfirmResult,
  type HandoffSession,
} from './extHandoff';

export const HANDOFF_KEY = 'bwxExtHandoff';

/** The slice of chrome.storage.StorageArea we use, so tests can pass a plain fake. */
export type SessionArea = {
  get: (key: string) => Promise<Record<string, unknown>>;
  set: (items: Record<string, unknown>) => Promise<void>;
  remove: (key: string) => Promise<void>;
};

const area = (): SessionArea | undefined =>
  typeof chrome !== 'undefined' ? (chrome.storage?.session as unknown as SessionArea | undefined) : undefined;

export const readHandoff = async (a: SessionArea | undefined = area()): Promise<HandoffSession | null> => {
  const v = (await a?.get(HANDOFF_KEY))?.[HANDOFF_KEY];
  return v && typeof v === 'object' ? (v as HandoffSession) : null;
};

export const clearHandoff = async (a: SessionArea | undefined = area()) => {
  await a?.remove(HANDOFF_KEY);
};

/** Erase a request (and any parked words) that is past its time. Called on a timer, at start-up and when the popup opens. */
export const sweepExpiredHandoff = async (a: SessionArea | undefined = area(), now = Date.now()) => {
  const s = await readHandoff(a);
  if (s && !(s.exp > now)) await clearHandoff(a);
};

export const HANDOFF_ALARM = 'bwx-handoff-expire';

/** Popup: start a new request (replacing any old one) and return the URL to open. */
export const startHandoff = async (a: SessionArea | undefined = area()): Promise<string> => {
  if (!a) throw new Error('This browser cannot keep a one-time request.');
  const s = newHandoffSession();
  await a.set({ [HANDOFF_KEY]: s });
  return handoffUrl(s.nonce);
};

/**
 * Background: a message from a web page (chrome.runtime.onMessageExternal). Returns true only when the request was
 * filled. Never throws, never logs the message.
 */
export const handleExternalHandoff = async (
  message: unknown,
  senderOrigin: unknown,
  a: SessionArea | undefined = area(),
  now = Date.now(),
  enabled = HANDOFF_ENABLED,
): Promise<boolean> => {
  if (!enabled || !a) return false;
  try {
    const r = receiveHandoff(await readHandoff(a), senderOrigin, message, now);
    if (!r.ok) return false;
    await a.set({ [HANDOFF_KEY]: r.session });
    try {
      // The parked words must not wait for someone to come back and type a code.
      chrome.alarms?.create(HANDOFF_ALARM, { when: Math.max(r.session.exp, now + 1000) });
    } catch {
      /* the popup and start-up sweeps still clear it */
    }
    return true;
  } catch {
    return false;
  }
};

/** Popup: check the typed code. The stored request is erased after any attempt that guessed (or succeeded). */
export const confirmTypedCode = async (
  typed: string,
  a: SessionArea | undefined = area(),
  now = Date.now(),
): Promise<ConfirmResult> => {
  const r = await confirmHandoff(await readHandoff(a), typed, now);
  if (r.burn) await clearHandoff(a);
  return r.ok ? { ok: true, words: r.words, name: r.name } : { ok: false, reason: r.reason };
};

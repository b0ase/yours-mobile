/**
 * bWallet side of phone pairing (tokenblaster.lol docs/wallet-connect.md §4).
 *
 * A desktop site shows a QR; bWallet scans it, joins the relay channel, checks the relay's
 * verifiedOrigin against the QR, shows the origin and a 4-digit code, and on Connect relays the
 * site's BRC-100 calls into the same approval path the in-app browser uses (handleSiteCall), with
 * originator fixed to the verified origin for the life of the session.
 */
import { PrivateKey } from '@bsv/sdk';
import {
  Sealer,
  deriveSession,
  isSealed,
  parsePairUrl,
  relaySocketUrl,
  type HelloFrame,
  type PairLink,
  type PairMessage,
  type RelayFrame,
} from '../../pair/protocol';
import { handleSiteCall } from '../dappBrowser';
import { appNameFor } from '../storeBuild';
import type { OneSatContext } from '@1sat/actions';
import { fetchExchangeRate } from '../../utils/wallet';
import { AgentCallError, CLI_ORIGIN, handleAgentCall, type AgentGrant } from './agentPairing';

/** What paired-CLI calls need from the app; TopNav keeps it current (wallet context + open account). */
let agentDeps: { ctx: OneSatContext | undefined; currentId: string | undefined } = { ctx: undefined, currentId: undefined };
export const setAgentPairDeps = (d: typeof agentDeps) => {
  agentDeps = d;
};
let rateCache = { at: 0, rate: 0 };
const bsvUsd = async () => {
  if (Date.now() - rateCache.at > 60_000 || !rateCache.rate) rateCache = { at: Date.now(), rate: await fetchExchangeRate('main').catch(() => rateCache.rate) };
  return rateCache.rate;
};

const KEY = 'bwallet.pair.sessions';
const IDLE_MS = 24 * 60 * 60 * 1000;

export type StoredSession = {
  c: string;
  r: string;
  origin: string;
  sitePub: string;
  phoneKey: string; // pairing key only (hex); not a wallet key
  sent: number;
  lastSeen: number;
  createdAt: number;
  lastUsed: number;
  /** Set for a bWalletX CLI / MCP pairing (origin CLI_ORIGIN): the agent account, scopes and expiry. */
  agent?: AgentGrant;
};

/** What the UI shows while a scan is being confirmed. A CLI pairing passes its grant to confirm. */
export type PendingPair = { origin: string; code: string; cli: boolean; confirm: (agent?: AgentGrant) => void; cancel: () => void };

type Listener = () => void;
const listeners = new Set<Listener>();
const emit = () => listeners.forEach((l) => l());
export const subscribePairs = (l: Listener) => (listeners.add(l), () => void listeners.delete(l));

const load = (): StoredSession[] => {
  try {
    const all = JSON.parse(localStorage.getItem(KEY) ?? '[]') as StoredSession[];
    return all.filter((s) => (s.agent ? Date.now() < s.agent.expiresAt : Date.now() - s.lastUsed < IDLE_MS));
  } catch {
    return [];
  }
};
const save = (all: StoredSession[]) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* storage blocked: sessions last until the app closes */
  }
  emit();
};
export const pairedSites = () => load();

type Live = { ws: WebSocket; sealer: Sealer; stored: StoredSession; retry?: ReturnType<typeof setTimeout> };
const live = new Map<string, Live>();

const update = (c: string, patch: Partial<StoredSession>) =>
  save(load().map((s) => (s.c === c ? { ...s, ...patch } : s)));

async function reply(l: Live, msg: PairMessage) {
  if (l.ws.readyState !== WebSocket.OPEN) return;
  l.ws.send(JSON.stringify(await l.sealer.seal(msg)));
  update(l.stored.c, { ...l.sealer.counters });
}

async function onAgentRequest(l: Live, grant: AgentGrant, id: string, action: string, params: unknown) {
  try {
    if (!agentDeps.ctx) throw new AgentCallError('LOCKED', 'bWalletX is locked. Unlock it on your phone.');
    const result = await handleAgentCall(grant, action, params, { ctx: agentDeps.ctx, currentId: agentDeps.currentId, bsvUsd });
    await reply(l, { t: 'res', id, result });
  } catch (e) {
    const code = e instanceof AgentCallError ? e.code : 'ERROR';
    await reply(l, { t: 'res', id, error: { code, message: e instanceof Error ? e.message : String(e) } });
  }
}

async function onRequest(l: Live, id: string, action: string, params: unknown) {
  if (l.stored.agent) return onAgentRequest(l, l.stored.agent, id, action, params);
  try {
    const r = (await handleSiteCall(l.stored.origin, l.stored.origin + '/', action, params)) as {
      success?: boolean;
      data?: unknown;
      error?: string;
    };
    if (r?.success) await reply(l, { t: 'res', id, result: r.data });
    else await reply(l, { t: 'res', id, error: { code: 'REJECTED', message: r?.error || 'Request refused' } });
  } catch (e) {
    await reply(l, { t: 'res', id, error: { code: 'ERROR', message: e instanceof Error ? e.message : String(e) } });
  }
}

/** Wire a confirmed session's socket: requests in, replies out, reconnect when it drops. */
function attach(l: Live) {
  const { ws, sealer, stored } = l;
  live.set(stored.c, l);
  ws.onmessage = async (ev) => {
    const f = JSON.parse(String(ev.data)) as RelayFrame | unknown;
    if ((f as RelayFrame).t === 'relay') {
      const v = (f as RelayFrame).verifiedOrigin;
      if (v && v !== stored.origin) forget(stored.c, false); // the channel changed hands: refuse
      return;
    }
    if (!isSealed(f)) return;
    const msg = await sealer.open(f);
    if (!msg) return;
    update(stored.c, { ...sealer.counters, lastUsed: Date.now() });
    if (msg.t === 'req') void onRequest(l, msg.id, msg.action, msg.params);
    else if (msg.t === 'ping') void reply(l, { t: 'ping' });
    else if (msg.t === 'close') forget(stored.c, false);
  };
  ws.onerror = null;
  ws.onclose = () => {
    if (live.get(stored.c) !== l) return;
    live.delete(stored.c);
    // Still paired: try again (the relay holds frames for 60 s while we're away).
    if (load().some((s) => s.c === stored.c) && document.visibilityState === 'visible')
      l.retry = setTimeout(() => connect(stored.c), 3000);
  };
}

/** Reopen the relay socket for a stored session. */
function connect(c: string) {
  const old = live.get(c);
  if (old && old.ws.readyState <= WebSocket.OPEN) return;
  const stored = load().find((s) => s.c === c);
  if (!stored) return;
  void (async () => {
    const { key } = await deriveSession(PrivateKey.fromHex(stored.phoneKey), stored.sitePub, stored.c);
    const sealer = new Sealer(key, 'wallet');
    sealer.restore({ sent: stored.sent, lastSeen: stored.lastSeen });
    attach({ ws: new WebSocket(relaySocketUrl(stored.r, stored.c, 'wallet')), sealer, stored });
  })();
}

/** Disconnect a site: tell it, then forget the key. */
export function forget(c: string, notify = true) {
  const l = live.get(c);
  if (l) {
    if (l.retry) clearTimeout(l.retry);
    live.delete(c);
    const done = () => l.ws.close();
    if (notify) void reply(l, { t: 'close', reason: 'user unpaired' }).finally(done);
    else done();
  }
  save(load().filter((s) => s.c !== c));
}

/**
 * Start pairing from a scanned QR. Resolves with what the confirm screen needs; the session is
 * stored only when the user taps Connect.
 */
export function beginPairing(scanned: string): Promise<PendingPair> {
  let link: PairLink;
  try {
    link = parsePairUrl(scanned);
  } catch (e) {
    return Promise.reject(e);
  }
  const P = PrivateKey.fromRandom();
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(relaySocketUrl(link.r, link.c, 'wallet'));
    let settled = false;
    const fail = (m: string) => {
      if (settled) return;
      settled = true;
      ws.close();
      reject(new Error(m));
    };
    const timer = setTimeout(() => fail('The site did not answer. Make sure its QR code is still showing.'), 15_000);
    ws.onerror = () => fail('Could not reach the pairing service. Check your connection and try again.');
    ws.onclose = (ev) =>
      !settled && fail(ev.code === 1006 ? 'This code has expired or was already used.' : 'Pairing closed.');
    ws.onmessage = async (ev) => {
      const f = JSON.parse(String(ev.data)) as RelayFrame;
      if (f.t !== 'relay' || !f.verifiedOrigin || settled) return;
      clearTimeout(timer);
      // §4.4: trust the relay's view of the site's origin, never the QR alone.
      if (f.verifiedOrigin !== link.o)
        return fail(`This code was shown by ${f.verifiedOrigin}, not ${link.o}. Don't connect.`);
      const hello: HelloFrame = {
        t: 'hello',
        k: P.toPublicKey().toString(),
        info: { name: appNameFor(), rdns: 'space.bwallet.mobile' },
      };
      ws.send(JSON.stringify(hello));
      const { key, code } = await deriveSession(P, link.k, link.c);
      settled = true;
      ws.onclose = null;
      ws.onerror = null;
      resolve({
        origin: f.verifiedOrigin,
        code,
        cli: f.verifiedOrigin === CLI_ORIGIN,
        confirm: (agent?: AgentGrant) => {
          if (f.verifiedOrigin === CLI_ORIGIN && !agent) return ws.close(); // a CLI must be bound to an agent account
          const stored: StoredSession = {
            c: link.c,
            r: link.r,
            origin: f.verifiedOrigin!,
            sitePub: link.k,
            phoneKey: P.toHex(),
            sent: 0,
            lastSeen: 0,
            createdAt: Date.now(),
            lastUsed: Date.now(),
            ...(agent && { agent }),
          };
          save([...load().filter((s) => s.c !== link.c), stored]);
          const l: Live = { ws, sealer: new Sealer(key, 'wallet'), stored };
          attach(l);
          void reply(l, { t: 'ready' });
        },
        cancel: () => ws.close(),
      });
    };
  });
}

let started = false;
/** Reconnect every paired site; again whenever the app comes back to the foreground. */
export function initPairing() {
  if (started) return;
  started = true;
  for (const s of load()) connect(s.c);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') for (const s of load()) connect(s.c);
  });
}

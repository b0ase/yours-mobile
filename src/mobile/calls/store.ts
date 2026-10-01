import type { OneSatContext } from '@1sat/actions';
import { isNative } from '../native';
import { defaultHttp } from '../chat/api';
import { CallsClient, walletCallSigner, type BlockEntry } from './api';
import { CallMedia } from './media';
import { verifyCaller } from './peer';
import { busy, IDLE, reduce, type CallEvent, type CallState, type Peer, type ServerCall } from './machine';

/**
 * App-wide call controller (module singleton, like media/player.ts). The CallScreen overlay
 * mounted in App (vite.config.mobile.ts) starts it with the wallet context; CallsList and
 * TopNav read it.
 *
 * Ringing is POLLING while the app is open and visible: GET /wallet-calls every few seconds.
 * There is no push yet — a closed or backgrounded app does not ring (see calls/README note in
 * CallScreen.tsx: APNs/PushKit + CallKit on iOS, FCM + ConnectionService on Android).
 */

const POLL_IDLE_MS = 4000;
const POLL_CALL_MS = 1500;
const f = (u: string, i?: RequestInit) => fetch(u, i);

type Listener = (s: Snapshot) => void;
export interface Snapshot {
  call: CallState;
  recent: ServerCall[];
  ready: boolean;
  error: string | null;
}

let snap: Snapshot = { call: IDLE, recent: [], ready: false, error: null };
const listeners = new Set<Listener>();
let client: CallsClient | null = null;
let ctxRef: OneSatContext | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let media: CallMedia | null = null;
let myLabel: string | undefined;
const seenIncoming = new Set<string>();

const set = (patch: Partial<Snapshot>) => {
  snap = { ...snap, ...patch };
  listeners.forEach((l) => l(snap));
};
const dispatch = (e: CallEvent) => {
  const before = snap.call;
  const after = reduce(before, e);
  if (after !== before) {
    set({ call: after });
    if (busy(before) && !busy(after)) void teardown();
  }
};

export const getSnapshot = () => snap;
export const subscribe = (l: Listener) => {
  listeners.add(l);
  return () => void listeners.delete(l);
};

/** Start (or re-point) the controller at the unlocked wallet. Idempotent. */
export function startCalls(ctx: OneSatContext) {
  if (ctxRef === ctx && client) return;
  if (busy(snap.call)) void hangUp();
  ctxRef = ctx;
  client = new CallsClient(defaultHttp(isNative), walletCallSigner(ctx));
  schedule(0);
}

/** The name this wallet announces when it calls (shown to the callee, who re-verifies it). */
export const setCallLabel = (label: string | undefined) => {
  myLabel = label || undefined;
};

export function stopCalls() {
  if (busy(snap.call)) void hangUp();
  if (timer) clearTimeout(timer);
  timer = null;
  client = null;
  ctxRef = null;
  set({ ready: false });
}

function schedule(ms: number) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => void tick(), ms);
}

async function tick() {
  const c = client;
  if (!c) return;
  const s = snap.call;
  try {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden' && !busy(s)) {
      return; // resumes on visibilitychange
    }
    if (s.phase === 'ringing-out' || s.phase === 'active' || s.phase === 'connecting' || s.phase === 'incoming') {
      const call = await c.get(s.callId);
      dispatch({ type: 'REMOTE', callId: call.id, status: call.status, at: Date.now() });
    } else if (!busy(s)) {
      const { incoming, recent } = await c.list();
      set({ recent, ready: true, error: null });
      const ring = incoming.find((x) => !seenIncoming.has(x.id));
      if (ring) {
        seenIncoming.add(ring.id);
        const peer = await verifyCaller(f, ring.peer_key, ring.peer_label);
        dispatch({ type: 'RING_IN', call: ring, peer });
      }
    }
  } catch (e) {
    set({ error: e instanceof Error ? e.message : String(e) });
  } finally {
    if (client === c) schedule(busy(snap.call) ? POLL_CALL_MS : POLL_IDLE_MS);
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && client) schedule(0);
  });
}

async function joinMedia(callId: string) {
  if (!client) throw new Error('Calls are not ready');
  const t = await client.token(callId);
  media = new CallMedia();
  await media.connect(t.url, t.token, () => {
    if (busy(snap.call)) dispatch({ type: 'FAIL', message: 'Connection lost' });
  });
}

async function teardown() {
  const m = media;
  media = null;
  await m?.close();
  schedule(0);
}

// ── Actions ─────────────────────────────────────────────────────────────────

export async function dial(peer: Peer) {
  if (!client || busy(snap.call)) return;
  dispatch({ type: 'DIAL', peer });
  try {
    const call = await client.place(peer.key, { caller: myLabel, callee: peer.label });
    dispatch({ type: 'PLACED', callId: call.id });
    await joinMedia(call.id);
    schedule(0);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    dispatch({
      type: 'FAIL',
      message: msg,
      reason: /unavailable|too often|too many|not answered/i.test(msg) ? 'unavailable' : 'failed',
    });
  }
}

export async function accept() {
  const s = snap.call;
  if (!client || s.phase !== 'incoming') return;
  dispatch({ type: 'ACCEPT' });
  try {
    await client.act(s.callId, 'accept');
    await joinMedia(s.callId);
    dispatch({ type: 'MEDIA_UP', at: Date.now() });
  } catch (e) {
    void client.act(s.callId, 'end').catch(() => undefined);
    dispatch({ type: 'FAIL', message: e instanceof Error ? e.message : String(e) });
  }
}

export async function decline() {
  const s = snap.call;
  if (!client || s.phase !== 'incoming') return;
  dispatch({ type: 'DECLINE' });
  await client.act(s.callId, 'decline').catch(() => undefined);
}

export async function hangUp() {
  const s = snap.call;
  const id = 'callId' in s ? s.callId : null;
  dispatch({ type: 'HANGUP', at: Date.now() });
  if (client && id) await client.act(id, 'end').catch(() => undefined);
}

export async function toggleMute() {
  dispatch({ type: 'TOGGLE_MUTE' });
  const s = snap.call;
  if (s.phase === 'active') await media?.setMuted(s.muted);
}

export async function toggleSpeaker() {
  dispatch({ type: 'TOGGLE_SPEAKER' });
  const s = snap.call;
  if (s.phase === 'active') await media?.setSpeaker(s.speaker);
}

export const dismiss = () => dispatch({ type: 'DISMISS' });

// ── Block list ──────────────────────────────────────────────────────────────

export async function blockCaller(key: string, label?: string) {
  if (!client) throw new Error('Calls are not ready');
  await client.block(key, label);
  const s = snap.call;
  if (s.phase === 'incoming' && s.peer.key === key) dispatch({ type: 'DECLINE' });
}

export async function unblockCaller(key: string) {
  if (!client) throw new Error('Calls are not ready');
  await client.unblock(key);
}

export async function listBlocked(): Promise<BlockEntry[]> {
  if (!client) return [];
  return client.blocks();
}

export const callsReady = () => client !== null;

/** The signed-in calls client, or null while the wallet is locked. */
export const getCallsClient = () => client;

export class CallsClientError extends Error {}

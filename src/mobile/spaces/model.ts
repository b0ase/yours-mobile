/**
 * bSpaces (docs/BSPACES-PLAN.md): the pure half. Parses bit-sign's rooms/[ticker]/space responses and
 * derives what the screen shows: the stage, the audience, the hand queue, and the moment you are
 * brought on stage. No React, no LiveKit, so it is unit-tested (model.test.ts).
 *
 * The server is the authority on roles: the stage is whatever the participant rows say, and the
 * LiveKit token is minted from your row. Nothing here grants anything.
 */

export type SpaceRole = 'host' | 'speaker' | 'listener';
export type SpaceMode = 'stage' | 'meeting';

export interface Space {
  id: string;
  title: string | null;
  host: string;
  transport: 'mesh' | 'sfu' | string;
  max: number;
  startedAt: string;
  /** 'meeting' once bit-sign has the column (plan Phase 2); 'stage' until then. */
  mode: SpaceMode;
}

export interface Participant {
  handle: string;
  role: SpaceRole;
  handRaisedAt: string | null;
}

export interface SpaceState {
  space: Space | null;
  participants: Participant[];
  me: Participant | null;
}

export interface SpaceToken {
  token: string;
  url: string;
  role: SpaceRole;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);
const norm = (h: string) => h.trim().replace(/^\$/, '').toLowerCase();
const roleOf = (v: unknown): SpaceRole => (v === 'host' || v === 'speaker' ? v : 'listener');

const parseParticipant = (v: unknown): Participant | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const handle = str(o.handle);
  if (!handle) return null;
  return { handle: norm(handle), role: roleOf(o.role), handRaisedAt: str(o.hand_raised_at) };
};

const parseSpace = (v: unknown): Space | null => {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id);
  const host = str(o.host_handle);
  if (!id || !host || o.status === 'ended') return null;
  return {
    id,
    title: str(o.title),
    host: norm(host),
    transport: str(o.transport) ?? 'mesh',
    max: typeof o.max_participants === 'number' ? o.max_participants : 0,
    startedAt: str(o.started_at) ?? '',
    mode: o.mode === 'meeting' ? 'meeting' : 'stage',
  };
};

/** GET / POST join responses → state. Anything malformed reads as "no live space". */
export const parseSpaceState = (data: unknown, me: string): SpaceState => {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const space = parseSpace(o.space);
  if (!space) return { space: null, participants: [], me: null };
  const participants = (Array.isArray(o.participants) ? o.participants : [])
    .map(parseParticipant)
    .filter((p): p is Participant => !!p);
  const mine = norm(me);
  return { space, participants, me: participants.find((p) => p.handle === mine) ?? null };
};

export const parseSpaceToken = (data: unknown): SpaceToken | null => {
  const o = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
  const token = str(o.token);
  const url = str(o.url);
  return token && url ? { token, url, role: roleOf(o.role) } : null;
};

/** The wallet speaks LiveKit only. A 'mesh' space (no SFU on the server) needs bChat on the web. */
export const supportedTransport = (space: Space) => space.transport === 'sfu';

export const isOnStage = (role: SpaceRole | null | undefined) => role === 'host' || role === 'speaker';

/** Host first, then speakers in the server's order. */
export const stageOf = (s: SpaceState): Participant[] => {
  const on = s.participants.filter((p) => isOnStage(p.role));
  return [...on.filter((p) => p.role === 'host'), ...on.filter((p) => p.role !== 'host')];
};

/** Raised hands, oldest first (the server already sorts them first). */
export const handQueue = (s: SpaceState): Participant[] =>
  s.participants
    .filter((p) => p.role === 'listener' && p.handRaisedAt)
    .sort((a, b) => (a.handRaisedAt ?? '').localeCompare(b.handRaisedAt ?? ''));

export const audienceCount = (s: SpaceState) => s.participants.filter((p) => p.role === 'listener').length;

/**
 * What changed for me between two polls.
 * - 'invited': the host brought me on stage. The SFU already lets me publish; the wallet still asks
 *   before opening the mic or camera, and Decline steps down (bit-sign `step_down`).
 * - 'demoted': back to the audience. The SFU has already revoked publishing; switch devices off.
 * - 'ended': the space is over (or I was removed).
 */
export type MyChange = 'invited' | 'demoted' | 'ended' | null;
export const myChange = (prev: SpaceState | null, next: SpaceState): MyChange => {
  if (!prev?.space) return null;
  if (!next.space || next.space.id !== prev.space.id) return 'ended';
  const was = prev.me?.role;
  const now = next.me?.role;
  if (was === 'listener' && now === 'speaker') return 'invited';
  if (was === 'speaker' && now === 'listener') return 'demoted';
  return null;
};

/**
 * May this wallet start a space in this room? Product rule (owner, 8 Oct 2026): the token's issuer
 * or the room's admin. bit-sign lets any member start one; the wallet only offers it to these.
 */
export const canHostRoom = (opts: { me: string; createdBy?: string | null; youAreIssuer?: boolean }) =>
  !!opts.youAreIssuer || (!!opts.createdBy && norm(opts.createdBy) === norm(opts.me));

/** "1 listening", "12 listening". */
export const audienceLine = (n: number) => `${n} listening`;

export const elapsed = (startedAt: string, now = Date.now()): string => {
  const t = Date.parse(startedAt);
  if (!Number.isFinite(t)) return '';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
};

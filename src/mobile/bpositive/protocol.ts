import { Utils, type WalletInterface } from '@bsv/sdk';
import { BCHAT_ORIGIN, type Http } from '../chat/api';

/**
 * bPositive (site /bpositive, bit-sign PR #299): journeys, daily check-ins, pledges and 2-of-3 witnesses.
 *
 * Every write is a payload the wallet signs with its identity key; bit-sign only verifies and records:
 *   createSignature({ data: utf8(canonicalJson(payload)), protocolID: [2,'bpositive'], keyID: '1',
 *   counterparty: 'anyone' }) → DER hex. POST body { payload, identity_key, signature }.
 *
 * Pledges are PROMISES. Nothing here moves, holds or spends money. Witnesses decide milestones and
 * the outcome (2 of 3 sign the same verdict); the app never fails a journey on its own.
 *
 * Pure helpers + an injectable Http client, so it is unit-tested without a network.
 */

export const BPOSITIVE_PROTOCOL: [2, string] = [2, 'bpositive'];
export const BPOSITIVE_KEY_ID = '1';
export const BPOSITIVE_VERSION = 1 as const;
export const BPOSITIVE_API = `${BCHAT_ORIGIN}/api/bitsign/bpositive`;
export const WITNESS_COUNT = 3;
export const WITNESS_QUORUM = 2;
export const MAX_GOAL_DAYS = 3650;
export const TITLE_MAX = 120;
export const NOTE_MAX = 280;

export const JOURNEY_KINDS = ['sober', 'fitness', 'habit', 'other'] as const;
export type JourneyKind = (typeof JOURNEY_KINDS)[number];
export const KIND_LABEL: Record<JourneyKind, string> = {
  sober: 'Sober',
  fitness: 'Fitness',
  habit: 'A habit',
  other: 'Something else',
};

/**
 * Private by default (owner, 16 Oct 2026; bit-sign #299 220f1b8a): only the owner, the three witnesses and pledgers
 * can see a journey; everyone else gets 404. The owner changes it with POST /journeys/{id}/visibility.
 */
export type Visibility = 'private' | 'public';
export const DEFAULT_VISIBILITY: Visibility = 'private';
/** Shown before a journey is made public. */
export const PUBLIC_WARNING =
  'Make this journey public? Anyone with the link will see its title, check-ins and pledges. You can make it private again later, but people may already have seen it.';

export type MilestoneVerdict = 'confirm' | 'reject';
export type OutcomeVerdict = 'success' | 'failure';
export type JourneyStatus = 'active' | 'succeeded' | 'failed';

// ── Canonical JSON ──

/**
 * Sorted keys at every depth, no whitespace, safe integers only, undefined object fields left out.
 * Must be byte-identical to bit-sign's lib/bpositive-rules.ts canonicalJson, or signatures fail.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new Error('canonicalJson: only safe integers are allowed');
    return String(value);
  }
  if (Array.isArray(value)) {
    return `[${value
      .map((v) => {
        if (v === undefined) throw new Error('canonicalJson: undefined in an array');
        return canonicalJson(v);
      })
      .join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`);
}

// ── Payloads ──

export const normHandle = (h: string) =>
  h
    .trim()
    .replace(/^[$@]+/, '')
    .replace(/@.*$/, '')
    .toLowerCase();
const HANDLE_RE = /^[a-z0-9_][a-z0-9_.-]{0,63}$/;
export const isHandle = (h: string) => HANDLE_RE.test(h);

/** 16 random bytes as lowercase hex (32 chars; the server takes 32–64). */
export const newNonce = (rand: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))) =>
  Array.from(rand(16), (b) => b.toString(16).padStart(2, '0')).join('');

interface Common {
  v: 1;
  handle: string;
  ts: number;
  nonce: string;
}
export interface CreatePayload extends Common {
  type: 'bpositive.journey.create';
  kind: JourneyKind;
  title: string;
  goal_days: number;
  start_date: string;
  witnesses: string[];
}
export interface VisibilityPayload extends Common {
  type: 'bpositive.journey.visibility';
  journey_id: string;
  visibility: Visibility;
}
export interface ReadPayload extends Common {
  type: 'bpositive.read';
}
export interface CheckinPayload extends Common {
  type: 'bpositive.checkin';
  journey_id: string;
  day: number;
  note?: string;
}
export interface PledgePayload extends Common {
  type: 'bpositive.pledge';
  journey_id: string;
  amount_sats: number;
  message?: string;
}
export interface WitnessPayload extends Common {
  type: 'bpositive.witness';
  journey_id: string;
  subject: 'milestone' | 'outcome';
  day: number;
  verdict: MilestoneVerdict | OutcomeVerdict;
}
export type AnyPayload =
  | CreatePayload
  | VisibilityPayload
  | ReadPayload
  | CheckinPayload
  | PledgePayload
  | WitnessPayload;

export interface Stamp {
  handle: string;
  ts?: number;
  nonce?: string;
}
const common = (s: Stamp): Common => ({
  v: BPOSITIVE_VERSION,
  handle: normHandle(s.handle),
  ts: s.ts ?? Date.now(),
  nonce: s.nonce ?? newNonce(),
});
const optText = (s: string | undefined, max: number) => {
  const t = (s ?? '').trim();
  if (t.length > max) throw new Error(`Keep it to ${max} characters`);
  return t || undefined;
};

/** Three witnesses: normalised, different, not you, sorted (the server hashes them into the journey id). */
export const cleanWitnesses = (handles: string[], self: string): string[] => {
  const w = [...new Set(handles.map(normHandle).filter(Boolean))];
  if (w.some((h) => !isHandle(h))) throw new Error('A witness needs a bChat handle');
  if (w.includes(normHandle(self))) throw new Error("You can't witness your own journey");
  if (w.length !== WITNESS_COUNT) throw new Error(`Choose ${WITNESS_COUNT} different people`);
  return w.sort();
};

export const buildCreate = (
  s: Stamp,
  f: {
    kind: JourneyKind;
    title: string;
    goalDays: number;
    startDate: string;
    witnesses: string[];
  },
): CreatePayload => {
  const title = f.title.trim();
  if (!title || title.length > TITLE_MAX) throw new Error(`Give it a title (up to ${TITLE_MAX} characters)`);
  if (!Number.isSafeInteger(f.goalDays) || f.goalDays < 1 || f.goalDays > MAX_GOAL_DAYS)
    throw new Error(`Pick a goal between 1 and ${MAX_GOAL_DAYS} days`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.startDate)) throw new Error('Pick a start date');
  if (!JOURNEY_KINDS.includes(f.kind)) throw new Error('Pick a kind of journey');
  return {
    ...common(s),
    type: 'bpositive.journey.create',
    kind: f.kind,
    title,
    goal_days: f.goalDays,
    start_date: f.startDate,
    witnesses: cleanWitnesses(f.witnesses, s.handle),
  };
};

export const buildVisibility = (s: Stamp, journeyId: string, visibility: Visibility): VisibilityPayload => ({
  ...common(s),
  type: 'bpositive.journey.visibility',
  journey_id: journeyId,
  visibility,
});

export const buildRead = (s: Stamp): ReadPayload => ({ ...common(s), type: 'bpositive.read' });

export const buildCheckin = (s: Stamp, journeyId: string, day: number, note?: string): CheckinPayload => ({
  ...common(s),
  type: 'bpositive.checkin',
  journey_id: journeyId,
  day,
  note: optText(note, NOTE_MAX),
});

export const buildPledge = (s: Stamp, journeyId: string, amountSats: number, message?: string): PledgePayload => {
  if (!Number.isSafeInteger(amountSats) || amountSats < 1) throw new Error('Enter a whole number of sats');
  return {
    ...common(s),
    type: 'bpositive.pledge',
    journey_id: journeyId,
    amount_sats: amountSats,
    message: optText(message, NOTE_MAX),
  };
};

export const buildWitness = (
  s: Stamp,
  journeyId: string,
  w: { subject: 'milestone'; day: number; verdict: MilestoneVerdict } | { subject: 'outcome'; verdict: OutcomeVerdict },
): WitnessPayload => ({
  ...common(s),
  type: 'bpositive.witness',
  journey_id: journeyId,
  subject: w.subject,
  // The outcome is day 0 on the server.
  day: w.subject === 'milestone' ? w.day : 0,
  verdict: w.verdict,
});

// ── Signing ──

export type SignWallet = Pick<WalletInterface, 'createSignature' | 'getPublicKey'>;
export interface SignedBody<P extends AnyPayload = AnyPayload> {
  payload: P;
  identity_key: string;
  signature: string;
}

/** The exact bytes the wallet signs (and bit-sign verifies). */
export const signedBytes = (payload: AnyPayload) => Utils.toArray(canonicalJson(payload), 'utf8');

export const signPayload = async <P extends AnyPayload>(wallet: SignWallet, payload: P): Promise<SignedBody<P>> => {
  const [{ publicKey }, { signature }] = await Promise.all([
    wallet.getPublicKey({ identityKey: true }),
    wallet.createSignature({
      data: signedBytes(payload),
      protocolID: BPOSITIVE_PROTOCOL,
      keyID: BPOSITIVE_KEY_ID,
      counterparty: 'anyone',
    }),
  ]);
  return { payload, identity_key: publicKey, signature: Utils.toHex(signature) };
};

// ── Server views (defensive: older rows may lack fields) ──

export interface Journey {
  id: string;
  owner_handle: string;
  kind: JourneyKind;
  title: string;
  goal_days: number;
  start_date: string;
  witnesses: string[];
  status: JourneyStatus;
  visibility?: Visibility;
  created_at?: string;
  decided_at?: string | null;
}
export interface Checkin {
  day: number;
  note?: string | null;
  created_at?: string;
}
export interface Pledge {
  id?: string;
  pledger_handle: string;
  amount_sats: number;
  message?: string | null;
  created_at?: string;
}
export interface Tally {
  counts: Record<string, number>;
  decided: string | null;
  signers: string[];
}
export interface JourneyView {
  journey: Journey;
  checkins: Checkin[];
  pledges: Pledge[];
  pot: { pledged_sats: number; pledges?: number; custody: 'none' };
  witness: {
    quorum: number;
    outcome: Tally;
    milestones: (Tally & { day: number })[];
    signatures: { witness_handle?: string; witness?: string; subject: string; day: number; verdict: string }[];
  };
}

const emptyTally = (): Tally => ({ counts: {}, decided: null, signers: [] });
const asTally = (t: unknown): Tally => {
  const o = (t ?? {}) as Partial<Tally>;
  return {
    counts: o.counts && typeof o.counts === 'object' ? o.counts : {},
    decided: typeof o.decided === 'string' ? o.decided : null,
    signers: Array.isArray(o.signers) ? o.signers.filter((s): s is string => typeof s === 'string') : [],
  };
};

export const parseView = (raw: unknown): JourneyView => {
  const r = (raw ?? {}) as Partial<JourneyView>;
  if (!r.journey || typeof r.journey.id !== 'string') throw new Error('Journey not found');
  const w = (r.witness ?? {}) as Partial<JourneyView['witness']>;
  const pledges = Array.isArray(r.pledges)
    ? r.pledges.map((p) => ({ ...p, amount_sats: Number(p.amount_sats) || 0 }))
    : [];
  return {
    journey: { ...r.journey, witnesses: Array.isArray(r.journey.witnesses) ? r.journey.witnesses : [] },
    checkins: Array.isArray(r.checkins) ? r.checkins : [],
    pledges,
    pot: { pledged_sats: Number(r.pot?.pledged_sats) || 0, pledges: pledges.length, custody: 'none' },
    witness: {
      quorum: Number(w.quorum) || WITNESS_QUORUM,
      outcome: w.outcome ? asTally(w.outcome) : emptyTally(),
      milestones: Array.isArray(w.milestones)
        ? w.milestones.map((m) => ({ ...asTally(m), day: Number(m.day) || 0 }))
        : [],
      signatures: Array.isArray(w.signatures) ? w.signatures : [],
    },
  };
};

// ── Progress (pure; dates are UTC calendar days) ──

const dayMs = 86_400_000;
const utcDay = (iso: string) => Date.parse(`${iso}T00:00:00Z`);
export const todayIso = (now = Date.now()) => new Date(now).toISOString().slice(0, 10);

/** Today's day number on the journey: the start date is day 1. 0 before it starts. Capped at the goal. */
export const currentDay = (j: Pick<Journey, 'start_date' | 'goal_days'>, now = Date.now()) => {
  const start = utcDay(j.start_date);
  if (Number.isNaN(start)) return 0;
  const n = Math.floor((Date.parse(`${todayIso(now)}T00:00:00Z`) - start) / dayMs) + 1;
  return Math.max(0, Math.min(n, j.goal_days));
};

export const checkedDays = (checkins: Checkin[]) => new Set(checkins.map((c) => c.day));

/** Ring fraction: check-ins over the goal, 0..1. Missed days simply don't fill; nothing resets. */
export const progress = (v: Pick<JourneyView, 'journey' | 'checkins'>) =>
  Math.min(1, checkedDays(v.checkins).size / Math.max(1, v.journey.goal_days));

export const canCheckInToday = (v: Pick<JourneyView, 'journey' | 'checkins'>, now = Date.now()) => {
  const d = currentDay(v.journey, now);
  return v.journey.status === 'active' && d >= 1 && !checkedDays(v.checkins).has(d);
};

/** Days a witness can be asked to confirm: days with a check-in that no quorum has settled yet. */
export const openMilestoneDays = (v: JourneyView) => {
  const decided = new Set(v.witness.milestones.filter((m) => m.decided).map((m) => m.day));
  return [...checkedDays(v.checkins)].filter((d) => !decided.has(d)).sort((a, b) => b - a);
};

export const hasSigned = (v: JourneyView, me: string, subject: 'milestone' | 'outcome', day: number) => {
  const h = normHandle(me);
  const t = subject === 'outcome' ? v.witness.outcome : v.witness.milestones.find((m) => m.day === day);
  return !!t?.signers.some((s) => normHandle(s) === h);
};

/** Calm, no-shame wording for the outcome. A closed journey never says "failed". */
export const outcomeText = (v: Pick<JourneyView, 'journey' | 'checkins'>) => {
  const days = checkedDays(v.checkins).size;
  const counted = `${days} ${days === 1 ? 'day' : 'days'} checked in. Every one of them counts.`;
  switch (v.journey.status) {
    case 'succeeded':
      return { title: 'Goal reached, confirmed by your witnesses', body: counted };
    case 'failed':
      return {
        title: 'This journey has closed',
        body: `${counted} You can start a new journey whenever you are ready.`,
      };
    default:
      return { title: 'In progress', body: `${counted} Your witnesses decide the outcome, never a timer.` };
  }
};

export const satsLabel = (n: number) => `${n.toLocaleString('en-GB')} sats`;

// ── API ──

/** base64url of UTF-8 text. */
export const base64url = (text: string) =>
  Utils.toBase64(Utils.toArray(text, 'utf8')).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** Signed-read header (fallback when there is no bChatX session). Each one burns a nonce and counts towards
 *  the 20-a-minute limit, so callers cache reads and refresh on focus or by hand, never by polling. */
export const signedReadHeader = async (wallet: SignWallet, handle: string) => {
  const body = await signPayload(wallet, buildRead({ handle }));
  return { 'x-bpositive-auth': base64url(JSON.stringify(body)) };
};

/** Read auth: the bChatX session (preferred) or a signed read. */
export type ReadAuth = () => Promise<Record<string, string>>;
export const readAuth =
  (session: () => { token: string } | null, wallet: SignWallet | null, handle: () => string | null): ReadAuth =>
  async (): Promise<Record<string, string>> => {
    const s = session();
    if (s?.token) return { Authorization: `Bearer ${s.token}` };
    const h = handle();
    return wallet && h ? signedReadHeader(wallet, h) : {};
  };

export const RATE_LIMITED = 'Lots of activity just now. Please wait a minute and try again.';

export class BpositiveApi {
  constructor(
    private readonly http: Http,
    private readonly auth: ReadAuth = async () => ({}),
    private readonly base = BPOSITIVE_API,
  ) {}

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    let res: { status: number; data: unknown };
    const headers: Record<string, string> = {
      Accept: 'application/json',
      ...(method === 'GET' ? await this.auth() : {}),
    };
    try {
      res = await this.http({ method, url: `${this.base}${path}`, headers, body });
    } catch {
      throw new Error("Couldn't reach bPositive. Check your connection and try again.");
    }
    if (res.status === 429) throw new Error(RATE_LIMITED);
    if (res.status === 404 && method === 'GET' && path.startsWith('/journeys/'))
      throw new Error('This journey is private, or it no longer exists.');
    if (res.status < 200 || res.status >= 300) {
      const msg = (res.data as { error?: unknown } | null)?.error;
      throw new Error(typeof msg === 'string' && msg ? msg : `bPositive is unavailable right now (${res.status}).`);
    }
    return res.data as T;
  }

  list = async (q: { owner?: string; witness?: string }): Promise<Journey[]> => {
    const sp = new URLSearchParams();
    if (q.owner) sp.set('owner', normHandle(q.owner));
    if (q.witness) sp.set('witness', normHandle(q.witness));
    const d = await this.call<{ journeys?: Journey[] }>('GET', `/journeys?${sp}`);
    return Array.isArray(d?.journeys) ? d.journeys : [];
  };
  get = async (id: string) => parseView(await this.call('GET', `/journeys/${encodeURIComponent(id)}`));
  create = (b: SignedBody<CreatePayload>) => this.call<{ id: string; journey: Journey }>('POST', '/journeys', b);
  setVisibility = (b: SignedBody<VisibilityPayload>) =>
    this.call<{ journey?: Journey }>('POST', `/journeys/${encodeURIComponent(b.payload.journey_id)}/visibility`, b);
  checkin = (b: SignedBody<CheckinPayload>) =>
    this.call('POST', `/journeys/${encodeURIComponent(b.payload.journey_id)}/checkins`, b);
  pledge = (b: SignedBody<PledgePayload>) =>
    this.call('POST', `/journeys/${encodeURIComponent(b.payload.journey_id)}/pledges`, b);
  witness = (b: SignedBody<WitnessPayload>) =>
    this.call('POST', `/journeys/${encodeURIComponent(b.payload.journey_id)}/witness`, b);
}

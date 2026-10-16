import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import type { Http } from '../chat/api';
import {
  BPOSITIVE_API,
  BpositiveApi,
  buildCheckin,
  buildCreate,
  buildPledge,
  buildWitness,
  canCheckInToday,
  canonicalJson,
  cleanWitnesses,
  currentDay,
  newNonce,
  openMilestoneDays,
  outcomeText,
  parseView,
  progress,
  signPayload,
  signedBytes,
  buildVisibility,
  readAuth,
  RATE_LIMITED,
  type JourneyView,
} from './protocol';

const stamp = { handle: '$Alice', ts: 1_760_000_000_000, nonce: 'ab'.repeat(16) };
const JID = 'a'.repeat(64);

describe('canonicalJson', () => {
  test('sorts keys at every depth, no whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: true, y: null }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[3,{"y":null,"z":true}]},"b":1}',
    );
  });
  test('omits undefined object fields', () => {
    expect(canonicalJson({ a: undefined, b: 'k' })).toBe('{"b":"k"}');
  });
  test('integers only', () => {
    expect(() => canonicalJson({ a: 1.5 })).toThrow();
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson({ a: 2 ** 60 })).toThrow();
    expect(canonicalJson({ a: -3 })).toBe('{"a":-3}');
  });
  test('refuses undefined in arrays and unsupported types', () => {
    expect(() => canonicalJson([undefined])).toThrow();
    expect(() => canonicalJson({ a: 1n })).toThrow();
  });
  test('escapes strings like JSON', () => {
    expect(canonicalJson({ t: 'a"b\n' })).toBe('{"t":"a\\"b\\n"}');
  });
  test('is independent of key insertion order', () => {
    expect(canonicalJson({ x: 1, y: 2 })).toBe(canonicalJson({ y: 2, x: 1 }));
  });
});

describe('payloads', () => {
  test('create: normalised handle, sorted witnesses, no visibility field (the server refuses unknown fields)', () => {
    const p = buildCreate(stamp, {
      kind: 'sober',
      title: '  90 days  ',
      goalDays: 90,
      startDate: '2026-10-16',
      witnesses: ['$Carol', 'bob', 'dave@bwalletx.com'],
    });
    expect(p).toMatchObject({ v: 1, type: 'bpositive.journey.create', handle: 'alice', title: '90 days' });
    expect(p.witnesses).toEqual(['bob', 'carol', 'dave']);
    expect(canonicalJson(p)).not.toContain('visibility');
    expect(buildVisibility(stamp, JID, 'public')).toMatchObject({
      type: 'bpositive.journey.visibility',
      visibility: 'public',
      journey_id: JID,
    });
  });
  test('witnesses: exactly three, different, never yourself', () => {
    expect(() => cleanWitnesses(['bob', 'carol'], 'alice')).toThrow();
    expect(() => cleanWitnesses(['bob', 'bob', 'carol'], 'alice')).toThrow();
    expect(() => cleanWitnesses(['bob', 'carol', '$alice'], 'alice')).toThrow();
  });
  test('check-in leaves out an empty note', () => {
    const p = buildCheckin(stamp, JID, 3, '   ');
    expect(canonicalJson(p)).not.toContain('note');
  });
  test('pledge needs whole sats', () => {
    expect(() => buildPledge(stamp, JID, 1.5)).toThrow();
    expect(buildPledge(stamp, JID, 1000, 'proud of you').amount_sats).toBe(1000);
  });
  test('outcome is day 0', () => {
    expect(buildWitness(stamp, JID, { subject: 'outcome', verdict: 'success' }).day).toBe(0);
    expect(buildWitness(stamp, JID, { subject: 'milestone', day: 7, verdict: 'confirm' }).day).toBe(7);
  });
  test('nonce is 32 lowercase hex chars', () => {
    expect(newNonce()).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe('signing', () => {
  test('signature verifies over the canonical bytes with [2,bpositive] / 1 / anyone', async () => {
    const key = PrivateKey.fromRandom();
    const wallet = new ProtoWallet(key);
    const payload = buildCheckin(stamp, JID, 1, 'one day');
    const body = await signPayload(wallet, payload);
    expect(body.identity_key).toBe(key.toPublicKey().toString());
    expect(body.signature).toMatch(/^[0-9a-f]+$/);
    // What bit-sign does: ProtoWallet('anyone').verifySignature with the claimed key as counterparty.
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(canonicalJson(payload), 'utf8'),
      signature: Utils.toArray(body.signature, 'hex'),
      protocolID: [2, 'bpositive'],
      keyID: '1',
      counterparty: body.identity_key,
    });
    expect(valid).toBe(true);
  });
  test('a changed payload does not verify', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom());
    const body = await signPayload(wallet, buildPledge(stamp, JID, 500));
    const tampered = { ...body.payload, amount_sats: 5000 };
    await expect(
      new ProtoWallet('anyone').verifySignature({
        data: signedBytes(tampered),
        signature: Utils.toArray(body.signature, 'hex'),
        protocolID: [2, 'bpositive'],
        keyID: '1',
        counterparty: body.identity_key,
      }),
    ).rejects.toThrow();
  });
});

const view = (over: Partial<JourneyView['journey']> = {}, checkins: number[] = []): JourneyView =>
  parseView({
    journey: {
      id: JID,
      owner_handle: 'alice',
      kind: 'sober',
      title: 't',
      goal_days: 30,
      start_date: '2026-10-01',
      witnesses: ['bob', 'carol', 'dave'],
      status: 'active',
      ...over,
    },
    checkins: checkins.map((day) => ({ day })),
    pledges: [{ pledger_handle: 'bob', amount_sats: '1000' }],
    pot: { pledged_sats: 1000, custody: 'none' },
    witness: {
      quorum: 2,
      outcome: { counts: {}, decided: null, signers: [] },
      milestones: [{ day: 1, counts: { confirm: 2 }, decided: 'confirm', signers: ['bob', 'carol'] }],
    },
  });

describe('progress and outcome', () => {
  const now = Date.parse('2026-10-05T12:00:00Z');
  test('day number from the start date, capped at the goal', () => {
    expect(currentDay({ start_date: '2026-10-01', goal_days: 30 }, now)).toBe(5);
    expect(currentDay({ start_date: '2026-10-10', goal_days: 30 }, now)).toBe(0);
    expect(currentDay({ start_date: '2026-01-01', goal_days: 30 }, now)).toBe(30);
  });
  test('ring counts check-ins; missed days never reset it', () => {
    expect(progress(view({}, [1, 2, 4]))).toBeCloseTo(3 / 30);
  });
  test('check in once a day, only while active', () => {
    expect(canCheckInToday(view({}, [1, 2]), now)).toBe(true);
    expect(canCheckInToday(view({}, [5]), now)).toBe(false);
    expect(canCheckInToday(view({ status: 'succeeded' }), now)).toBe(false);
  });
  test('witness inbox shows checked-in days not yet settled', () => {
    expect(openMilestoneDays(view({}, [1, 2, 3]))).toEqual([3, 2]);
  });
  test('a closed journey is never called a failure', () => {
    const t = outcomeText(view({ status: 'failed' }, [1, 2]));
    expect(`${t.title} ${t.body}`.toLowerCase()).not.toContain('fail');
    expect(t.body).toContain('2 days');
  });
  test('pledge amounts parse to numbers; custody is none', () => {
    const v = view();
    expect(v.pledges[0].amount_sats).toBe(1000);
    expect(v.pot.custody).toBe('none');
  });
});

describe('api', () => {
  test('posts the signed body to the journey route and surfaces server errors', async () => {
    const calls: { method: string; url: string; body?: unknown }[] = [];
    const http: Http = async (r) => {
      calls.push(r);
      return r.url.endsWith('/checkins')
        ? { status: 409, data: { error: 'journey is succeeded' } }
        : { status: 200, data: { journeys: [] } };
    };
    const api = new BpositiveApi(http);
    expect(await api.list({ witness: '$Bob' })).toEqual([]);
    expect(calls[0].url).toBe(`${BPOSITIVE_API}/journeys?witness=bob`);
    const body = await signPayload(new ProtoWallet(PrivateKey.fromRandom()), buildCheckin(stamp, JID, 1));
    await expect(api.checkin(body)).rejects.toThrow('journey is succeeded');
    expect(calls[1]).toMatchObject({ method: 'POST', url: `${BPOSITIVE_API}/journeys/${JID}/checkins`, body });
  });
  test('reads use the session, else a signed x-bpositive-auth; 429 is a calm message', async () => {
    expect(
      await readAuth(
        () => ({ token: 't' }),
        null,
        () => 'alice',
      )(),
    ).toEqual({ Authorization: 'Bearer t' });
    const key = PrivateKey.fromRandom();
    const h = await readAuth(
      () => null,
      new ProtoWallet(key),
      () => 'alice',
    )();
    const b64 = h['x-bpositive-auth'].replace(/-/g, '+').replace(/_/g, '/');
    const body = JSON.parse(Utils.toUTF8(Utils.toArray(b64, 'base64')));
    expect(body.payload).toMatchObject({ v: 1, type: 'bpositive.read', handle: 'alice' });
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: signedBytes(body.payload),
      signature: Utils.toArray(body.signature, 'hex'),
      protocolID: [2, 'bpositive'],
      keyID: '1',
      counterparty: body.identity_key,
    });
    expect(valid).toBe(true);
    const api = new BpositiveApi(async () => ({ status: 429, data: null }));
    await expect(api.list({ owner: 'alice' })).rejects.toThrow(RATE_LIMITED);
  });
});

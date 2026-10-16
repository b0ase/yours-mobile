import { describe, expect, test } from 'bun:test';
import {
  INPUTS_SPENT_ERROR,
  describeUnseenHeal,
  healUnseenTokenOutputs,
  isUnseenState,
  keyCandidates,
  repairUnsignableTokenOutputs,
  type BroadcastOutcome,
  type LocalTokenOutput,
  type UnseenHealDeps,
} from './tokenSendHeal';

// SCAM, 16 Oct 2026.
const TOKEN = '8353949b27e8e16025702ce2b5d9b1ac2dad56d725eb2a38761974a857d98804_0';
const MINED = 'a'.repeat(64);
const LOST = 'b'.repeat(64);
const DEAD = 'c'.repeat(64);
const GOOD = 'd'.repeat(64);

type World = {
  local: LocalTokenOutput[];
  states: Record<string, string | undefined>;
  chain: Set<string>;
  stored: Set<string>;
  broadcast: Record<string, BroadcastOutcome>;
  /** Overlay learns a txid's outputs once submitted. */
  learnOnSubmit?: boolean;
};

const make = (w: World) => {
  const calls = { submitted: [] as string[], broadcast: [] as string[], relinquished: [] as string[] };
  const deps: UnseenHealDeps = {
    localOutputs: async () => w.local,
    overlayStatus: async (_t, ops) => new Map(ops.map((o) => [o, w.states[o]])),
    chainBeef: async (txid) => (w.chain.has(txid) ? [1, 2, 3] : null),
    localBeef: async (txid) => (w.stored.has(txid) ? [4, 5, 6] : null),
    broadcast: async (_b, txid) => {
      calls.broadcast.push(txid);
      return w.broadcast[txid] ?? { ok: false, inputsSpent: false, error: 'timeout' };
    },
    submitOverlay: async (beef, tokenId) => {
      expect(tokenId).toBe(TOKEN);
      const txid = beef[0] === 1 ? [...w.chain].find((t) => !calls.submitted.includes(t))! : '';
      calls.submitted.push(txid);
      if (w.learnOnSubmit) for (const o of Object.keys(w.states)) w.states[o] = 'valid';
    },
    relinquish: async (o) => {
      calls.relinquished.push(o);
    },
  };
  return { deps, calls };
};

const out = (txid: string, vout: number, amt = '10000000000000'): LocalTokenOutput => ({
  outpoint: `${txid}.${vout}`,
  tokenId: TOKEN,
  amt,
});

describe('healUnseenTokenOutputs', () => {
  test('mined but unknown: submits it to the overlay, no broadcast', async () => {
    const { deps, calls } = make({
      local: [out(MINED, 1), out(GOOD, 0)],
      states: { [`${MINED}.1`]: 'unknown', [`${GOOD}.0`]: 'valid' },
      chain: new Set([MINED]),
      stored: new Set(),
      broadcast: {},
      learnOnSubmit: true,
    });
    const r = await healUnseenTokenOutputs(deps, { tokenId: TOKEN });
    expect(r.unseen.map((o) => o.outpoint)).toEqual([`${MINED}.1`]);
    expect(r.submitted).toEqual([MINED]);
    expect(calls.broadcast).toEqual([]);
    expect(r.stillUnseen).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test('never reached the chain: rebroadcasts the stored BEEF, then submits', async () => {
    const { deps, calls } = make({
      local: [out(LOST, 1)],
      states: { [`${LOST}.1`]: undefined },
      chain: new Set(),
      stored: new Set([LOST]),
      broadcast: { [LOST]: { ok: true } },
    });
    const r = await healUnseenTokenOutputs(deps, { tokenId: TOKEN.replace('_', '.') });
    expect(r.rebroadcast).toEqual([LOST]);
    expect(calls.broadcast).toEqual([LOST]);
    expect(calls.submitted.length).toBe(1);
    expect(calls.relinquished).toEqual([]);
  });

  test('rebroadcast refused because inputs are spent: relinquishes every output of that tx', async () => {
    const { deps, calls } = make({
      local: [out(DEAD, 0, '5'), out(DEAD, 1, '7')],
      states: {},
      chain: new Set(),
      stored: new Set([DEAD]),
      broadcast: { [DEAD]: { ok: false, inputsSpent: true, error: 'DOUBLE_SPEND_ATTEMPTED' } },
    });
    const r = await healUnseenTokenOutputs(deps);
    expect(calls.relinquished).toEqual([`${DEAD}.0`, `${DEAD}.1`]);
    expect(r.dropped.length).toBe(2);
    expect(r.stillUnseen).toEqual([]);
  });

  test('an inconclusive broadcast keeps the outputs and reports it', async () => {
    const { deps, calls } = make({
      local: [out(DEAD, 0)],
      states: {},
      chain: new Set(),
      stored: new Set([DEAD]),
      broadcast: {},
    });
    const r = await healUnseenTokenOutputs(deps);
    expect(calls.relinquished).toEqual([]);
    expect(r.stillUnseen.length).toBe(1);
    expect(r.errors[0]).toContain('timeout');
  });

  test('not on chain and no stored copy: nothing touched', async () => {
    const { deps, calls } = make({
      local: [out(LOST, 0)],
      states: {},
      chain: new Set(),
      stored: new Set(),
      broadcast: {},
    });
    const r = await healUnseenTokenOutputs(deps);
    expect(calls.broadcast).toEqual([]);
    expect(calls.relinquished).toEqual([]);
    expect(r.errors[0]).toContain('no stored copy');
  });

  test('other tokens are left alone when a token is given', async () => {
    const other: LocalTokenOutput = { outpoint: `${LOST}.0`, tokenId: 'e'.repeat(64) + '_0', amt: '1' };
    const { deps } = make({ local: [other], states: {}, chain: new Set(), stored: new Set([LOST]), broadcast: {} });
    const r = await healUnseenTokenOutputs(deps, { tokenId: TOKEN });
    expect(r.unseen).toEqual([]);
  });
});

describe('helpers', () => {
  test('isUnseenState', () => {
    expect(isUnseenState(undefined)).toBe(true);
    expect(isUnseenState('unknown')).toBe(true);
    expect(isUnseenState('valid')).toBe(false);
    expect(isUnseenState('spent')).toBe(false);
  });
  test('INPUTS_SPENT_ERROR', () => {
    expect(INPUTS_SPENT_ERROR.test('Missing inputs')).toBe(true);
    expect(INPUTS_SPENT_ERROR.test('txn-mempool-conflict')).toBe(true);
    expect(INPUTS_SPENT_ERROR.test('No broadcast verdict: SEEN_IN_ORPHAN_MEMPOOL')).toBe(false);
  });
  test('describeUnseenHeal', () => {
    expect(describeUnseenHeal({ submitted: ['a'], rebroadcast: [], dropped: [], unseen: [] })).toBe(
      'Sent 1 transfer to the indexer',
    );
    expect(describeUnseenHeal({ submitted: [], rebroadcast: [], dropped: [], unseen: [] })).toContain('Nothing to fix');
    expect(describeUnseenHeal({ submitted: [], rebroadcast: [], dropped: [], unseen: [out(LOST, 0)] })).toContain(
      "Couldn't",
    );
  });
});

describe('repairUnsignableTokenOutputs', () => {
  const H_GOOD = '11'.repeat(20);
  const LISTING = `${'f'.repeat(64)}`;
  const ci = (keyID: string, counterparty = 'self') =>
    JSON.stringify({ protocolID: [1, '1sat'], keyID, counterparty, amt: '1' });
  const keyed = (vout: number, customInstructions: string | undefined, hash160: string | null = H_GOOD) => ({
    outpoint: `${MINED}.${vout}`,
    tokenId: TOKEN,
    amt: '1',
    hash160,
    customInstructions,
  });
  const run = async (
    outs: ReturnType<typeof keyed>[],
    signs: (k: { keyID: string; counterparty: string }) => boolean,
  ) => {
    const refiled: { outpoint: string; ci: string }[] = [];
    const relinquished: string[] = [];
    const r = await repairUnsignableTokenOutputs({
      localOutputs: async () => outs,
      derive: async (k) => (signs(k) ? H_GOOD : '22'.repeat(20)),
      refile: async (o, c) => {
        refiled.push({ outpoint: o.outpoint, ci: c });
      },
      relinquish: async (o) => {
        relinquished.push(o);
      },
    });
    return { r, refiled, relinquished };
  };

  test('a record whose key signs is left alone', async () => {
    const { r, refiled, relinquished } = await run(
      [keyed(0, ci('k1'))],
      (k) => k.keyID === 'k1' && k.counterparty === 'self',
    );
    expect(r.checked).toBe(1);
    expect(refiled).toEqual([]);
    expect(relinquished).toEqual([]);
  });

  test('keyID written txid_vout instead of txid.vout is refiled with the key that signs', async () => {
    const wrong = `${TOKEN}-${LISTING}_0`;
    const right = `${TOKEN}-${LISTING}.0`;
    const { r, refiled } = await run([keyed(0, ci(wrong))], (k) => k.keyID === right);
    expect(r.repaired.length).toBe(1);
    expect(JSON.parse(refiled[0].ci).keyID).toBe(right);
    expect(JSON.parse(refiled[0].ci).amt).toBe('1');
  });

  test('no key of the wallet signs it: relinquished, never offered to a send', async () => {
    const { r, relinquished } = await run([keyed(2, ci('nope'))], () => false);
    expect(relinquished).toEqual([`${MINED}.2`]);
    expect(r.dropped.length).toBe(1);
  });

  test('unreadable records and non-P2PKH scripts are skipped, not dropped', async () => {
    const { r, relinquished } = await run(
      [keyed(0, undefined), keyed(1, 'enc:xyz'), keyed(2, ci('a'), null)],
      () => false,
    );
    expect(r.checked).toBe(0);
    expect(relinquished).toEqual([]);
  });

  test('keyCandidates tries the record first, then the slips', () => {
    const c = keyCandidates({ protocolID: [1, '1sat'], keyID: `${TOKEN}-${LISTING}.3`, counterparty: 'self' });
    expect(c[0].keyID.endsWith('.3')).toBe(true);
    expect(c.some((k) => k.keyID.endsWith('_3'))).toBe(true);
    expect(c.some((k) => k.counterparty === 'anyone')).toBe(true);
  });
});

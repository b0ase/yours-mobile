/**
 * P0, 20 Nov 2026: does the seal pass cover a NORMAL bit-sign seal? RB's ROOM7 instrument: two fields ("owner",
 * "company") for the same signer, handle b0asex. The createSignature / createAction below are byte-for-byte what
 * bit-sign origin/main sends (src/lib/bwalletx-seal.ts attempt(), nds-seal-record.ts buildSealRecord /
 * buildSealPayloadV2, seal-inscription.ts sealLockingScriptHex), one prepare, both fields' blocks.
 *
 * And when the pass does NOT cover a spend, it says why (which output, amount or fee fell outside it), so a refusal is
 * never silent again.
 */
import { describe, expect, test } from 'bun:test';
import { Hash, PrivateKey, Utils } from '@bsv/sdk';
import { SEAL_MAX_SATS, SealPasses, canonicalJson, readSealSign, sealActionMismatch } from './sealPass';

const SITE = 'bitsign.network';
const KEY = PrivateKey.fromRandom().toPublicKey().toString();
const sha = (s: string) => Utils.toHex(Hash.sha256(Utils.toArray(s, 'utf8')));
const NONCE = 'z7yovZ_q1w2e3r4t5y6u7i8o';

/** bit-sign buildSealRecord: fields sorted by id (code-unit order), key lowercased, handle trimmed. */
const bitsignRecord = (fieldIds: string[]) => ({
  v: 'bitsign-seal-2',
  doc: sha('ROOM7 original'),
  manifest: sha('ROOM7 manifest'),
  ref: '92d27ccc-5d2e-4c55-9a51-6b1f7f0c1e11',
  fields: fieldIds
    .map((id) => ({ id, party: 'boase', role: id === 'owner' ? 'Owner' : 'Company' }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  svg: sha('<svg viewBox="0 0 1000 250"/>'),
  key: KEY.toLowerCase(),
  handle: 'b0asex',
  ts: '2026-11-20T17:22:20.000Z',
  nonce: NONCE,
});

/** bit-sign seal-inscription.ts sealLockingScriptHex, all three push sizes. */
const sealLockingScriptHex = (payload: Record<string, unknown>) => {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const len = bytes.length;
  const push =
    len < 0x4c
      ? len.toString(16).padStart(2, '0')
      : len <= 0xff
        ? `4c${len.toString(16).padStart(2, '0')}`
        : `4d${(len & 0xff).toString(16).padStart(2, '0')}${((len >> 8) & 0xff).toString(16).padStart(2, '0')}`;
  return '006a' + push + Utils.toHex(Array.from(bytes));
};

/** bit-sign buildSealPayloadV2 (key order as bit-sign writes it). */
const bitsignPayload = (rec: ReturnType<typeof bitsignRecord>) => ({
  protocol: 'b0ase-bitsign',
  version: '2.0',
  type: 'nds_field_seal',
  docHash: sha('ROOM7 composed'),
  origHash: rec.doc,
  recordHash: sha(canonicalJson(rec)),
  svgHash: rec.svg,
  fields: rec.fields.map((f) => f.id).join(','),
  key: rec.key,
  ref: rec.ref,
  ts: rec.ts,
});

/** bwalletx-seal.ts attempt(): the createSignature and createAction args, exactly. */
const bitsignCalls = (fieldIds: string[]) => {
  const rec = bitsignRecord(fieldIds);
  return {
    rec,
    sign: {
      protocolID: [2, 'bitsign seal'],
      keyID: NONCE,
      counterparty: 'anyone',
      data: Array.from(new TextEncoder().encode(canonicalJson(rec))),
    },
    action: {
      description: 'bit-sign: sign and seal a document',
      outputs: [
        {
          satoshis: 0,
          lockingScript: sealLockingScriptHex(bitsignPayload(rec)),
          outputDescription: 'Document seal (OP_RETURN, hashes only)',
        },
      ],
      options: { acceptDelayedBroadcast: false, randomizeOutputs: false },
    },
  };
};

const protoReq = {
  type: 'protocol',
  originator: SITE,
  privileged: false,
  protocolID: [2, 'bitsign seal'],
  counterparty: 'anyone',
};
const spendReq = (satoshis: number) => ({ type: 'spending', originator: SITE, spending: { satoshis } });

/** approve → protocol → signed → beginAction, as background.ts runs them. */
const armedFor = (fieldIds: string[], log?: (line: string) => void) => {
  const calls = bitsignCalls(fieldIds);
  const seal = readSealSign(calls.sign, KEY);
  if (!seal) throw new Error('not read as a seal');
  const passes = new SealPasses(Date.now, log);
  passes.approve(SITE, seal);
  expect(passes.coversProtocol(protoReq, 1)).toBe(true);
  passes.signed(SITE, seal.recordHash);
  return { passes, seal, calls };
};

describe("bit-sign's two-field seal (RB, 20 Nov 2026)", () => {
  test('its createSignature is read as a seal', () => {
    expect(readSealSign(bitsignCalls(['owner', 'company']).sign, KEY)).not.toBeNull();
  });

  test('its createAction is the seal of the record signed', () => {
    const { seal, calls } = armedFor(['owner', 'company']);
    expect(sealActionMismatch(seal, calls.action)).toBeNull();
  });

  for (const fee of [1, 25, 63, 250, SEAL_MAX_SATS]) {
    test(`the pass covers its spend (miner fee ${fee} sats, 0-sat OP_RETURN)`, () => {
      const { passes, calls } = armedFor(['owner', 'company']);
      expect(passes.beginAction(SITE, calls.action)).toBe(true);
      expect(passes.coversSpend(spendReq(fee), 1)).toBe(true);
    });
  }

  test('a one-field seal is covered the same way', () => {
    const { passes, calls } = armedFor(['owner']);
    expect(passes.beginAction(SITE, calls.action)).toBe(true);
    expect(passes.coversSpend(spendReq(40), 1)).toBe(true);
  });
});

describe('a spend the pass does not cover says why', () => {
  test('over the cap: names the amount and the cap', () => {
    const { passes, calls } = armedFor(['owner', 'company']);
    passes.beginAction(SITE, calls.action);
    expect(passes.whyNotSpend(spendReq(SEAL_MAX_SATS + 1), 1)).toContain(`${SEAL_MAX_SATS + 1} sats`);
    expect(passes.whyNotSpend(spendReq(SEAL_MAX_SATS + 1), 1)).toContain(`${SEAL_MAX_SATS}`);
  });

  test('two payments in flight', () => {
    const { passes, calls } = armedFor(['owner', 'company']);
    passes.beginAction(SITE, calls.action);
    expect(passes.whyNotSpend(spendReq(30), 2)).toContain('2 payments');
  });

  test('no pass, or one not yet paying', () => {
    expect(new SealPasses().whyNotSpend(spendReq(30), 1)).toContain('no seal pass');
    const { passes } = armedFor(['owner', 'company']);
    expect(passes.whyNotSpend(spendReq(30), 1)).toContain('signed');
  });

  test('already used', () => {
    const { passes, calls } = armedFor(['owner', 'company']);
    passes.beginAction(SITE, calls.action);
    expect(passes.coversSpend(spendReq(30), 1)).toBe(true);
    expect(passes.whyNotSpend(spendReq(30), 1)).toContain('already');
  });

  test('a different action names the check it failed', () => {
    const { seal, calls } = armedFor(['owner', 'company']);
    const twoOutputs = { ...calls.action, outputs: [...calls.action.outputs, calls.action.outputs[0]] };
    expect(sealActionMismatch(seal, twoOutputs)).toContain('2 outputs');
    const paid = { ...calls.action, outputs: [{ ...calls.action.outputs[0], satoshis: 1 }] };
    expect(sealActionMismatch(seal, paid)).toContain('1 sats');
    const withInputs = { ...calls.action, inputs: [] };
    expect(sealActionMismatch(seal, withInputs)).toContain('inputs');
    const rec = bitsignRecord(['owner', 'company']);
    const reordered = { ...bitsignPayload(rec), fields: 'owner,company' };
    const wrongFields = {
      ...calls.action,
      outputs: [{ ...calls.action.outputs[0], lockingScript: sealLockingScriptHex(reordered) }],
    };
    expect(sealActionMismatch(seal, wrongFields)).toContain('fields');
    expect(sealActionMismatch(seal, bitsignCalls(['owner']).action)).toContain('recordHash');
  });

  test('every miss is logged as one [bwx-seal] line with the reason', () => {
    const lines: string[] = [];
    const { passes, calls } = armedFor(['owner', 'company'], (l) => lines.push(l));
    passes.beginAction(SITE, calls.action);
    expect(passes.coversSpend(spendReq(SEAL_MAX_SATS + 5), 1)).toBe(false);
    expect(lines.some((l) => l.startsWith('[bwx-seal]') && l.includes(`${SEAL_MAX_SATS + 5} sats`))).toBe(true);

    const lines2: string[] = [];
    const b = armedFor(['owner', 'company'], (l) => lines2.push(l));
    expect(b.passes.beginAction(SITE, { ...b.calls.action, labels: ['x'] })).toBe(false);
    expect(lines2.some((l) => l.startsWith('[bwx-seal]') && l.includes('labels'))).toBe(true);
  });
});

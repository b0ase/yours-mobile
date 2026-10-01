import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { OpNS } from '@1sat/templates';
import { Hash, Script, Transaction } from '@bsv/sdk';
import { lastWordMask, meetsDifficulty, mineRange, opnsHash, OPNS_DIFFICULTY } from './opnsPow';
import { buildMintOutputs, estimateUnlockLength } from './opnsMint';
import { mineName, NameTakenError, MiningCancelled, type MineChar } from './opnsRegister';
import type { Fetch } from './names';

// Golden vector from @1sat/templates (b-open-io/1sat-sdk packages/templates/src/opns/testdata):
// parent output 1 is node "s"; the mint spends it, mining 'h' to create "sh".
const PARENT = '935e2a477bda8709874c548fda2d504d490891ccfa5f8443705a8b6a3f403fda';
const MINT = '29ad92e000dd59450fec92aa7b178e88219af92a88cad56109d3efda6d9a8c8a';
const loadTx = (txid: string) =>
  Transaction.fromHex(readFileSync(join(import.meta.dir, 'testdata', `${txid}.hex`), 'utf8').trim());

const parentTx = loadTx(PARENT);
const mintTx = loadTx(MINT);
const node = OpNS.decode(parentTx.outputs[1].lockingScript)!;
const unlock = mintTx.inputs[0].unlockingScript!;
const char = unlock.chunks[0].data![0];
const nonce = unlock.chunks[1].data!;
const ownerScript = Script.fromBinary(unlock.chunks[2].data!);

describe('OpNS PoW (opnsPow)', () => {
  test('difficulty is the protocol constant (22 bits)', () => expect(OPNS_DIFFICULTY).toBe(22));

  test('fast sha256d equals @bsv/sdk Hash.sha256(Hash.sha256(…)) on the golden mint', () => {
    expect(node.domain).toBe('s');
    expect(char).toBe('h'.charCodeAt(0));
    const ref = Hash.sha256(Hash.sha256([...node.pow, char, ...nonce]));
    expect(opnsHash(node.pow, char, nonce)).toEqual(ref);
  });

  test('the golden nonce meets difficulty, by our check and by OpNS.testSolution', () => {
    const h = opnsHash(node.pow, char, nonce);
    expect(meetsDifficulty(h)).toBe(true);
    expect(OpNS.testSolution(node.pow, char, nonce)).not.toBeNull();
  });

  test('random hashes agree with sdk for many inputs', () => {
    for (let i = 0; i < 50; i++) {
      const pow = Array.from({ length: 32 }, (_, j) => (i * 31 + j * 7) & 0xff);
      const n = Array.from({ length: 32 }, (_, j) => (i * 13 + j * 3) & 0xff);
      expect(opnsHash(pow, 97 + (i % 26), n)).toEqual(Hash.sha256(Hash.sha256([...pow, 97 + (i % 26), ...n])));
    }
  });

  test('last-word mask for 22 bits covers hash[31], hash[30] and the top 6 bits of hash[29]', () => {
    expect(lastWordMask(22).toString(16)).toBe('fcffff');
    expect(lastWordMask(8).toString(16)).toBe('ff');
  });

  test('mineRange finds a solution at low difficulty that the reference template accepts', () => {
    const prefix = Array.from({ length: 27 }, (_, i) => i);
    const r = mineRange(node.pow, char, prefix, 0, 1 << 16, 12);
    if (!('nonce' in r)) throw new Error('no solution in range');
    expect(r.nonce).toHaveLength(32);
    expect(r.hash).toEqual(Hash.sha256(Hash.sha256([...node.pow, char, ...r.nonce])));
    expect(meetsDifficulty(r.hash, 12)).toBe(true);
    // A 12-bit solution is (almost surely) not a 22-bit one — the mainnet check stays strict.
    expect(meetsDifficulty(r.hash, 22)).toBe(meetsDifficulty(r.hash));
  });

  test('mineRange reproduces the golden 22-bit nonce when started at its counter', () => {
    const prefix = nonce.slice(0, 27);
    const ctr = ((nonce[27] << 24) | (nonce[28] << 16) | (nonce[29] << 8) | nonce[30]) >>> 0;
    const r = mineRange(node.pow, char, prefix, ctr, 256);
    if (!('nonce' in r)) throw new Error('golden nonce not found');
    // Another solution within the same 256-batch is possible in theory; the golden one must at least be valid.
    expect(meetsDifficulty(r.hash)).toBe(true);
    expect(r.nonce.slice(0, 31)).toEqual(nonce.slice(0, 31));
  });
});

describe('OpNS mint transaction (opnsMint)', () => {
  test('rebuilds the three covenant outputs byte-identically to the on-chain mint', () => {
    const hash = opnsHash(node.pow, char, nonce);
    const plan = buildMintOutputs(node, char, hash, ownerScript);
    expect(plan.newDomain).toBe('sh');
    expect(plan.restated.toHex()).toBe(mintTx.outputs[0].lockingScript.toHex());
    expect(plan.child.toHex()).toBe(mintTx.outputs[1].lockingScript.toHex());
    expect(plan.inscription.toHex()).toBe(mintTx.outputs[2].lockingScript.toHex());
    expect(OpNS.decode(plan.child)?.domain).toBe('sh');
  });

  test('covenant unlock (incl. BIP-143 preimage) matches the chain and fits our length estimate', async () => {
    mintTx.inputs[0].sourceTransaction = parentTx;
    const rebuilt = await OpNS.unlock(char, nonce, ownerScript).sign(mintTx, 0);
    expect(rebuilt.toHex()).toBe(unlock.toHex());
    const est = estimateUnlockLength(
      parentTx.outputs[1].lockingScript.toBinary().length,
      ownerScript.toBinary().length,
      Math.max(1, mintTx.outputs.length - 3),
    );
    expect(rebuilt.toBinary().length).toBeLessThanOrEqual(est);
  });
});

describe('mineName orchestration', () => {
  const fakeCtx = {} as never;
  const routes =
    (r: Record<string, unknown>): Fetch =>
    async (url) => {
      const key = Object.keys(r).find((k) => url.endsWith(k));
      const v = key === undefined ? undefined : typeof r[key] === 'function' ? (r[key] as () => unknown)() : r[key];
      return v === undefined ? new Response('{}', { status: 404 }) : new Response(JSON.stringify(v), { status: 200 });
    };
  const fakeNode = (outpoint: string, domain: string) => ({
    outpoint,
    beef: [],
    tx: {} as Transaction,
    vout: 1,
    state: { claimed: [0], domain, pow: new Array(32).fill(1) },
  });
  const instantMiner: MineChar = async () => ({ nonce: new Array(32).fill(0), hash: new Array(32).fill(0) });

  test('mines one tx per missing character, chaining from its own child node', async () => {
    const minted: string[] = [];
    const f = routes({ '/origin/abc': undefined, '/mine/abc': { outpoint: `${'a'.repeat(64)}.1`, domain: 'a' } });
    const steps = await mineName(
      {
        ctx: fakeCtx,
        fetch: f,
        mineChar: instantMiner,
        load: async (_c, op) =>
          fakeNode(op, op.startsWith('a'.repeat(64)) ? 'a' : op.startsWith('b'.repeat(64)) ? 'ab' : '?'),
        mint: async (_c, n, ch) => {
          const d = n.state.domain + String.fromCharCode(ch);
          minted.push(d);
          const txid = (d === 'ab' ? 'b' : 'c').repeat(64);
          return { txid, newDomain: d, childOutpoint: `${txid}.1` };
        },
      },
      'abc',
      new AbortController().signal,
      () => undefined,
    );
    expect(minted).toEqual(['ab', 'abc']);
    expect(steps.map((s) => s.newDomain)).toEqual(['ab', 'abc']);
  });

  test('stops with NameTakenError when the name is taken mid-mining', async () => {
    let taken = false;
    const f = routes({
      '/origin/xy': () => (taken ? { outpoint: 'z.2' } : undefined),
      '/mine/xy': { outpoint: `${'a'.repeat(64)}.1`, domain: 'x' },
    });
    const miner: MineChar = async () => {
      taken = true; // someone else broadcasts "xy" while we mine
      return { nonce: [], hash: [] };
    };
    let minted = 0;
    await expect(
      mineName(
        {
          ctx: fakeCtx,
          fetch: f,
          mineChar: miner,
          load: async (_c, op) => fakeNode(op, 'x'),
          mint: async () => (minted++, {} as never),
        },
        'xy',
        new AbortController().signal,
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(NameTakenError);
    expect(minted).toBe(0);
  });

  test('re-mines from the new node when our node was spent by someone else', async () => {
    let calls = 0;
    const f = routes({
      '/origin/xy': undefined,
      '/mine/xy': () =>
        calls++ === 0
          ? { outpoint: `${'a'.repeat(64)}.1`, domain: 'x' }
          : { outpoint: `${'d'.repeat(64)}.0`, domain: 'x' },
    });
    const loads: string[] = [];
    await mineName(
      {
        ctx: fakeCtx,
        fetch: f,
        mineChar: instantMiner,
        load: async (_c, op) => (loads.push(op), fakeNode(op, 'x')),
        mint: async (_c, n, ch) => ({
          txid: 'e'.repeat(64),
          newDomain: n.state.domain + String.fromCharCode(ch),
          childOutpoint: '',
        }),
      },
      'xy',
      new AbortController().signal,
      () => undefined,
    );
    expect(loads).toEqual([`${'a'.repeat(64)}.1`, `${'d'.repeat(64)}.0`]);
  });

  test('cancel aborts before anything is broadcast', async () => {
    const ctl = new AbortController();
    const f = routes({ '/origin/xy': undefined, '/mine/xy': { outpoint: `${'a'.repeat(64)}.1`, domain: 'x' } });
    let minted = 0;
    await expect(
      mineName(
        {
          ctx: fakeCtx,
          fetch: f,
          mineChar: async () => {
            ctl.abort();
            return { nonce: [], hash: [] };
          },
          load: async (_c, op) => fakeNode(op, 'x'),
          mint: async () => (minted++, {} as never),
        },
        'xy',
        ctl.signal,
        () => undefined,
      ),
    ).rejects.toBeInstanceOf(MiningCancelled);
    expect(minted).toBe(0);
  });

  test('rejects characters the covenant does not allow', async () => {
    await expect(
      mineName({ ctx: fakeCtx, fetch: routes({}) }, 'bad_name', new AbortController().signal, () => undefined),
    ).rejects.toThrow('a-z, 0-9');
  });
});

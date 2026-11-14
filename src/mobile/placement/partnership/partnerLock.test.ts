import { describe, expect, test } from 'bun:test';
import {
  BigNumber,
  ECDSA,
  Hash,
  LockingScript,
  OP,
  P2PKH,
  PrivateKey,
  Script,
  Spend,
  Transaction,
  UnlockingScript,
  Utils,
} from '@bsv/sdk';
import { BSV21 } from '@1sat/templates';
import {
  AWAITING_OWNER,
  MULTI_LOSER,
  RULE_WARNING,
  checkPlan,
  addSignatures,
  agreedKeyset,
  agreedKeysetCheck,
  holdingsFromRecord,
  defaultRule,
  describeProposalMoves,
  proposalMoveProblem,
  exportProposal,
  feeFor,
  finalize,
  findMyHoldings,
  importProposal,
  inputsFor,
  isPartnerLocked,
  isReady,
  keysetFor,
  parsePartnerLock,
  partnerLockScript,
  partnershipLabel,
  planKeysetProblem,
  propose,
  proposalTx,
  sighash,
  signedBy,
  toChecksig,
  waitingOn,
  type Keyset,
  type MovePlan,
} from './partnerLock';
import { buildListingScript } from '../../sell/sell';
import { broadcastProposal, inputsOnChainProblem, proposeMove, signProposal, type ChainCheck } from './actions';
import type { OneSatContext } from '@1sat/actions';

const TOKEN = 'a'.repeat(64) + '_0';
const ann = PrivateKey.fromRandom();
const ben = PrivateKey.fromRandom();
const cat = PrivateKey.fromRandom();
const max = PrivateKey.fromRandom();
const stranger = PrivateKey.fromRandom();
const feeKey = PrivateKey.fromRandom();
const pub = (k: PrivateKey) => k.toPublicKey().toString();

// A partner's wallet signs with createSignature({hashToDirectlySign}); this is the same maths with a local key.
const signDigest = (k: PrivateKey, digest: number[]) =>
  toChecksig(ECDSA.sign(new BigNumber(digest), k, true).toDER() as number[]);
const signAs = (k: PrivateKey, tx: Transaction, inputs: number[]) =>
  Object.fromEntries(inputs.map((i) => [i, toHex(signDigest(k, sighash(tx, i)))]));
const toHex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');

let n = 0;
function locked(keyset: Keyset, holder: PrivateKey, amt: bigint) {
  const src = new Transaction();
  src.addInput({
    sourceTXID: (n++).toString(16).padStart(64, '0'),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(ann.toAddress()),
    sequence: 0xffffffff,
  });
  src.addOutput({
    lockingScript: partnerLockScript({ tokenId: TOKEN, amt, holder: pub(holder) }, keyset),
    satoshis: 1,
  });
  return { sourceTx: src, vout: 0 };
}
function feeUtxo(sats: number) {
  const src = new Transaction();
  src.addInput({
    sourceTXID: (n++).toString(16).padStart(64, '0'),
    sourceOutputIndex: 0,
    unlockingScript: new P2PKH().lock(ann.toAddress()),
    sequence: 0xffffffff,
  });
  src.addOutput({ lockingScript: new P2PKH().lock(feeKey.toAddress()), satoshis: sats });
  return { sourceTx: src, vout: 0, pubKey: pub(feeKey) };
}
const signFee = async (d: number[]) => signDigest(feeKey, d);

function plan(keyset: Keyset, over: Partial<MovePlan> = {}): MovePlan {
  return {
    partnershipId: 'room-1',
    agreementVersion: 1,
    proposalId: 'p-1',
    kind: 'transfer',
    summary: 'Send 1,000 shares from $ann to $ben',
    inputs: over.inputs ?? [locked(keyset, ann, 3000n)],
    outputs: [
      { tokenId: TOKEN, amt: 1000n, holder: pub(ben) },
      { tokenId: TOKEN, amt: 2000n, holder: pub(ann) },
    ],
    keyset,
    ...over,
  };
}
const make = async (p: MovePlan) => propose(p, feeUtxo(feeFor(p)), signFee);
// Chain reads for proposeMove: every input is a known transaction and unspent (tests never touch the network).
const onChain: ChainCheck = { txKnown: async () => 'known', spent: async () => ({ state: 'unspent' }) };

const k2of3 = keysetFor({ kind: 'majority', m: 2 }, [pub(ann), pub(ben), pub(cat)]);
const k3of3 = keysetFor({ kind: 'unanimous' }, [pub(cat), pub(ann), pub(ben)]);

describe('default rule', () => {
  test('smallest majority by default; warnings in plain words', () => {
    expect([3, 4, 5].map((n) => defaultRule(n))).toEqual([
      { kind: 'majority', m: 2 },
      { kind: 'majority', m: 3 },
      { kind: 'majority', m: 3 },
    ]);
    expect(keysetFor(defaultRule(3), [pub(ann), pub(ben), pub(cat)]).m).toBe(2);
    expect(RULE_WARNING.unanimous).toContain('stuck for good');
    expect(RULE_WARNING.majority).toContain("each partner's shares move only with their own approval");
    expect(RULE_WARNING.majority).toContain('a majority decides other matters');
    expect(RULE_WARNING.majority).not.toContain('even without one partner');
    expect(RULE_WARNING.majority).not.toContain('never freezes');
  });
});

describe('script build / verify', () => {
  test('unanimous = n-of-n, majority = M-of-N, keys canonical', () => {
    expect(k3of3.m).toBe(3);
    expect(k2of3.m).toBe(2);
    expect(k3of3.pubKeys).toEqual([...k3of3.pubKeys].sort());
    expect(keysetFor({ kind: 'unanimous' }, [pub(ben), pub(ann), pub(cat)])).toEqual(k3of3);
  });
  test('refuses non-majority, duplicates, a lone partner', () => {
    expect(() => keysetFor({ kind: 'majority', m: 1 }, [pub(ann), pub(ben), pub(cat)])).toThrow();
    expect(() => keysetFor({ kind: 'unanimous' }, [pub(ann), pub(ann)])).toThrow();
    expect(() => keysetFor({ kind: 'unanimous' }, [pub(ann)])).toThrow();
  });
  test('round trip: token, amount, holder, keyset', () => {
    for (const ks of [k2of3, k3of3]) {
      const s = partnerLockScript({ tokenId: TOKEN, amt: 3000n, holder: pub(cat) }, ks);
      expect(parsePartnerLock(s)).toEqual({ tokenId: TOKEN, amt: 3000n, holder: pub(cat), ...ks });
      expect(BSV21.decode(s)?.getAmount()).toBe(3000n); // a normal BSV-21 transfer to indexers
    }
  });
  test('holder must be a partner', () => {
    expect(() => partnerLockScript({ tokenId: TOKEN, amt: 1n, holder: pub(stranger) }, k2of3)).toThrow();
  });
  test('label', () => expect(partnershipLabel(3000n)).toBe('Partnership shares · 3,000 · locked'));
});

describe('partial-signature collection', () => {
  test('2-of-3: proposer + one partner → ready → valid transaction', async () => {
    let p = await make(plan(k2of3));
    const tx = proposalTx(p);
    expect(isReady(p)).toBe(false);
    p = addSignatures(p, pub(ann), signAs(ann, tx, inputsFor(p, pub(ann))));
    expect(isReady(p)).toBe(false);
    expect(waitingOn(p).sort()).toEqual([pub(ben), pub(cat)].sort());
    p = importProposal(exportProposal(p)); // travels as JSON
    p = addSignatures(p, pub(cat), signAs(cat, tx, [0]));
    expect(isReady(p)).toBe(true);
    const { rawTx, txid } = finalize(p);
    expect(Transaction.fromHex(rawTx).id('hex')).toBe(txid);
  });
  test('3-of-3: needs all three, any order', async () => {
    let p = await make(plan(k3of3, { inputs: [locked(k3of3, ann, 3000n)] }));
    const tx = proposalTx(p);
    for (const k of [cat, ann]) p = addSignatures(p, pub(k), signAs(k, tx, [0]));
    expect(isReady(p)).toBe(false);
    p = addSignatures(p, pub(ben), signAs(ben, tx, [0]));
    expect(() => finalize(p)).not.toThrow();
  });
  test('two locked inputs are each counted', async () => {
    let p = await make(
      plan(k2of3, {
        inputs: [locked(k2of3, ann, 1000n), locked(k2of3, ann, 2000n)],
      }),
    );
    const tx = proposalTx(p);
    p = addSignatures(p, pub(ann), signAs(ann, tx, [0, 1]));
    p = addSignatures(p, pub(ben), signAs(ben, tx, [0]));
    expect(isReady(p)).toBe(false);
    p = addSignatures(p, pub(ben), signAs(ben, tx, [1]));
    expect(isReady(p)).toBe(true);
    expect(() => finalize(p)).not.toThrow();
  });
  test('bad signatures are refused when added', async () => {
    const p = await make(plan(k2of3));
    const tx = proposalTx(p);
    expect(() => addSignatures(p, pub(stranger), signAs(stranger, tx, [0]))).toThrow('not one of these partners');
    expect(() => addSignatures(p, pub(ben), signAs(ann, tx, [0]))).toThrow('does not match');
    const other = proposalTx(await make(plan(k2of3, { summary: 'other' })));
    expect(() => addSignatures(p, pub(ben), signAs(ben, other, [0]))).toThrow('does not match');
  });
});

describe('refusal to broadcast with too few signatures', () => {
  test('2-of-3 with one signature', async () => {
    let p = await make(plan(k2of3));
    p = addSignatures(p, pub(ann), signAs(ann, proposalTx(p), [0]));
    expect(() => finalize(p)).toThrow('Not enough partner signatures yet: 1 of 2');
  });
  test('3-of-3 with two', async () => {
    let p = await make(plan(k3of3, { inputs: [locked(k3of3, ann, 3000n)] }));
    const tx = proposalTx(p);
    p = addSignatures(p, pub(ann), signAs(ann, tx, [0]));
    p = addSignatures(p, pub(ben), signAs(ben, tx, [0]));
    expect(() => finalize(p)).toThrow('2 of 3');
  });
  test('a forged signature smuggled into the JSON does not count', async () => {
    let p = await make(plan(k2of3));
    const tx = proposalTx(p);
    p = addSignatures(p, pub(ann), signAs(ann, tx, [0]));
    p = { ...p, sigs: { '0': { ...p.sigs['0'], [pub(ben)]: signAs(stranger, tx, [0])[0] } } };
    expect(isReady(p)).toBe(false);
    expect(() => finalize(p)).toThrow('Not enough');
  });
  test('shares must balance and stay one token', async () => {
    expect(make(plan(k2of3, { outputs: [{ tokenId: TOKEN, amt: 3001n, holder: pub(ben) }] }))).rejects.toThrow(
      'balance',
    );
    expect(
      make(plan(k2of3, { outputs: [{ tokenId: 'b'.repeat(64) + '_0', amt: 3000n, holder: pub(ben) }] })),
    ).rejects.toThrow('one token');
  });
  test('fee input must be the fee key and big enough', async () => {
    const pl = plan(k2of3);
    expect(propose(pl, feeUtxo(1), signFee)).rejects.toThrow('too small');
    expect(propose(pl, { ...feeUtxo(feeFor(pl)), pubKey: pub(stranger) }, signFee)).rejects.toThrow('fee key');
  });
});

describe('admit a partner', () => {
  test('old 2-of-3 signs a move into the new 3-of-4 keyset', async () => {
    const next = keysetFor({ kind: 'majority', m: 3 }, [pub(ann), pub(ben), pub(cat), pub(max)]);
    let p = await make(
      plan(k2of3, {
        kind: 'admit',
        summary: 'Admit $max for 10%',
        inputs: [locked(k2of3, ann, 3000n)],
        outputs: [
          { tokenId: TOKEN, amt: 2700n, holder: pub(ann) },
          { tokenId: TOKEN, amt: 300n, holder: pub(max) },
        ],
        keyset: next,
      }),
    );
    const tx = proposalTx(p);
    expect(() => addSignatures(p, pub(max), signAs(max, tx, [0]))).toThrow(); // new partner can't sign the old lock
    p = addSignatures(p, pub(ann), signAs(ann, tx, [0]));
    p = addSignatures(p, pub(ben), signAs(ben, tx, [0]));
    const out = Transaction.fromHex(finalize(p).rawTx).outputs.map((o) => parsePartnerLock(o.lockingScript));
    expect(out[1]).toMatchObject({ holder: pub(max), amt: 300n, m: 3 });
  });
});

describe('recovery from seed + agreement record', () => {
  test('rebuilds the exact script and finds my holdings with no server', async () => {
    // Seed-derived key stand-in: a deterministic key from the "seed" + partnership id (wallet: BRC-42 self).
    const seed = PrivateKey.fromRandom();
    const derive = (s: PrivateKey, id: string) => PrivateKey.fromString(toHex(Hash.sha256(s.toString() + id)), 'hex');
    const mine = derive(seed, 'room-1');
    const record = { rule: { kind: 'majority', m: 2 } as const, partnerKeys: [pub(mine), pub(ben), pub(cat)] };
    const ks = keysetFor(record.rule, record.partnerKeys);
    const onChain = [
      { outpoint: 'x.0', lockingScript: partnerLockScript({ tokenId: TOKEN, amt: 500n, holder: pub(mine) }, ks) },
      { outpoint: 'y.0', lockingScript: partnerLockScript({ tokenId: TOKEN, amt: 900n, holder: pub(ben) }, ks) },
      { outpoint: 'z.0', lockingScript: BSV21.transfer(TOKEN, 5n).lock(new P2PKH().lock(ann.toAddress())) },
    ];
    // Lost phone: restore the seed, derive again, same key.
    const again = derive(seed, 'room-1');
    const found = findMyHoldings(onChain, pub(again));
    expect(found.map((f) => f.outpoint)).toEqual(['x.0']);
    expect(found[0].lock.pubKeys).toEqual(ks.pubKeys);
    // ...and can spend it with one other partner, using only the record.
    const src = new Transaction();
    src.addInput({
      sourceTXID: 'f'.repeat(64),
      sourceOutputIndex: 0,
      unlockingScript: new P2PKH().lock(ann.toAddress()),
      sequence: 0xffffffff,
    });
    src.addOutput({ lockingScript: found[0].lockingScript, satoshis: 1 });
    const pl = plan(ks, {
      inputs: [{ sourceTx: src, vout: 0 }],
      outputs: [{ tokenId: TOKEN, amt: 500n, holder: pub(ben) }],
    });
    let p = await make(pl);
    const tx = proposalTx(p);
    p = addSignatures(p, pub(again), signAs(again, tx, [0]));
    p = addSignatures(p, pub(cat), signAs(cat, tx, [0]));
    expect(() => finalize(p)).not.toThrow();
  });
});

describe('Exchange never lists them', () => {
  test('locked holdings are recognised; ordinary tokens and listings are not', () => {
    expect(isPartnerLocked(partnerLockScript({ tokenId: TOKEN, amt: 1n, holder: pub(ann) }, k2of3))).toBe(true);
    expect(isPartnerLocked(BSV21.transfer(TOKEN, 1n).lock(new P2PKH().lock(ann.toAddress())))).toBe(false);
    expect(isPartnerLocked(buildListingScript(TOKEN, 1n, ann.toAddress(), ann.toAddress(), 100))).toBe(false);
  });
});

describe('approval shows what the transaction really moves (b-Aware)', () => {
  test('decodes the real holdings, ignoring the summary', async () => {
    const p = await make(plan(k2of3, { summary: 'Send 1 share to $ben' }));
    const d = describeProposalMoves(p);
    expect(d.moves.map((m) => [m.holder, m.amt])).toEqual([
      [pub(ben), 1000n],
      [pub(ann), 2000n],
    ]);
    expect(d.sharesIn).toBe(3000n);
    expect(proposalMoveProblem(d, k2of3, { signer: pub(ann) })).toBeNull();
  });
  test('an output outside the partnership is refused', async () => {
    const p = await make(plan(k2of3));
    const tx = proposalTx(p);
    tx.addOutput({
      lockingScript: BSV21.transfer(TOKEN, 5n).lock(new P2PKH().lock(stranger.toAddress())),
      satoshis: 1,
    });
    const bad = { ...p, txEF: tx.toHexEF() };
    const d = describeProposalMoves(bad);
    expect(d.unexpected.length).toBe(1);
    expect(proposalMoveProblem(d, k2of3)).toContain('outside the partnership');
  });
  test('unbalanced shares are refused', async () => {
    const p = await make(plan(k2of3));
    const tx = proposalTx(p);
    tx.outputs[1].lockingScript = partnerLockScript({ tokenId: TOKEN, amt: 2001n, holder: pub(ann) }, k2of3);
    const d = describeProposalMoves({ ...p, txEF: tx.toHexEF() });
    expect(proposalMoveProblem(d, k2of3, { signer: pub(ann) })).toContain("don't balance");
  });
});

// b-Aware, 0xRen (INBOX 471/478): a transfer checked amounts and tokens but never WHICH keys the new holdings are
// locked to, so a partner could propose a move whose outputs look like the same holdings on the card but sit under a
// different keyset (a partner dropped, the proposer's second key added, M lowered) and the victim would sign it.
describe('every holding stays under the agreed keyset (b-Aware, 0xRen)', () => {
  const benAlt = PrivateKey.fromRandom(); // a second key the proposer ($ben) controls
  // Same partners minus $cat, plus $ben's second key: still 2-of-3, but $ben alone now holds 2 of the 3 keys.
  const rekeyed = keysetFor({ kind: 'majority', m: 2 }, [pub(ann), pub(ben), pub(benAlt)]);
  const attack = () =>
    make(
      plan(k2of3, {
        summary: 'Send 1,000 shares to $ben',
        outputs: [
          { tokenId: TOKEN, amt: 1000n, holder: pub(ben) },
          { tokenId: TOKEN, amt: 2000n, holder: pub(ann) }, // "stays with $ann", but $ben + benAlt can move it
        ],
        keyset: rekeyed,
      }),
    );

  test('a re-keyed transfer is refused, though the card would show the same holders and amounts', async () => {
    const p = await attack();
    const d = describeProposalMoves(p);
    expect(d.moves.map((m) => [m.holder, m.amt])).toEqual([
      [pub(ben), 1000n],
      [pub(ann), 2000n],
    ]);
    expect(proposalMoveProblem(d, k2of3)).toContain("aren't your partnership's agreed partners");
    // ...and it really would have worked: $ann + $ben sign, then $ben moves "$ann's" change with his two keys alone.
    let q = addSignatures(p, pub(ann), signAs(ann, proposalTx(p), [0]));
    q = addSignatures(q, pub(ben), signAs(ben, proposalTx(q), [0]));
    const out = Transaction.fromHex(finalize(q).rawTx).outputs.map((o) => parsePartnerLock(o.lockingScript));
    expect(out[1]).toMatchObject({ holder: pub(ann), m: 2 });
    expect(out[1]!.pubKeys).not.toContain(pub(cat));
    expect(out[1]!.pubKeys).toContain(pub(benAlt));
  });

  test('a genuine transfer passes, whatever order the record lists the keys in', async () => {
    const d = describeProposalMoves(await make(plan(k2of3)));
    expect(d.lockedMatches).toBe(true);
    expect(proposalMoveProblem(d, k2of3, { signer: pub(ann) })).toBeNull();
    expect(proposalMoveProblem(d, { m: 2, pubKeys: [...k2of3.pubKeys].reverse() }, { signer: pub(ann) })).toBeNull();
  });

  test('lowering M on the same partners is refused (unanimous → 2 of 3)', async () => {
    const p = await make(plan(k3of3, { inputs: [locked(k3of3, ann, 3000n)], keyset: k2of3 }));
    expect(proposalMoveProblem(describeProposalMoves(p), k3of3)).toContain('agreed partners');
  });

  test('inputs under any other keyset are refused', async () => {
    const p = await make(plan(k2of3));
    expect(proposalMoveProblem(describeProposalMoves(p), k3of3)).toContain('agreed partners');
  });

  test('no known agreed keyset: refuse (fail closed)', async () => {
    expect(proposalMoveProblem(describeProposalMoves(await make(plan(k2of3))), null)).toContain("aren't known");
  });

  test("the proposal's own locked list must describe the transaction", async () => {
    const p = await make(plan(k2of3, { inputs: [locked(k2of3, ann, 1000n), locked(k2of3, ann, 2000n)] }));
    const variants = [
      { ...p, locked: [p.locked[0], p.locked[0]] }, // listed twice, one left out
      { ...p, locked: [p.locked[0]] }, // one left out
      { ...p, locked: [p.locked[0], { ...p.locked[1], pubKeys: rekeyed.pubKeys }] }, // keys not the script's
      { ...p, locked: [...p.locked, { index: 2, ...k2of3 }] }, // the fee input is not a partner lock
    ];
    for (const v of variants) {
      const d = describeProposalMoves(v);
      expect(d.lockedMatches).toBe(false);
      expect(proposalMoveProblem(d, k2of3)).toContain("don't match their locks");
    }
    expect(describeProposalMoves(p).sharesIn).toBe(3000n); // read from the inputs, not the list
  });

  test('an admission passes only against a verified new keyset', async () => {
    const next = keysetFor({ kind: 'majority', m: 3 }, [pub(ann), pub(ben), pub(cat), pub(max)]);
    const p = await make(
      plan(k2of3, {
        kind: 'admit',
        outputs: [
          { tokenId: TOKEN, amt: 2700n, holder: pub(ann) },
          { tokenId: TOKEN, amt: 300n, holder: pub(max) },
        ],
        keyset: next,
      }),
    );
    const d = describeProposalMoves(p);
    expect(proposalMoveProblem(d, k2of3)).toContain('agreed partners');
    expect(proposalMoveProblem(d, k2of3, { signer: pub(ann), next })).toBeNull();
    expect(proposalMoveProblem(d, k2of3, { signer: pub(ann), next: rekeyed })).toContain('agreed partners');
  });

  test('agreedKeyset: the rule over the recorded keys, mine among them, or nothing', () => {
    const rule = { kind: 'majority', m: 2 } as const;
    const rec = { complete: true, m: 2, pubKeys: [pub(cat), pub(ann), pub(ben)] };
    expect(agreedKeyset({ rule, keyset: rec }, pub(ann))).toEqual(k2of3);
    expect(agreedKeyset({ rule, keyset: { ...rec, complete: false } }, pub(ann))).toBeNull();
    expect(agreedKeyset({ rule: null, keyset: rec }, pub(ann))).toBeNull();
    expect(agreedKeyset({ rule, keyset: null }, pub(ann))).toBeNull();
    expect(agreedKeyset({ rule, keyset: rec }, null)).toBeNull();
    expect(agreedKeyset({ rule, keyset: rec }, pub(max))).toBeNull(); // not my partnership's lock
    expect(agreedKeyset({ rule: { kind: 'unanimous' }, keyset: rec }, pub(ann))).toBeNull(); // M disagrees
    expect(agreedKeyset({ rule, keyset: { ...rec, pubKeys: [pub(ann), pub(ann), pub(ben)] } }, pub(ann))).toBeNull();
  });

  test('planKeysetProblem: the proposer never funds a re-keyed or stale plan', () => {
    expect(planKeysetProblem(plan(k2of3), k2of3)).toBeNull();
    expect(planKeysetProblem(plan(k2of3, { keyset: rekeyed }), k2of3)).toContain('agreed partners');
    expect(planKeysetProblem(plan(k3of3, { inputs: [locked(k2of3, ann, 3000n)] }), k3of3)).toContain(
      'older partner key set',
    );
    expect(planKeysetProblem(plan(k2of3), null)).toContain("aren't known");
  });
});

describe('wallet actions refuse a re-keyed move before any sheet (b-Aware, 0xRen)', () => {
  const benAlt = PrivateKey.fromRandom();
  const rekeyed = keysetFor({ kind: 'majority', m: 2 }, [pub(ann), pub(ben), pub(benAlt)]);
  // A fake BRC-100 wallet holding one partner key (and the proposer's fee key); records every call.
  const wallet = (me: PrivateKey) => {
    const calls: string[] = [];
    const ctx = {
      wallet: {
        getPublicKey: async (a: { keyID: string }) => {
          calls.push('getPublicKey');
          return { publicKey: a.keyID.includes(':fee:') ? pub(feeKey) : pub(me) };
        },
        createSignature: async (a: { keyID: string; hashToDirectlySign: number[] }) => {
          calls.push('createSignature');
          const k = a.keyID.includes(':fee:') ? feeKey : me;
          return { signature: ECDSA.sign(new BigNumber(a.hashToDirectlySign), k, true).toDER() as number[] };
        },
        createAction: async (a: { outputs: { lockingScript: string; satoshis: number }[] }) => {
          calls.push('createAction');
          const tx = new Transaction();
          tx.addInput({
            sourceTXID: (n++).toString(16).padStart(64, '0'),
            sourceOutputIndex: 0,
            unlockingScript: new P2PKH().lock(ann.toAddress()),
            sequence: 0xffffffff,
          });
          for (const o of a.outputs)
            tx.addOutput({ lockingScript: new P2PKH().lock(feeKey.toAddress()), satoshis: o.satoshis });
          return { txid: tx.id('hex'), tx: tx.toBinary() };
        },
      },
    } as unknown as OneSatContext;
    return { ctx, calls };
  };

  test('signProposal: genuine transfer signs (proposer first, then a partner); re-keyed one is never signed', async () => {
    const good = await make(plan(k2of3)); // $ann sends 1,000 of her 3,000 to $ben
    const byAnn = await signProposal(wallet(ann).ctx, good, k2of3);
    expect(signedBy(byAnn)).toEqual([pub(ann)]);
    const byBen = await signProposal(wallet(ben).ctx, byAnn, k2of3);
    expect(signedBy(byBen).sort()).toEqual([pub(ann), pub(ben)].sort());
    expect(() => finalize(byBen)).not.toThrow();

    const bad = await make(plan(k2of3, { keyset: rekeyed }));
    const v = wallet(cat);
    await expect(signProposal(v.ctx, bad, k2of3)).rejects.toThrow('agreed partners');
    await expect(signProposal(v.ctx, good, null)).rejects.toThrow("aren't known");
    expect(v.calls).not.toContain('createSignature');
  });

  test('signProposal refuses a partner whose own key is not in the agreed keyset', async () => {
    const w = wallet(max);
    const p = await make(plan(k2of3));
    const byAnn = addSignatures(p, pub(ann), signAs(ann, proposalTx(p), [0]));
    await expect(signProposal(w.ctx, byAnn, k2of3)).rejects.toThrow('not on this partnership lock');
    expect(w.calls).not.toContain('createSignature');
  });

  test('proposeMove: genuine plan is funded and proposed; a re-keyed plan funds nothing', async () => {
    const w = wallet(ann);
    const p = await proposeMove(w.ctx, plan(k2of3), k2of3, onChain);
    expect(proposalMoveProblem(describeProposalMoves(p), k2of3, { signer: pub(ann) })).toBeNull();
    expect(w.calls).toContain('createAction');

    const v = wallet(ben);
    await expect(proposeMove(v.ctx, plan(k2of3, { keyset: rekeyed }), k2of3, onChain)).rejects.toThrow(
      'agreed partners',
    );
    expect(v.calls).toEqual([]);
  });

  test('broadcastProposal: a fully signed re-keyed move is not broadcast', async () => {
    let p = await make(plan(k2of3, { keyset: rekeyed }));
    p = addSignatures(p, pub(ann), signAs(ann, proposalTx(p), [0]));
    p = addSignatures(p, pub(ben), signAs(ben, proposalTx(p), [0]));
    expect(() => finalize(p)).not.toThrow(); // valid on chain...
    await expect(broadcastProposal(p, k2of3)).rejects.toThrow('Nothing was broadcast'); // ...but we refuse
  });
});

// Independent review of the keyset fix: parsePartnerLock is a pattern match, so a script that PARSES as the agreed
// lock can still carry a backdoor. Every input and output must be the exact template, byte for byte.
describe('holdings must be the exact partner lock template (review: backdoors, amounts)', () => {
  const benSecret = PrivateKey.fromRandom(); // a key only $ben holds; not a partner key
  // A proposal shaped like propose()'s, but with whatever output scripts a malicious proposer chooses (fee re-signed).
  const raw = async (outs: LockingScript[]) => {
    const good = await make(plan(k2of3));
    const tx = proposalTx(good);
    tx.outputs = [];
    for (const s of outs) tx.addOutput({ lockingScript: s, satoshis: 1 });
    const fee = { ...good.fee, sig: toHex(signDigest(feeKey, sighash(tx, good.fee.index))) };
    return { ...good, txEF: tx.toHexEF(), fee };
  };
  const lock = (amt: bigint, holder: PrivateKey) =>
    partnerLockScript({ tokenId: TOKEN, amt, holder: pub(holder) }, k2of3);
  const withOps = (s: LockingScript, f: (x: Script) => void) => {
    const x = new Script([...s.chunks]);
    f(x);
    return new LockingScript(x.chunks);
  };
  const backdoor = (s: LockingScript) =>
    withOps(s, (x) =>
      x
        .writeOpCode(OP.OP_DROP)
        .writeBin(Utils.toArray(pub(benSecret), 'hex'))
        .writeOpCode(OP.OP_CHECKSIG),
    );

  test('a backdoor after OP_CHECKMULTISIG is refused, though it parses as "2,000 → $ann" and really is spendable by $ben alone', async () => {
    const p = await raw([lock(1000n, ben), backdoor(lock(2000n, ann))]);
    const d = describeProposalMoves(p);
    expect(d.moves.map((m) => [m.holder, m.amt, m.m])).toEqual([
      [pub(ben), 1000n, 2],
      [pub(ann), 2000n, 2],
    ]);
    expect(proposalMoveProblem(d, k2of3, { signer: pub(ann) })).toContain("aren't standard partner locks");
    // the danger is real: once moved, benSecret alone spends it (multisig fails, its result is dropped)
    let q = addSignatures(p, pub(ann), signAs(ann, proposalTx(p), [0]));
    q = addSignatures(q, pub(ben), signAs(ben, proposalTx(q), [0]));
    const moved = Transaction.fromHex(finalize(q).rawTx);
    const spend = new Transaction();
    spend.addInput({ sourceTransaction: moved, sourceOutputIndex: 1, sequence: 0xffffffff });
    spend.addOutput({ lockingScript: new P2PKH().lock(benSecret.toAddress()), satoshis: 1 });
    const sig = signDigest(benSecret, sighash(spend, 0));
    const ok = new Spend({
      sourceTXID: moved.id('hex'),
      sourceOutputIndex: 1,
      sourceSatoshis: 1,
      lockingScript: moved.outputs[1].lockingScript,
      transactionVersion: spend.version,
      otherInputs: [],
      outputs: spend.outputs,
      inputIndex: 0,
      unlockingScript: new UnlockingScript(
        new Script().writeBin(sig).writeOpCode(OP.OP_0).writeOpCode(OP.OP_0).writeOpCode(OP.OP_0).chunks,
      ),
      inputSequence: 0xffffffff,
      lockTime: spend.lockTime,
    }).validate();
    expect(ok).toBe(true);
    await expect(broadcastProposal(q, k2of3)).rejects.toThrow('Nothing was broadcast');
  });

  test('an anyone-can-spend suffix and an OP_IF wrapper are refused', async () => {
    const suffix = withOps(lock(2000n, ann), (x) => x.writeOpCode(OP.OP_DROP).writeOpCode(OP.OP_1));
    const real = lock(2000n, ann);
    const wrapped = new Script(real.chunks.slice(0, 8));
    wrapped
      .writeOpCode(OP.OP_IF)
      .writeBin(Utils.toArray(pub(benSecret), 'hex'))
      .writeOpCode(OP.OP_CHECKSIG)
      .writeOpCode(OP.OP_ELSE);
    wrapped.chunks.push(...real.chunks.slice(8));
    wrapped.writeOpCode(OP.OP_ENDIF);
    for (const bad of [suffix, new LockingScript(wrapped.chunks)]) {
      const d = describeProposalMoves(await raw([lock(1000n, ben), bad]));
      expect(d.moves[1]).toMatchObject({ holder: pub(ann), amt: 2000n }); // parses as a normal holding
      expect(proposalMoveProblem(d, k2of3, { signer: pub(ann) })).toContain("aren't standard partner locks");
    }
  });

  test('a backdoored INPUT is refused too', async () => {
    const p = await make(plan(k2of3, { inputs: [{ sourceTx: locked(k2of3, ann, 3000n).sourceTx, vout: 0 }] }));
    const src = locked(k2of3, ann, 3000n).sourceTx;
    src.outputs[0].lockingScript = backdoor(src.outputs[0].lockingScript);
    const tx = proposalTx(p);
    tx.inputs[0].sourceTransaction = src;
    tx.inputs[0].sourceTXID = src.id('hex');
    const d = describeProposalMoves({ ...p, txEF: tx.toHexEF() });
    expect(d.inputs[0]).toMatchObject({ holder: pub(ann), amt: 3000n });
    expect(proposalMoveProblem(d, k2of3, { signer: pub(ann) })).toContain("aren't standard partner locks");
  });

  test('a non-canonical amount ("0x7d0" reads as 2,000 in JavaScript; indexers may burn it) is refused', async () => {
    const s = new Script([...lock(2000n, ann).chunks]);
    const json = JSON.stringify({ p: 'bsv-20', op: 'transfer', id: TOKEN, amt: '0x7d0' });
    s.chunks[6] = { op: json.length < 76 ? json.length : OP.OP_PUSHDATA1, data: Utils.toArray(json, 'utf8') };
    expect(parsePartnerLock(s)?.amt).toBe(2000n);
    const d = describeProposalMoves(await raw([lock(1000n, ben), new LockingScript(s.chunks)]));
    expect(d.sharesIn).toBe(d.sharesOut);
    expect(proposalMoveProblem(d, k2of3, { signer: pub(ann) })).toContain("aren't standard partner locks");
  });

  test('outputs built from the record (sorted lowercase keys, as bit-sign keyset()) are the canonical bytes', () => {
    const record = { m: 2, pubKeys: [pub(cat), pub(ann), pub(ben)].map((k) => k.toLowerCase()).sort() };
    const s = partnerLockScript({ tokenId: TOKEN, amt: 10n, holder: pub(ann) }, record).toHex();
    expect(s).toBe(partnerLockScript({ tokenId: TOKEN, amt: 10n, holder: pub(ann) }, k2of3).toHex());
  });
});

// Review (pre-existing): the card listed outputs only, so spending $ann's 3,000 into "2,900 → $ben, 100 → $ann" read
// like an ordinary transfer. Conservative rule: a partner's wallet signs only when every partner whose shares go down
// is the signer (who sees their own loss) or has already signed this exact transaction.
describe("a partner's shares never move without that partner's signature (review)", () => {
  const takeAnns = () =>
    make(
      plan(k2of3, {
        outputs: [
          { tokenId: TOKEN, amt: 2900n, holder: pub(ben) },
          { tokenId: TOKEN, amt: 100n, holder: pub(ann) },
        ],
      }),
    );

  test('net change per partner is shown, and others refuse until the losing partner signs', async () => {
    const p = await takeAnns();
    const d = describeProposalMoves(p);
    expect(d.net).toEqual([
      { holder: pub(ann), change: -2900n },
      { holder: pub(ben), change: 2900n },
    ]);
    expect(proposalMoveProblem(d, k2of3, { signer: pub(cat) })).toBe(AWAITING_OWNER);
    expect(proposalMoveProblem(d, k2of3, { signer: pub(ben) })).toBe(AWAITING_OWNER);
    expect(proposalMoveProblem(d, k2of3)).toBe(AWAITING_OWNER); // default: every loser must have signed
    expect(proposalMoveProblem(d, k2of3, { signer: pub(ann) })).toBeNull(); // $ann sees "$ann −2,900" and decides
    const signed = addSignatures(p, pub(ann), signAs(ann, proposalTx(p), [0]));
    expect(proposalMoveProblem(describeProposalMoves(signed), k2of3, { signer: pub(cat) })).toBeNull();
  });

  test('a signature that does not verify is not consent', async () => {
    const p = await takeAnns();
    const forged = { ...p, sigs: { '0': { [pub(ann)]: signAs(stranger, proposalTx(p), [0])[0] } } };
    expect(proposalMoveProblem(describeProposalMoves(forged), k2of3, { signer: pub(cat) })).toBe(AWAITING_OWNER);
  });

  test("$ben + $cat (a majority) cannot co-sign or broadcast a move of $ann's shares without her", async () => {
    const p = await takeAnns();
    await expect(signProposal(wallet2(cat), p, k2of3)).rejects.toThrow('not approved');
    // signed by wallets that skip the check (e.g. an old version): still not broadcast by this one
    let q = addSignatures(p, pub(ben), signAs(ben, proposalTx(p), [0]));
    q = addSignatures(q, pub(cat), signAs(cat, proposalTx(q), [0]));
    expect(() => finalize(q)).not.toThrow();
    await expect(broadcastProposal(q, k2of3)).rejects.toThrow('Nothing was broadcast');
  });
});

describe('proposer: every check before the fee is funded (review)', () => {
  test('a plan whose outputs disagree with the real input amounts funds nothing', async () => {
    const calls: string[] = [];
    const ctx = {
      wallet: new Proxy(
        {},
        {
          get: (_, k) => async () => {
            calls.push(String(k));
            throw new Error('wallet must not be called');
          },
        },
      ),
    } as unknown as OneSatContext;
    const bad = plan(k2of3, {
      outputs: [
        { tokenId: TOKEN, amt: 1000n, holder: pub(ben) },
        { tokenId: TOKEN, amt: 2500n, holder: pub(ann) }, // built from a bogus 3,500 record row; the script says 3,000
      ],
    });
    await expect(proposeMove(ctx, bad, k2of3, onChain)).rejects.toThrow('Shares must balance');
    expect(calls).toEqual([]);
  });

  test("my holdings' amounts come from the scripts, not the record's amt column", () => {
    const h = locked(k2of3, ann, 3000n);
    const rows = [
      { outpoint: `${h.sourceTx.id('hex')}.0`, rawTx: h.sourceTx.toHex(), amt: '3500' }, // bogus amt
      { outpoint: 'x.0', rawTx: 'not hex', amt: '5' },
      { outpoint: `${h.sourceTx.id('hex')}.0`, rawTx: locked(k2of3, ben, 9n).sourceTx.toHex(), amt: '9' }, // not mine
    ];
    const mine = holdingsFromRecord(rows, pub(ann), TOKEN, k2of3).holdings;
    expect(mine.map((m) => m.amt)).toEqual([3000n]);
    expect(holdingsFromRecord(rows, pub(ann), 'b'.repeat(64) + '_0', k2of3).holdings).toEqual([]);
  });
});

describe('more partners than one lock holds (review)', () => {
  test('agreedKeysetCheck says so plainly', () => {
    const keys = Array.from({ length: 20 }, () => pub(PrivateKey.fromRandom()));
    const r = agreedKeysetCheck(
      { rule: { kind: 'majority', m: 11 }, keyset: { complete: true, m: 11, pubKeys: keys } },
      keys[0],
    );
    expect(r.keyset).toBeNull();
    expect(r.why).toContain('20 partners');
    expect(r.why).toContain('at most 16');
    expect(agreedKeysetCheck({ rule: null, keyset: null }, keys[0]).why).toContain("isn't recorded");
  });
});

// A fake wallet for one partner key (createSignature signs the digest), for the consent tests above.
function wallet2(me: PrivateKey): OneSatContext {
  return {
    wallet: {
      getPublicKey: async () => ({ publicKey: pub(me) }),
      createSignature: async (a: { hashToDirectlySign: number[] }) => ({
        signature: ECDSA.sign(new BigNumber(a.hashToDirectlySign), me, true).toDER() as number[],
      }),
    },
  } as unknown as OneSatContext;
}

// Re-review follow-ups.
describe('a move takes shares from one partner only (re-review: two losers deadlock)', () => {
  const twoLosers = () =>
    plan(k2of3, {
      inputs: [locked(k2of3, ann, 1000n), locked(k2of3, cat, 1000n)],
      outputs: [{ tokenId: TOKEN, amt: 2000n, holder: pub(ben) }],
    });

  test('refused for every signer and for broadcast, even once one loser has signed', async () => {
    const p = await make(twoLosers());
    const d = describeProposalMoves(p);
    for (const signer of [pub(ann), pub(cat), pub(ben), null])
      expect(proposalMoveProblem(d, k2of3, { signer })).toBe(`${MULTI_LOSER} Not signed.`);
    const byAnn = addSignatures(p, pub(ann), signAs(ann, proposalTx(p), [0]));
    expect(proposalMoveProblem(describeProposalMoves(byAnn), k2of3, { signer: pub(cat) })).toContain(
      'more than one partner',
    );
  });

  test('signProposal and proposeMove refuse before any signature or fee', async () => {
    const calls: string[] = [];
    const ctx = {
      wallet: {
        getPublicKey: async () => {
          calls.push('getPublicKey');
          return { publicKey: pub(ann) };
        },
        createSignature: async () => {
          calls.push('createSignature');
          throw new Error('must not sign');
        },
        createAction: async () => {
          calls.push('createAction');
          throw new Error('must not fund');
        },
      },
    } as unknown as OneSatContext;
    await expect(signProposal(ctx, await make(twoLosers()), k2of3)).rejects.toThrow('more than one partner');
    await expect(proposeMove(ctx, twoLosers(), k2of3, onChain)).rejects.toThrow('more than one partner');
    expect(calls).not.toContain('createSignature');
    expect(calls).not.toContain('createAction');
  });
});

describe('holding rows: by the script, exact template, on chain (re-review)', () => {
  const row = (u: { sourceTx: Transaction; vout: number }, holder?: PrivateKey) => ({
    outpoint: `${u.sourceTx.id('hex')}.${u.vout}`,
    rawTx: u.sourceTx.toHex(),
    ...(holder ? { holder: pub(holder) } : {}),
  });

  test('a malformed row tagged $ann is skipped (noted), not allowed to block her real holdings', () => {
    const real = locked(k2of3, ann, 3000n);
    const bad = locked(k2of3, ann, 5n);
    const s = new Script([...bad.sourceTx.outputs[0].lockingScript.chunks]).writeOpCode(OP.OP_NOP);
    bad.sourceTx.outputs[0].lockingScript = new LockingScript(s.chunks);
    const otherKeys = locked(k3of3, ann, 7n); // a well-formed lock, but not the agreed keyset
    const r = holdingsFromRecord([row(real), row(bad), row(otherKeys)], pub(ann), TOKEN, k2of3);
    expect(r.holdings.map((h) => h.amt)).toEqual([3000n]);
    expect(r.skipped).toBe(2);
    expect(planKeysetProblem({ inputs: r.holdings, keyset: k2of3 }, k2of3)).toBeNull();
    expect(holdingsFromRecord([row(real)], pub(ann), TOKEN, null).holdings).toEqual([]); // no agreed keyset: none
  });

  test("rows are chosen by the holder tag in the script, not the row's holder column (no hijack)", () => {
    const bens = locked(k2of3, ben, 900n);
    const anns = locked(k2of3, ann, 3000n);
    // $ben's holding filed under $ann's name, and $ann's filed under $ben's
    const r = holdingsFromRecord([row(bens, ann), row(anns, ben)], pub(ann), TOKEN, k2of3);
    expect(r.holdings.map((h) => h.amt)).toEqual([3000n]);
    expect(r.skipped).toBe(1); // the row that claimed to be hers
    expect(holdingsFromRecord([row(bens, ann), row(anns, ben)], pub(ben), TOKEN, k2of3).holdings).toHaveLength(1);
  });

  test('the same outpoint posted twice counts once; a plan listing it twice is refused', () => {
    const real = locked(k2of3, ann, 3000n);
    const r = holdingsFromRecord([row(real), row(real)], pub(ann), TOKEN, k2of3);
    expect(r.holdings.map((h) => h.amt)).toEqual([3000n]);
    expect(r.skipped).toBe(1);
    expect(() =>
      checkPlan(plan(k2of3, { inputs: [real, real], outputs: [{ tokenId: TOKEN, amt: 6000n, holder: pub(ben) }] })),
    ).toThrow('listed twice');
  });

  test('proposeMove funds nothing unless every input is on chain and unspent (fails closed)', async () => {
    const cases: [ChainCheck, string][] = [
      [{ ...onChain, txKnown: async () => 'unknown' }, "isn't on chain"],
      [{ ...onChain, txKnown: async () => 'unclear' }, "Couldn't check"],
      [{ ...onChain, spent: async () => ({ state: 'spent', by: 'f'.repeat(64) }) }, 'already moved'],
      [{ ...onChain, spent: async () => ({ state: 'unclear' }) }, "Couldn't check"],
    ];
    for (const [chain, why] of cases) {
      const calls: string[] = [];
      const ctx = {
        wallet: new Proxy(
          {},
          {
            get: (_, k) => async () => {
              calls.push(String(k));
              throw new Error('wallet must not be called');
            },
          },
        ),
      } as unknown as OneSatContext;
      await expect(proposeMove(ctx, plan(k2of3), k2of3, chain)).rejects.toThrow(why);
      expect(calls).toEqual([]);
    }
    // asks about the real outpoint
    const asked: string[] = [];
    const pl = plan(k2of3);
    await inputsOnChainProblem(pl.inputs, {
      txKnown: async (t) => (asked.push(t), 'known'),
      spent: async (o) => (asked.push(o), { state: 'unspent' }),
    });
    const id = pl.inputs[0].sourceTx.id('hex');
    expect(asked).toEqual([id, `${id}.0`]);
  });
});

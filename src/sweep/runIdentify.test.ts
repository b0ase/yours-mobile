import { describe, expect, test } from 'bun:test';
import { LockingScript, P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from '@bsv/sdk';
import { identifyJig, jigOrigin, npgTitle, readRun, type NpgMap } from './runIdentify';

const owner = new PrivateKey(5).toPublicKey().toAddress();
const enc = (s: string) => [...new TextEncoder().encode(s)];

/** OP_FALSE OP_RETURN "run" <ver> "relayx.io" <JSON>, as RelayX writes it. */
const runOut = (json: object) => {
  const s = new Script();
  s.writeOpCode(0x00).writeOpCode(0x6a).writeBin(enc('run')).writeBin([5]).writeBin(enc('relayx.io'));
  s.writeBin(enc(JSON.stringify(json)));
  return { lockingScript: new LockingScript(s.chunks), satoshis: 0 };
};
const imageOut = () => {
  const s = new Script();
  s.writeOpCode(0x00).writeOpCode(0x6a).writeBin(enc('UNIV')).writeBin([1, 2, 3]);
  return { lockingScript: new LockingScript(s.chunks), satoshis: 0 };
};
const jig = () => ({ lockingScript: new P2PKH().lock(owner), satoshis: 273 });
const tx = (inputs: [string, number][], outputs: ReturnType<typeof jig>[]) => {
  const t = new Transaction();
  for (const [txid, vout] of inputs)
    t.addInput({
      sourceTXID: txid,
      sourceOutputIndex: vout,
      sequence: 0xffffffff,
      unlockingScript: new UnlockingScript(),
    });
  for (const o of outputs) t.addOutput(o);
  return t;
};

// deploy (class at o2) → mint (image o0, Run o1, class o2, NFT o3) → send (Run o0, NFT o1) → send (Run o0, NFT o1)
const deploy = tx(
  [['aa'.repeat(32), 0]],
  [
    imageOut(),
    runOut({ in: 0, exec: [{ op: 'DEPLOY', data: ['class NFT', { metadata: { name: 'KAZUYO' } }] }] }),
    jig(),
  ],
);
const mint = tx(
  [[deploy.id('hex'), 2]],
  [
    imageOut(),
    runOut({ in: 1, exec: [{ op: 'CALL', data: [{ $jig: 0 }, 'mint', ['', { name: '' }]] }] }),
    jig(),
    jig(),
  ],
);
const send1 = tx(
  [[mint.id('hex'), 3]],
  [runOut({ in: 1, exec: [{ op: 'CALL', data: [{ $jig: 0 }, 'send', []] }] }), jig()],
);
const send2 = tx([[send1.id('hex'), 1]], [runOut({ in: 1, exec: [] }), jig()]);
const store = new Map([deploy, mint, send1, send2].map((t) => [t.id('hex'), t]));
const getTx = async (id: string) => {
  const t = store.get(id);
  if (!t) throw new Error('missing ' + id);
  return t;
};
const MINT_ORIGIN = `${mint.id('hex')}_o3`;

describe('RelayX importer: origin walk', () => {
  test('reads the Run payload and the first jig output after the last OP_RETURN', () => {
    const r = readRun(mint)!;
    expect(r.run.in).toBe(1);
    expect(r.firstJig).toBe(2);
    expect(readRun(tx([], [jig()]))).toBeNull();
  });
  test('walks sends back to the mint output', async () => {
    const { origin } = await jigOrigin(`${send2.id('hex')}_o1`, getTx);
    expect(origin).toBe(MINT_ORIGIN);
  });
  test('the class re-output is not a new jig: it walks back to the deploy', async () => {
    const { origin } = await jigOrigin(`${mint.id('hex')}_o2`, getTx);
    expect(origin).toBe(`${deploy.id('hex')}_o2`);
  });
  test('a non-jig output is refused', async () => {
    expect(jigOrigin(`${send2.id('hex')}_o0`, getTx)).rejects.toThrow();
  });
});

describe('RelayX importer: naming', () => {
  test('an origin in the NPG S2 map is "NPG #NNNN" with its full card', async () => {
    const maps: NpgMap[] = [
      { class: '393b1c2a_o2', collection: 'NPG Series 2', jigs: { [MINT_ORIGIN]: { i: 7, n: 417 } } },
    ];
    const j = await identifyJig(`${send2.id('hex')}_o1`, getTx, maps);
    expect(j.title).toBe('NPG #0417');
    expect(j.n).toBe(417);
    expect(j.art).toMatch(/s2\/v2\/0417-card\.webp$/);
  });
  test('S1 entries carry a name and no art', async () => {
    const maps: NpgMap[] = [
      { class: '6a7a4b75_o2', collection: 'NPG S1', jigs: { [MINT_ORIGIN]: { i: 0, n: 1, name: 'Nao' } } },
    ];
    const j = await identifyJig(`${send2.id('hex')}_o1`, getTx, maps);
    expect(j.title).toBe('Nao (NPG #0001)');
    expect(j.art).toBeUndefined();
  });
  test('not in any map: named from its class DEPLOY metadata (KAZUYO, AIKA…)', async () => {
    const j = await identifyJig(`${send2.id('hex')}_o1`, getTx, []);
    expect(j.collection).toBe('KAZUYO');
    expect(j.title).toBe('KAZUYO');
  });
  test('unreadable: says so instead of throwing', async () => {
    const j = await identifyJig(`${'bb'.repeat(32)}_o1`, getTx, []);
    expect(j.title).toBe('RelayX NFT');
    expect(j.collection).toMatch(/Couldn't read it/);
  });
  test('titles pad to four digits', () => {
    expect(npgTitle(9)).toBe('NPG #0009');
  });
});

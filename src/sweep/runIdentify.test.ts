import { describe, expect, test } from 'bun:test';
import { LockingScript, P2PKH, PrivateKey, Script, Transaction, UnlockingScript } from '@bsv/sdk';
import {
  bImageOutput,
  identifyJig,
  jigOrigin,
  npgTitle,
  ORDFS,
  readRun,
  runMetadata,
  runPicture,
  type NpgMap,
} from './runIdentify';

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

// Shaped like real RelayX txs (decoded from chain, 18 Oct 2026):
// - Pixel Foxes #173 mint 1594d1e5…: o0 B:// image/png "Pixel Foxes #173.png", o1 Run CALL mint(["", {image: "_o1"}]).
// - NPG 00001 deploy d956030a…: o0 B:// image/jpeg, o1 Run DEPLOY metadata {name, image: "_o1", isCollection: false}.
// - NPG S1 mint cb1c9e84…: o0 UNIV (CBOR, proto relay.encrypted-nft, AES-128-GCM), image "_o1" → no picture.
const bOut = (mime = 'image/png', name = 'Pixel Foxes #173.png') => {
  const s = new Script();
  s.writeOpCode(0x00).writeOpCode(0x6a).writeBin(enc('19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut'));
  s.writeBin([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).writeBin(enc(mime)).writeBin(enc('binary'));
  s.writeBin(enc(name));
  return { lockingScript: new LockingScript(s.chunks), satoshis: 0 };
};
const mintArgs = (meta: object) => ({ in: 1, exec: [{ op: 'CALL', data: [{ $jig: 0 }, 'mint', ['', meta]] }] });

describe('RelayX importer: pictures', () => {
  const foxMint = tx([['cc'.repeat(32), 2]], [bOut(), runOut(mintArgs({ name: '', image: '_o1' })), jig(), jig()]);
  test('finds the B:// image output and skips UNIV (encrypted) ones', () => {
    expect(bImageOutput(foxMint)).toBe(0);
    expect(bImageOutput(mint)).toBeNull();
    expect(bImageOutput(tx([], [bOut('text/plain', 'a.txt'), jig()]))).toBeNull();
  });
  test('reads metadata from mint args and DEPLOY props', () => {
    expect(runMetadata(readRun(foxMint)!.run)).toEqual({ name: '', image: '_o1' });
    expect(runMetadata(readRun(deploy)!.run)).toEqual({ name: 'KAZUYO' });
  });
  test('"_o1" points at the B:// file in the same tx, served by ORDFS', () => {
    expect(runPicture({ image: '_o1' }, foxMint)).toEqual({ art: `${ORDFS}/content/${foxMint.id('hex')}_0` });
  });
  test('encrypted or missing images give "none" (named tile), never a broken URL', () => {
    expect(runPicture({ image: '_o1' }, mint)).toBe('none');
    expect(runPicture({ image: '_o1', isEncrypted: true }, foxMint)).toBe('none');
    expect(runPicture({ image: 'ipfs://x' }, foxMint)).toBe('none');
    expect(runPicture({ name: 'x' }, foxMint)).toBeNull();
  });
  test('https as is, b:// and bare txids via ORDFS, emoji as a tile', () => {
    const id = 'ab'.repeat(32);
    expect(runPicture({ image: 'https://x.io/a.png' }, foxMint)).toEqual({ art: 'https://x.io/a.png' });
    expect(runPicture({ image: 'http://x.io/a.png' }, foxMint)).toBe('none');
    expect(runPicture({ image: `b://${id}` }, foxMint)).toEqual({ art: `${ORDFS}/${id}` });
    expect(runPicture({ image: id.toUpperCase() }, foxMint)).toEqual({ art: `${ORDFS}/${id}` });
    expect(runPicture({ emoji: '🦊' }, foxMint)).toEqual({ emoji: '🦊' });
    expect(runPicture({ image: '🦊' }, foxMint)).toEqual({ emoji: '🦊' });
  });
  test('a held non-NPG jig gets its mint picture', async () => {
    const cls = tx(
      [['dd'.repeat(32), 0]],
      [runOut({ in: 0, exec: [{ op: 'DEPLOY', data: ['class NFT', { metadata: { name: 'Pixel Foxes' } }] }] }), jig()],
    );
    const m = tx([[cls.id('hex'), 1]], [bOut(), runOut(mintArgs({ name: '', image: '_o1' })), jig(), jig()]);
    const local = new Map([cls, m].map((t) => [t.id('hex'), t]));
    const j = await identifyJig(`${m.id('hex')}_o3`, async (id) => local.get(id)!, []);
    expect(j.collection).toBe('Pixel Foxes');
    expect(j.art).toBe(`${ORDFS}/content/${m.id('hex')}_0`);
  });
  test('a one-of class (mint carries no image) uses the DEPLOY picture', async () => {
    const cls = tx(
      [['ee'.repeat(32), 0]],
      [
        bOut('image/jpeg', 'npg.jpeg'),
        runOut({
          in: 0,
          exec: [{ op: 'DEPLOY', data: ['class NFT', { metadata: { name: 'NPG 00001', image: '_o1' } }] }],
        }),
        jig(),
      ],
    );
    const m = tx(
      [[cls.id('hex'), 2]],
      [runOut({ in: 1, exec: [{ op: 'CALL', data: [{ $jig: 0 }, 'mint', ['']] }] }), jig(), jig()],
    );
    const local = new Map([cls, m].map((t) => [t.id('hex'), t]));
    const j = await identifyJig(`${m.id('hex')}_o2`, async (id) => local.get(id)!, []);
    expect(j.title).toBe('NPG 00001');
    expect(j.art).toBe(`${ORDFS}/content/${cls.id('hex')}_0`);
  });
  test('no picture anywhere: the named tile stays', async () => {
    const j = await identifyJig(`${send2.id('hex')}_o1`, getTx, []);
    expect(j.art).toBeUndefined();
    expect(j.emoji).toBeUndefined();
  });
});

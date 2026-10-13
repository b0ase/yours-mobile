import { describe, expect, test } from 'bun:test';
import { P2PKH, PrivateKey, type CreateActionArgs, type WalletInterface } from '@bsv/sdk';
import { buildInscriptionScript } from '@1sat/templates';
import type { OneSatContext } from '@1sat/actions';
import {
  BIG_MINT_BYTES,
  detectModel,
  EDITION_INLINE_MAX,
  fileFitsKind,
  fmtBsv,
  kindMap,
  maxBytesFor,
  MB,
  mintTxBytes,
  planEditions,
  slowLandWarning,
  SMALL_MINT_BYTES,
  validateKindFields,
} from './mintKinds';
import { checkSize, isMintableType } from './mint';
import { lockOfInscription, restampIds, withExtraOutputs } from './mintMedia';
import { nftTypeOf } from '../nfts/nftLibrary';

const enc = (s: string) => new TextEncoder().encode(s);

describe('detectModel (magic bytes)', () => {
  test('GLB v2', () => {
    const b = new Uint8Array([0x67, 0x6c, 0x54, 0x46, 2, 0, 0, 0, 0, 0, 0, 0]);
    expect(detectModel(b)).toEqual({ ok: true, contentType: 'model/gltf-binary' });
  });
  test('GLB v1 is refused', () => {
    expect(detectModel(new Uint8Array([0x67, 0x6c, 0x54, 0x46, 1, 0, 0, 0])).ok).toBe(false);
  });
  test('embedded glTF JSON', () => {
    const j = { asset: { version: '2.0' }, buffers: [{ uri: 'data:application/octet-stream;base64,AAAA' }] };
    expect(detectModel(enc('  ' + JSON.stringify(j)))).toEqual({ ok: true, contentType: 'model/gltf+json' });
  });
  test('glTF with external files is refused', () => {
    const j = { asset: { version: '2.0' }, buffers: [{ uri: 'scene.bin' }] };
    const r = detectModel(enc(JSON.stringify(j)));
    expect(r.ok).toBe(false);
  });
  test('JSON that is not glTF is refused', () => {
    expect(detectModel(enc('{"hello":1}')).ok).toBe(false);
  });
  test('USDZ: zip whose first entry is a .usdc', () => {
    const name = enc('model.usdc');
    const b = new Uint8Array(30 + name.length);
    b.set([0x50, 0x4b, 0x03, 0x04]);
    b[26] = name.length;
    b.set(name, 30);
    expect(detectModel(b)).toEqual({ ok: true, contentType: 'model/vnd.usdz+zip' });
  });
  test('a plain zip is refused', () => {
    const name = enc('notes.txt');
    const b = new Uint8Array(30 + name.length);
    b.set([0x50, 0x4b, 0x03, 0x04]);
    b[26] = name.length;
    b.set(name, 30);
    expect(detectModel(b).ok).toBe(false);
  });
  test('random bytes / a PNG are refused', () => {
    expect(detectModel(new Uint8Array([0x89, 0x50, 0x4e, 0x47])).ok).toBe(false);
  });
});

describe('type detection', () => {
  test('fileFitsKind', () => {
    expect(fileFitsKind('picture', 'image/png', 'a.png')).toBe(true);
    expect(fileFitsKind('picture', 'video/mp4', 'a.mp4')).toBe(false);
    expect(fileFitsKind('music', 'audio/mpeg', 'a.mp3')).toBe(true);
    expect(fileFitsKind('video', 'video/quicktime', 'a.mov')).toBe(true);
    expect(fileFitsKind('3d', '', 'chair.glb')).toBe(true);
    expect(fileFitsKind('3d', 'model/vnd.usdz+zip', 'x')).toBe(true);
    expect(fileFitsKind('3d', 'image/png', 'a.png')).toBe(false);
  });
  test('model types are mintable and open in the 3D viewer', () => {
    for (const t of ['model/gltf-binary', 'model/gltf+json', 'model/vnd.usdz+zip']) {
      expect(isMintableType(t)).toBe(true);
      expect(nftTypeOf(t)).toBe('model');
    }
  });
});

describe('size limits per type', () => {
  test('video and 3D allow 50 MB, others 10 MB', () => {
    expect(maxBytesFor('video')).toBe(50 * MB);
    expect(maxBytesFor('3d')).toBe(50 * MB);
    expect(maxBytesFor('picture')).toBe(10 * MB);
    expect(maxBytesFor('music')).toBe(10 * MB);
    expect(maxBytesFor(null)).toBe(SMALL_MINT_BYTES);
    expect(checkSize(30 * MB, maxBytesFor('video')).ok).toBe(true);
    expect(checkSize(30 * MB, maxBytesFor('picture')).ok).toBe(false);
    expect(checkSize(BIG_MINT_BYTES + 1, maxBytesFor('3d')).ok).toBe(false);
  });
  test('slow-land warning only above 10 MB', () => {
    expect(slowLandWarning(10 * MB)).toBe('');
    expect(slowLandWarning(10 * MB + 1)).toMatch(/Pending/);
  });
  test('fmtBsv', () => {
    expect(fmtBsv(12345)).toBe('0.00012345 BSV');
    expect(fmtBsv(1e8)).toBe('1 BSV');
  });
});

describe('edition planning', () => {
  test('1 of 1', () => expect(planEditions(1, 5 * MB)).toEqual({ editions: 1, mode: 'single', outputs: 1 }));
  test('small file: N outputs in one tx', () =>
    expect(planEditions(10, 50_000)).toEqual({ editions: 10, mode: 'inline', outputs: 10 }));
  test('too many or too big: one master with editions metadata', () => {
    expect(planEditions(EDITION_INLINE_MAX + 1, 1000).mode).toBe('single');
    expect(planEditions(5, 1 * MB)).toEqual({ editions: 5, mode: 'single', outputs: 1 });
  });
  test('bad input falls back to 1', () => expect(planEditions(Number.NaN, 10).editions).toBe(1));
  test('tx bytes count every copy plus the poster', () => {
    expect(mintTxBytes(1000, planEditions(3, 1000), 200)).toBe(3200);
    expect(mintTxBytes(1000, planEditions(1, 1000))).toBe(1000);
  });
});

describe('metadata', () => {
  test('music MAP', () => {
    const m = kindMap(
      'music',
      { artist: ' VexVoid ', album: 'Echoes in the Abyss', track: '03', priceSats: 5000, editions: 1 },
      planEditions(1, 10),
      1,
    );
    expect(m).toEqual({
      kind: 'music',
      artist: 'VexVoid',
      album: 'Echoes in the Abyss',
      track: '3',
      edition: '1/1',
      price: '5000',
      poster: '_1',
    });
  });
  test('edition fields', () => {
    expect(kindMap('picture', {}, planEditions(10, 100))).toEqual({
      kind: 'picture',
      editions: '10',
      edition: 'numbered',
    });
    expect(kindMap('video', {}, planEditions(10, 5 * MB))).toEqual({
      kind: 'video',
      editions: '10',
      edition: 'master',
    });
  });
  test('validation', () => {
    expect(validateKindFields('music', { track: 'x' })).toMatch(/Track/);
    expect(validateKindFields('picture', { editions: 0 })).toMatch(/Editions/);
    expect(validateKindFields('picture', { editions: 5000 })).toMatch(/Editions/);
    expect(validateKindFields('music', { artist: 'a', track: '12', editions: 3 })).toBeNull();
  });
});

describe('extra outputs (dry run: no broadcast)', () => {
  const addr = PrivateKey.fromRandom().toAddress();
  const lock = new P2PKH().lock(addr);
  const ins = buildInscriptionScript(lock, enc('hello'), 'text/plain', { app: 'bWallet', type: 'ord', name: 'x' });

  test('lockOfInscription returns the owner lock', () => {
    expect(lockOfInscription(ins.toHex())?.toHex()).toBe(lock.toHex());
    expect(lockOfInscription(lock.toHex())).toBeNull();
  });

  test('restampIds keeps id:<action>_<index> true', () => {
    const outs = restampIds([
      { basket: '1sat', tags: ['origin', 'id:abc_0'] },
      { basket: '1sat', tags: ['origin', 'id:abc_0'] },
      { tags: [] },
    ]);
    expect(outs[0].tags).toContain('id:abc_0');
    expect(outs[1].tags).toContain('id:abc_1');
    expect(outs[2].tags).toEqual([]);
  });

  test('N copies after output 0, then the poster, then the rest', async () => {
    let seen: CreateActionArgs | null = null;
    const wallet = {
      createAction: async (a: CreateActionArgs) => {
        seen = a;
        return { txid: 'f'.repeat(64) };
      },
    } as unknown as WalletInterface;
    const ctx = withExtraOutputs({ wallet } as OneSatContext, {
      copies: 3,
      poster: {
        base64Content: btoa('jpegbytes'),
        contentType: 'image/jpeg',
        map: { app: 'bWallet', type: 'ord', name: 'c' },
      },
    });
    await ctx.wallet.createAction({
      description: 'Create inscription',
      signAndProcess: false,
      outputs: [
        {
          lockingScript: ins.toHex(),
          satoshis: 1,
          outputDescription: 'Inscription',
          basket: '1sat',
          tags: ['type:text/plain', 'origin', 'sha256:aa', 'id:q_0'],
        },
        { lockingScript: '6a', satoshis: 0, outputDescription: 'Issuer signature' },
      ],
    });
    const outs = seen!.outputs!;
    expect(outs.length).toBe(5);
    expect(outs[1].lockingScript).toBe(ins.toHex());
    expect(outs[2].lockingScript).toBe(ins.toHex());
    expect(outs[3].tags).toContain('type:image/jpeg');
    expect(outs[3].tags).toContain('id:q_3');
    expect(lockOfInscription(outs[3].lockingScript)?.toHex()).toBe(lock.toHex());
    expect(outs[4].outputDescription).toBe('Issuer signature');
    expect(seen!.signAndProcess).toBe(false);
  });

  test('no copies and no poster leaves the context alone', () => {
    const ctx = { wallet: {} } as OneSatContext;
    expect(withExtraOutputs(ctx, { copies: 1 })).toBe(ctx);
  });
});

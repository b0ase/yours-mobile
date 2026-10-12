import { describe, expect, test as it } from 'bun:test';
import { Beef, LockingScript, OP, P2PKH, PrivateKey, Script, Transaction, Utils } from '@bsv/sdk';
import { extractInscription, inscriptionFromBeef, isShortClip, typeChip, viewerFor } from './nftViewer';

const inscribe = (type: string, body: number[][]) => {
  const s = new Script();
  s.writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_IF).writeBin(Utils.toArray('ord', 'utf8'));
  s.writeOpCode(OP.OP_1).writeBin(Utils.toArray(type, 'utf8')).writeOpCode(OP.OP_0);
  for (const b of body) s.writeBin(b);
  s.writeOpCode(OP.OP_ENDIF);
  const p2pkh = new P2PKH().lock(PrivateKey.fromRandom().toAddress());
  return new LockingScript([...s.chunks, ...p2pkh.chunks]);
};

describe('viewerFor', () => {
  it('maps content types to viewers', () => {
    expect(viewerFor('video/mp4')).toBe('video');
    expect(viewerFor('audio/mpeg')).toBe('audio');
    expect(viewerFor('image/png')).toBe('image');
    expect(viewerFor('image/svg+xml')).toBe('image');
    expect(viewerFor('text/html; charset=utf-8')).toBe('html');
    expect(viewerFor('text/plain')).toBe('text');
    expect(viewerFor('application/octet-stream')).toBe('unknown');
    expect(viewerFor(undefined)).toBe('unknown');
  });
  it('short clips and chips', () => {
    expect(isShortClip(12)).toBe(true);
    expect(isShortClip(60)).toBe(false);
    expect(isShortClip(NaN)).toBe(false);
    expect(typeChip('video/mp4')).toBe('MP4');
    expect(typeChip('image/svg+xml')).toBe('SVG');
    expect(typeChip(undefined)).toBe('NFT');
  });
});

describe('inscription extraction', () => {
  it('joins split body pushes and reads the type', () => {
    const ins = extractInscription(
      inscribe('video/mp4', [
        [1, 2, 3],
        [4, 5],
      ]),
    );
    expect(ins?.contentType).toBe('video/mp4');
    expect(Array.from(ins!.data)).toEqual([1, 2, 3, 4, 5]);
  });
  it('returns null without an envelope', () => {
    expect(extractInscription(new P2PKH().lock(PrivateKey.fromRandom().toAddress()))).toBeNull();
  });
  it('reads a pending tx out of the wallet BEEF', () => {
    const tx = new Transaction();
    tx.addOutput({ lockingScript: new P2PKH().lock(PrivateKey.fromRandom().toAddress()), satoshis: 5 });
    tx.addOutput({
      lockingScript: inscribe('image/png', [Array.from({ length: 1000 }, (_, i) => i % 256)]),
      satoshis: 1,
    });
    const beef = new Beef();
    beef.mergeRawTx(tx.toBinary());
    const ins = inscriptionFromBeef(beef.toBinary(), tx.id('hex'), 1);
    expect(ins?.contentType).toBe('image/png');
    expect(ins?.data.length).toBe(1000);
    expect(inscriptionFromBeef(beef.toBinary(), tx.id('hex'), 0)).toBeNull();
    expect(inscriptionFromBeef([1, 2, 3], tx.id('hex'), 1)).toBeNull();
  });
});

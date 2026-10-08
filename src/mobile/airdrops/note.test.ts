import { describe, expect, it } from 'vitest';
import { OP, Script, Utils } from '@bsv/sdk';
import { MAP_PREFIX } from '../feed/post';
import {
  NOTE_MAX,
  cleanNote,
  decodeNote,
  keptIssuers,
  noteForTx,
  noteOutput,
  noteScript,
  noteSegments,
  noteView,
  replyDraft,
  withExtraOutput,
} from './note';

const TOKEN = 'a'.repeat(64) + '_0';

describe('airdrop note encoding', () => {
  it('round-trips text and token id', () => {
    const hex = noteScript('gm holders! 🎉\nsecond line', TOKEN).toHex();
    expect(hex.startsWith('006a')).toBe(true);
    expect(decodeNote(hex)).toEqual({ text: 'gm holders! 🎉\nsecond line', tokenId: TOKEN });
  });
  it('round-trips without a token (NFT airdrops)', () => {
    expect(decodeNote(noteScript('hello').toHex())).toEqual({ text: 'hello' });
  });
  it('accepts exactly 280 code points (emoji count as one) and rejects 281', () => {
    const max = '🎉'.repeat(NOTE_MAX);
    expect(decodeNote(noteScript(max).toHex())?.text).toBe(max);
    expect(cleanNote(max + 'x')).toBeNull();
    expect(() => noteScript('x'.repeat(NOTE_MAX + 1))).toThrow();
  });
  it('rejects empty, non-string and control / bidi characters', () => {
    expect(cleanNote('   ')).toBeNull();
    expect(cleanNote(42)).toBeNull();
    expect(cleanNote('a\u0000b')).toBeNull();
    expect(cleanNote('evil‮txt.exe')).toBeNull();
    expect(cleanNote(' ok\r\nline ')).toBe('ok\nline');
  });
  it('rejects malformed input without throwing', () => {
    for (const bad of ['', 'zz', '6a', '76a914' + '00'.repeat(20) + '88ac', '006a' + 'ff'.repeat(10), null, undefined])
      expect(decodeNote(bad)).toBeNull();
  });
  it('ignores other MAP types and other apps', () => {
    const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
    for (const v of [MAP_PREFIX, 'SET', 'app', 'bChat', 'type', 'post']) s.writeBin(Utils.toArray(v, 'utf8'));
    expect(decodeNote(s.toHex())).toBeNull();
    const other = noteScript('hi')
      .toHex()
      .replace(Utils.toHex(Utils.toArray('bWalletX', 'utf8')), Utils.toHex(Utils.toArray('bWalletY', 'utf8')));
    expect(decodeNote(other)).toBeNull();
  });
  it('rejects a note whose B text is too long on chain', () => {
    const long = 'y'.repeat(NOTE_MAX + 5);
    const hex = noteScript('placeholder').toHex();
    const swapped = hex.replace(
      Utils.toHex(new Script().writeBin(Utils.toArray('placeholder', 'utf8')).toBinary()),
      Utils.toHex(new Script().writeBin(Utils.toArray(long, 'utf8')).toBinary()),
    );
    expect(decodeNote(swapped)).toBeNull();
  });
  it('links a note to the transfer by tx and token', () => {
    const vout = [{ script: '76a914' }, { script: noteScript('for you', TOKEN).toHex() }];
    expect(noteForTx(vout, { kind: 'token', id: TOKEN })?.text).toBe('for you');
    expect(noteForTx(vout, { kind: 'token', id: 'b'.repeat(64) + '_0' })).toBeNull();
    expect(noteForTx([{ script: noteScript('nft note').toHex() }], { kind: 'nft', id: 'x_1' })?.text).toBe('nft note');
    expect(noteForTx(undefined, { kind: 'nft', id: 'x' })).toBeNull();
  });
  it('builds a 0-sat output', () => {
    expect(noteOutput('hi', TOKEN)).toMatchObject({ satoshis: 0, outputDescription: 'Airdrop note' });
  });
});

describe('withExtraOutput', () => {
  it('appends the note to the first createAction only and keeps other methods bound', async () => {
    const calls: { outputs: unknown[] }[] = [];
    const wallet = {
      tag: 'w',
      async createAction(a: { outputs: unknown[] }) {
        calls.push(a);
        return { ok: true };
      },
      who() {
        return this.tag;
      },
    };
    const out = { lockingScript: '00', satoshis: 0, outputDescription: 'Airdrop note' };
    const w = withExtraOutput(wallet, out);
    await w.createAction({ outputs: [1, 2] });
    await w.createAction({ outputs: [3] });
    expect(calls[0].outputs).toEqual([1, 2, out]);
    expect(calls[1].outputs).toEqual([3]);
    expect(w.who()).toBe('w');
  });
});

describe('note rendering rules', () => {
  it('collapses notes from issuers you have not kept; links copyable only when kept', () => {
    expect(noteView('hello', { issuerKept: false })).toEqual({ collapsed: true, language: 'show', copyLinks: false });
    expect(noteView('hello', { issuerKept: true })).toMatchObject({ collapsed: false, copyLinks: true });
  });
  it('applies the language filter (store edition blurs strong language)', () => {
    expect(noteView('what the fuck', { issuerKept: true, store: true }).language).toBe('blur');
  });
  it('splits links out as plain segments (never HTML)', () => {
    const segs = noteSegments('visit https://evil.example/x now <b>hi</b>');
    expect(segs).toEqual([
      { text: 'visit ', link: false },
      { text: 'https://evil.example/x', link: true },
      { text: ' now <b>hi</b>', link: false },
    ]);
    expect(noteSegments('claim at scam.com today').some((s) => s.link && s.text === 'scam.com')).toBe(true);
  });
  it('reply draft and kept issuers', () => {
    expect(replyDraft('ACME')).toBe('Re: $ACME airdrop');
    expect(replyDraft(undefined)).toBe('Re: your airdrop');
    expect([
      ...keptIssuers(
        [
          { key: 'k1', issuer: 'i1' },
          { key: 'k2', issuer: 'i2' },
        ],
        ['k2'],
      ),
    ]).toEqual(['i2']);
  });
});

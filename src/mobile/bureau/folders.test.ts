import { describe, expect, test } from 'bun:test';
import type { AgreementPart } from './agreement';
import { countFolders, inFolder, listFolder, stateOf, statusLine, type AgreementItem } from './folders';

const ME = '02' + '1'.repeat(64);
const YOU = '03' + '2'.repeat(64);
const item = (o: {
  author?: string;
  signed?: string[];
  seal?: boolean;
  pdf?: boolean;
  archived?: boolean;
  at?: number;
  title?: string;
}): AgreementItem => ({
  part: {
    doc: {
      v: 1,
      id: `${o.at ?? 1}`.padStart(8, '0'),
      title: o.title ?? 'Doc',
      mime: o.pdf ? 'application/pdf' : 'text/plain',
      content: 'x',
      sha256: 'a'.repeat(64),
      author: o.author ?? ME,
      parties: [ME, YOU],
      createdAt: o.at ?? 1,
    },
    sigs: [],
    ...(o.seal ? { seal: { txid: 'b'.repeat(64), at: 1, by: ME } } : {}),
  } as AgreementPart,
  signed: o.signed ?? [],
  archived: !!o.archived,
});

describe('bureau folders', () => {
  test('state of an agreement', () => {
    const s = stateOf(item({ author: YOU, signed: [YOU] }), ME);
    expect(s).toMatchObject({ mine: false, needsMe: true, complete: false, sealed: false, waitingOn: [ME] });
    expect(statusLine(s)).toBe('Needs your signature');
    expect(statusLine(stateOf(item({ signed: [ME, YOU], seal: true }), ME))).toBe(
      'Signed by everyone · sealed on chain',
    );
  });

  test('folders are filters; Archive is exclusive; Trust and From bit-sign hold no agreements', () => {
    const it = item({ signed: [ME], pdf: true });
    expect(['all', 'sent', 'unsealed', 'signatures', 'media'].every((f) => inFolder(it, f as never, ME))).toBe(true);
    expect(['waiting', 'sealed', 'archive', 'trust', 'bitsign'].some((f) => inFolder(it, f as never, ME))).toBe(false);
    const arch = item({ archived: true });
    expect(inFolder(arch, 'all', ME)).toBe(false);
    expect(inFolder(arch, 'archive', ME)).toBe(true);
  });

  test('list: newest first, search by title; counts', () => {
    const items = [
      item({ at: 1, title: 'Old NDA' }),
      item({ at: 3, title: 'Contract', seal: true }),
      item({ at: 2, title: 'New NDA', archived: true }),
    ];
    expect(listFolder(items, 'all', ME).map((i) => i.part.doc.title)).toEqual(['Contract', 'Old NDA']);
    expect(listFolder(items, 'all', ME, 'nda').map((i) => i.part.doc.title)).toEqual(['Old NDA']);
    const c = countFolders(items, ME);
    expect([c.all, c.sealed, c.unsealed, c.archive, c.trust]).toEqual([2, 1, 1, 1, 0]);
  });
});

import { describe, expect, test } from 'bun:test';
import type { AgreementPart } from './agreement';
import {
  countFolders,
  firstFolder,
  folderOf,
  listFolder,
  stateOf,
  statusLine,
  timeline,
  type AgreementItem,
} from './folders';

const ME = '02' + '1'.repeat(64);
const YOU = '03' + '2'.repeat(64);
const item = (o: {
  author?: string;
  signed?: string[];
  seal?: boolean;
  archived?: boolean;
  at?: number;
  title?: string;
}): AgreementItem => ({
  part: {
    doc: {
      v: 1,
      id: `${o.at ?? 1}`.padStart(8, '0'),
      title: o.title ?? 'Doc',
      mime: 'text/plain',
      content: 'x',
      sha256: 'a'.repeat(64),
      author: o.author ?? ME,
      parties: [ME, YOU],
      createdAt: o.at ?? 1,
    },
    sigs: (o.signed ?? []).map((key, i) => ({ key, svgSha256: '', svgPath: '', at: 10 + i, sig: '' })),
    ...(o.seal ? { seal: { txid: 'b'.repeat(64), at: 99, by: ME } } : {}),
  } as AgreementPart,
  signed: o.signed ?? [],
  archived: !!o.archived,
});

describe('agreement folders', () => {
  test('state of an agreement', () => {
    const s = stateOf(item({ author: YOU, signed: [YOU] }), ME);
    expect(s).toMatchObject({ mine: false, needsMe: true, complete: false, sealed: false, waitingOn: [ME] });
    expect(statusLine(s)).toBe('Needs your signature');
    expect(statusLine(stateOf(item({ signed: [ME, YOU], seal: true }), ME))).toBe(
      'Signed by everyone · sealed on chain',
    );
  });

  test('every agreement is in exactly one folder', () => {
    expect(folderOf(item({ author: YOU }), ME)).toBe('needs');
    expect(folderOf(item({ signed: [ME] }), ME)).toBe('waiting');
    expect(folderOf(item({ signed: [ME, YOU] }), ME)).toBe('waiting');
    expect(folderOf(item({ signed: [ME, YOU], seal: true }), ME)).toBe('sealed');
    expect(folderOf(item({ seal: true, archived: true }), ME)).toBe('archive');
  });

  test('list: newest first, search by title; counts add up', () => {
    const items = [
      item({ at: 1, title: 'Old NDA', author: YOU }),
      item({ at: 3, title: 'Contract', seal: true }),
      item({ at: 2, title: 'New NDA', archived: true }),
      item({ at: 4, title: 'Lease', author: YOU }),
    ];
    expect(listFolder(items, 'needs', ME).map((i) => i.part.doc.title)).toEqual(['Lease', 'Old NDA']);
    expect(listFolder(items, 'needs', ME, 'nda').map((i) => i.part.doc.title)).toEqual(['Old NDA']);
    const c = countFolders(items, ME);
    expect(c).toEqual({ needs: 2, waiting: 0, sealed: 1, archive: 1 });
    expect(firstFolder(c)).toBe('needs');
    expect(firstFolder({ needs: 0, waiting: 0, sealed: 1, archive: 0 })).toBe('sealed');
  });

  test('timeline: sent, signed in order, still to sign, sealed', () => {
    const name = (k: string) => (k === ME ? 'you' : 'Ann');
    const t = timeline(item({ signed: [YOU, ME], seal: true }), name);
    expect(t.map((x) => x.label)).toEqual(['Sent by you', 'Signed by Ann', 'Signed by you', 'Sealed on chain']);
    expect(t[3].txid).toBe('b'.repeat(64));
    const open = timeline(item({ signed: [ME] }), name);
    expect(open.map((x) => [x.label, x.done])).toEqual([
      ['Sent by you', true],
      ['Signed by you', true],
      ['Signed by Ann', false],
      ['Sealed on chain', false],
    ]);
  });
});

import type { AgreementPart } from './agreement';

/**
 * bMail › Agreements folders (owner, 18 Oct 2026): four, each one place an agreement can be, so the counts add up.
 *   needs    I am a party and have not signed
 *   waiting  I signed (or don't sign); someone else still has to, or everyone has and it is not sealed yet
 *   sealed   the hashes-only receipt is on chain
 *   archive  put away by me (only here)
 */
export type FolderId = 'needs' | 'waiting' | 'sealed' | 'archive';

export const FOLDERS: { id: FolderId; label: string }[] = [
  { id: 'needs', label: 'Needs my signature' },
  { id: 'waiting', label: 'Waiting on others' },
  { id: 'sealed', label: 'Sealed' },
  { id: 'archive', label: 'Archive' },
];

export type AgreementItem = {
  part: AgreementPart;
  /** Keys whose signature verified. */
  signed: string[];
  archived: boolean;
};

export type ItemState = {
  mine: boolean;
  iSigned: boolean;
  needsMe: boolean;
  complete: boolean;
  sealed: boolean;
  waitingOn: string[];
};

export const stateOf = (it: AgreementItem, me: string): ItemState => {
  const { doc, seal } = it.part;
  const waitingOn = doc.parties.filter((p) => !it.signed.includes(p));
  const iSigned = it.signed.includes(me);
  return {
    mine: doc.author === me,
    iSigned,
    needsMe: doc.parties.includes(me) && !iSigned && !seal,
    complete: waitingOn.length === 0,
    sealed: !!seal,
    waitingOn,
  };
};

export const folderOf = (it: AgreementItem, me: string): FolderId => {
  if (it.archived) return 'archive';
  const s = stateOf(it, me);
  return s.sealed ? 'sealed' : s.needsMe ? 'needs' : 'waiting';
};

export const listFolder = (items: AgreementItem[], f: FolderId, me: string, q = ''): AgreementItem[] => {
  const text = q.trim().toLowerCase();
  return items
    .filter((it) => folderOf(it, me) === f && (!text || it.part.doc.title.toLowerCase().includes(text)))
    .sort((a, b) => b.part.doc.createdAt - a.part.doc.createdAt);
};

export const countFolders = (items: AgreementItem[], me: string): Record<FolderId, number> => {
  const c: Record<FolderId, number> = { needs: 0, waiting: 0, sealed: 0, archive: 0 };
  for (const it of items) c[folderOf(it, me)]++;
  return c;
};

/** The folder to open first: whatever needs me, else the first one with anything in it. */
export const firstFolder = (c: Record<FolderId, number>): FolderId =>
  (['needs', 'waiting', 'sealed'] as const).find((f) => c[f] > 0) ?? 'needs';

/** One line under the title, in words the record supports. */
export const statusLine = (s: ItemState): string =>
  s.sealed
    ? s.complete
      ? 'Signed by everyone · sealed on chain'
      : 'Sealed on chain'
    : s.complete
      ? 'Signed by everyone · ready to seal'
      : s.needsMe
        ? 'Needs your signature'
        : `Waiting on ${s.waitingOn.length} signature${s.waitingOn.length === 1 ? '' : 's'}`;

export type TimelineStep = { label: string; at: number | null; done: boolean; txid?: string };

/** sent → signed by each party (in signing order, then the ones still to sign) → sealed. */
export const timeline = (it: AgreementItem, name: (key: string) => string): TimelineStep[] => {
  const { doc, sigs, seal } = it.part;
  const ok = sigs.filter((s) => it.signed.includes(s.key)).sort((a, b) => a.at - b.at);
  const todo = doc.parties.filter((p) => !ok.some((s) => s.key === p));
  return [
    { label: `Sent by ${name(doc.author)}`, at: doc.createdAt, done: true },
    ...ok.map((s) => ({ label: `Signed by ${name(s.key)}`, at: s.at, done: true })),
    ...todo.map((k) => ({ label: `Signed by ${name(k)}`, at: null, done: false })),
    seal
      ? { label: 'Sealed on chain', at: seal.at, done: true, txid: seal.txid }
      : { label: 'Sealed on chain', at: null, done: false },
  ];
};

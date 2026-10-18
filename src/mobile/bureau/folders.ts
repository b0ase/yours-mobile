import type { AgreementPart } from './agreement';

/**
 * Bureau folders: views of bMail agreements by state (pure). A folder is a filter, not a place: one agreement can be
 * in Sent, Unsealed and Signatures at once. Archive is the only exclusive one (archived rows show only there).
 * Trust is shown but has nothing real behind it yet (bTrust), and "From bit-sign" lists the old bit-sign vault.
 */
export type FolderId =
  | 'all'
  | 'waiting'
  | 'sent'
  | 'unsealed'
  | 'sealed'
  | 'signatures'
  | 'media'
  | 'trust'
  | 'archive'
  | 'bitsign';

export const FOLDERS: { id: FolderId; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'waiting', label: 'Needs my signature' },
  { id: 'sent', label: 'Sent' },
  { id: 'unsealed', label: 'Unsealed' },
  { id: 'sealed', label: 'Sealed' },
  { id: 'signatures', label: 'Signatures' },
  { id: 'media', label: 'Media' },
  { id: 'trust', label: 'Trust' },
  { id: 'archive', label: 'Archive' },
  { id: 'bitsign', label: 'From bit-sign' },
];

/** Folders with nothing real behind them yet: the UI shows a "Coming to bWalletX" note, never sample rows. */
export const COMING_FOLDERS: ReadonlySet<FolderId> = new Set(['trust']);

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
  media: boolean;
  waitingOn: string[];
};

export const stateOf = (it: AgreementItem, me: string): ItemState => {
  const { doc, seal } = it.part;
  const waitingOn = doc.parties.filter((p) => !it.signed.includes(p));
  const iSigned = it.signed.includes(me);
  return {
    mine: doc.author === me,
    iSigned,
    needsMe: doc.parties.includes(me) && !iSigned,
    complete: waitingOn.length === 0,
    sealed: !!seal,
    media: doc.mime === 'application/pdf',
    waitingOn,
  };
};

export const inFolder = (it: AgreementItem, f: FolderId, me: string): boolean => {
  if (f === 'archive') return it.archived;
  if (it.archived || f === 'trust' || f === 'bitsign') return false;
  const s = stateOf(it, me);
  switch (f) {
    case 'all':
      return true;
    case 'waiting':
      return s.needsMe;
    case 'sent':
      return s.mine;
    case 'unsealed':
      return !s.sealed;
    case 'sealed':
      return s.sealed;
    case 'signatures':
      return s.iSigned;
    case 'media':
      return s.media;
  }
};

export const listFolder = (items: AgreementItem[], f: FolderId, me: string, q = ''): AgreementItem[] => {
  const text = q.trim().toLowerCase();
  return items
    .filter((it) => inFolder(it, f, me) && (!text || it.part.doc.title.toLowerCase().includes(text)))
    .sort((a, b) => b.part.doc.createdAt - a.part.doc.createdAt);
};

export const countFolders = (items: AgreementItem[], me: string): Record<FolderId, number> => {
  const c = Object.fromEntries(FOLDERS.map((f) => [f.id, 0])) as Record<FolderId, number>;
  for (const f of FOLDERS) c[f.id] = items.filter((it) => inFolder(it, f.id, me)).length;
  return c;
};

/** One line under the title, in words the record supports. */
export const statusLine = (s: ItemState): string =>
  s.sealed
    ? s.complete
      ? 'Signed by everyone · sealed on chain'
      : 'Sealed on chain'
    : s.complete
      ? 'Signed by everyone · not sealed yet'
      : s.needsMe
        ? 'Needs your signature'
        : `Waiting on ${s.waitingOn.length} signature${s.waitingOn.length === 1 ? '' : 's'}`;

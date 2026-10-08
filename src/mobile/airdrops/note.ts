/**
 * Airdrop notes (owner, 8 Oct 2026): "airdrops as messages from the issuer with a note".
 *
 * The note travels ON CHAIN in the same transaction as the transfer, as one extra 0-sat output, so any
 * wallet can read it (docs/LAUNCH-SOCIAL-PLAN.md §7.5):
 *
 *   OP_FALSE OP_RETURN
 *     19HxigV4QyBv3tHpQVcUEQyq1pzZVdoAut <note> text/plain utf-8      (B: the text)
 *     |
 *     1PuQa7K62MiKCtssSLKy1kh56WWU7MtUR5 SET app bWalletX type airdrop_note v 1
 *       [context bsv21 bsv21 <tokenId>]                               (MAP: what it is, which token)
 *
 * Link note → transfer: the same txid. No `context tx` (a tx can't name itself). Pure; no React.
 */
import { OP, Script, Utils } from '@bsv/sdk';
import { B_PREFIX, MAP_PREFIX, decodeScript } from '../feed/post';
import { languageOf, languageView } from '../feed/language';

export const NOTE_MAX = 280;
export const NOTE_APP = 'bWalletX';
export const NOTE_TYPE = 'airdrop_note';
export const NOTE_VERSION = '1';

export type AirdropNote = { text: string; tokenId?: string };

// C0/C1 controls except tab and newline, plus bidi overrides (spoofing) and zero-width joiners.
// eslint-disable-next-line no-control-regex
const BAD = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

/** Trimmed note text, or null when empty, too long (> 280 code points) or it carries control characters. */
export const cleanNote = (raw: unknown): string | null => {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\r\n?/g, '\n').trim();
  if (!t || [...t].length > NOTE_MAX || BAD.test(t)) return null;
  return t;
};

/** Characters left for the "Note to holders" field. */
export const noteCharsLeft = (raw: string) => NOTE_MAX - [...raw].length;

/** The OP_RETURN output script for a note. Throws on an invalid note (check with cleanNote first). */
export const noteScript = (note: string, tokenId?: string): Script => {
  const text = cleanNote(note);
  if (!text) throw new Error(`A note is 1–${NOTE_MAX} characters of plain text.`);
  const s = new Script().writeOpCode(OP.OP_FALSE).writeOpCode(OP.OP_RETURN);
  const push = (v: string) => s.writeBin(Utils.toArray(v, 'utf8'));
  push(B_PREFIX);
  push(text);
  push('text/plain');
  push('utf-8');
  push('|');
  push(MAP_PREFIX);
  push('SET');
  const kv: [string, string][] = [
    ['app', NOTE_APP],
    ['type', NOTE_TYPE],
    ['v', NOTE_VERSION],
  ];
  if (tokenId) kv.push(['context', 'bsv21'], ['bsv21', tokenId]);
  for (const [k, v] of kv) {
    push(k);
    push(v);
  }
  return s;
};

/** The extra createAction output for a note. */
export const noteOutput = (note: string, tokenId?: string) => ({
  lockingScript: noteScript(note, tokenId).toHex(),
  satoshis: 0,
  outputDescription: 'Airdrop note',
});

/** Decode one output script (hex). Null unless it is a well-formed airdrop note. Never throws. */
export const decodeNote = (hex: string | undefined | null): AirdropNote | null => {
  if (!hex || hex.length > 8000 || !/^(006a|6a)/i.test(hex)) return null;
  try {
    const d = decodeScript(Script.fromHex(hex));
    if (!d || d.MAP.type !== NOTE_TYPE || d.MAP.app !== NOTE_APP) return null;
    const b = d.B[0];
    if (!b || !/^text\/plain/i.test(b.mime)) return null;
    const text = cleanNote(Utils.toUTF8(b.content));
    if (!text) return null;
    const tokenId = d.MAP.context === 'bsv21' && d.MAP.bsv21 ? d.MAP.bsv21 : undefined;
    return tokenId ? { text, tokenId } : { text };
  } catch {
    return null;
  }
};

/**
 * The note for an airdrop of `assetId` in a tx: the first valid note output. A note naming a different
 * token is ignored (it is not about this airdrop).
 */
export const noteForTx = (
  vout: { script?: string }[] | undefined,
  asset: { kind: string; id: string },
): AirdropNote | null => {
  for (const o of vout ?? []) {
    const n = decodeNote(o.script);
    if (!n) continue;
    if (n.tokenId && asset.kind === 'token' && n.tokenId !== asset.id) continue;
    return n;
  }
  return null;
};

// ─── Rendering rules ─────────────────────────────────────────────────────────

export type NoteSegment = { text: string; link: boolean };

const URLISH =
  /(https?:\/\/[^\s]+|www\.[^\s]+|\b[a-z0-9-]+\.(?:com|net|org|io|app|xyz|online|space|website|co|me)\b[^\s]*)/gi;

/** Split note text into plain and link-looking segments (links are never clickable; see NoteView). */
export const noteSegments = (text: string): NoteSegment[] => {
  const out: NoteSegment[] = [];
  let last = 0;
  for (const m of text.matchAll(URLISH)) {
    const i = m.index ?? 0;
    if (i > last) out.push({ text: text.slice(last, i), link: false });
    out.push({ text: m[0], link: true });
    last = i + m[0].length;
  }
  if (last < text.length) out.push({ text: text.slice(last), link: false });
  return out;
};

export type NoteView = {
  /** Collapsed behind "Note from $x — show" (issuer not kept). */
  collapsed: boolean;
  /** Language filter: show / blur behind a tap / hidden for good (store, slurs). */
  language: 'show' | 'blur' | 'hide-final';
  /** Links render as plain, non-clickable text (always; copy only from a kept issuer). */
  copyLinks: boolean;
};

/** How to render a note: collapsed unless the issuer is kept, language-filtered, links never clickable. */
export const noteView = (text: string, opts: { issuerKept: boolean; store?: boolean }): NoteView => ({
  collapsed: !opts.issuerKept,
  language: languageView(languageOf(text), { store: opts.store }),
  copyLinks: opts.issuerKept,
});

/** "Re: $TOKEN airdrop" for Reply. */
export const replyDraft = (symbol: string | undefined) =>
  `Re: ${symbol ? `$${symbol.replace(/^\$/, '')}` : 'your'} airdrop`;

/** Issuers whose airdrops the user kept (the inbox's "known" set). */
export const keptIssuers = (items: { key: string; issuer: string }[], kept: string[]) => {
  const k = new Set(kept);
  return new Set(items.filter((i) => k.has(i.key)).map((i) => i.issuer));
};

/**
 * A wallet whose next createAction gets one extra output appended (the note), once. sendBsv21 (@1sat/actions)
 * has no extra-outputs option; it builds args with randomizeOutputs: false and calls wallet.createAction, so
 * the token outputs keep their indexes and the note sits last.
 */
export const withExtraOutput = <W extends object>(
  wallet: W,
  output: { lockingScript: string; satoshis: number; outputDescription: string },
): W => {
  let used = false;
  return new Proxy(wallet, {
    get(target, prop) {
      const v = Reflect.get(target, prop, target) as unknown;
      if (typeof v !== 'function') return v;
      if (prop !== 'createAction') return (v as (...a: unknown[]) => unknown).bind(target);
      return (args: { outputs?: unknown[] }, ...rest: unknown[]) => {
        const next = used ? args : { ...args, outputs: [...(args.outputs ?? []), output] };
        used = true;
        return (v as (...a: unknown[]) => unknown).call(target, next, ...rest);
      };
    },
  });
};

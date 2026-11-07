/**
 * Phone signing for bChatX / bit-sign (bit-sign docs/PHONE-SIGNING.md): a paired desktop page asks the phone to
 * draw a hand signature for a document, over the same sealed relay channel as the BRC-100 calls.
 *
 * - `bitsign.capabilities` → `{ drawSignature: true, oneApprovalSeal: true }` (oneApprovalSeal: the seal's sign and its
 *   payment are approved on ONE sheet, services/sealPass.ts; the site still makes the same two calls).
 * - `bitsign.drawSignature` → full-screen pad (BitsignHost) → `{ svg, width: 1000, height: 250 }`, or
 *   `{ code: ERR_PERMISSION_DENIED, message: 'declined' }` on Cancel / close.
 * - Review (owner, 7 Nov 2026): capabilities also say `review: true`; a page that sends `review: true` gets a Review
 *   button on the pad, which answers `{ action: 'review' }` (the page shows the document, then asks again). The
 *   drawing is kept for that page and document until the next ask (keepDrawing / takeKeptDrawing), never sent.
 *
 * Neither action touches keys, spends or broadcasts: the reply is only the drawing. The seal itself goes through
 * the normal createSignature / createAction approvals afterwards. Repeats of the same request id (relay reconnect)
 * are deduped by ReplyBook in sessions.ts: one pad, one answer.
 */
import { SIG_H, SIG_VIEWBOX, SIG_W, isValidSignature, type SigStroke } from '../signature/signature';
import { USER_DENIED_CODE } from '../../services/userDenied';
import { ONE_APPROVAL_SEAL } from '../../services/sealPass';
import { NATIVE_SEAL_ENABLED } from '../storeBuild';

import { BITSIGN_CAPABILITIES } from './bitsignCalls';
export { BITSIGN_CAPABILITIES, BITSIGN_DRAW, isBitsignAction } from './bitsignCalls';

export const TITLE_MAX = 120;
export const SHORT_MAX = 60;
export const SVG_MAX_BYTES = 200 * 1024;
export const DECLINED = 'declined';
export const BAD_REQUEST_CODE = 'INVALID_PARAMS';

export type DrawRequest = {
  title: string;
  docHash: string;
  ref: string;
  fieldLabel: string;
  signerHandle: string;
  origin: string;
  /** The page takes a Review answer ({ action: 'review' }). */
  review: boolean;
};

/** The pad's Review answer (ask resolves to it): the page shows the document, then asks again. */
export const DRAW_REVIEW: unique symbol = Symbol('bitsign.review');
export type DrawAnswer = string | null | typeof DRAW_REVIEW;

const HASH_RE = /^[0-9a-f]{64}$/;
// No control characters (newlines, bidi tricks) in anything we show.
// eslint-disable-next-line no-control-regex
const CTRL_RE = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max && !CTRL_RE.test(v);

/** Check a drawSignature request against the paired session's origin. A string is the reason it was refused. */
export const validateDrawRequest = (params: unknown, sessionOrigin: string): DrawRequest | string => {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return 'params must be an object';
  const p = params as Record<string, unknown>;
  if (typeof p.origin !== 'string' || p.origin !== sessionOrigin) return 'origin does not match the paired site';
  if (typeof p.docHash !== 'string' || !HASH_RE.test(p.docHash)) return 'docHash must be 64 lower-case hex';
  if (!text(p.title, TITLE_MAX)) return `title must be text of at most ${TITLE_MAX} characters`;
  for (const k of ['ref', 'fieldLabel', 'signerHandle'] as const)
    if (!text(p[k] ?? '', SHORT_MAX)) return `${k} must be text of at most ${SHORT_MAX} characters`;
  return {
    title: p.title,
    docHash: p.docHash,
    ref: (p.ref as string) ?? '',
    fieldLabel: (p.fieldLabel as string) ?? '',
    signerHandle: (p.signerHandle as string) ?? '',
    origin: p.origin,
    review: p.review === true,
  };
};

/** First 8 … last 8 of the hash, as shown on the sheet. */
export const shortHash = (h: string) => `${h.slice(0, 8)}…${h.slice(-8)}`;

/** The pad's path (signature.ts: M/L/Z integers in the 1000 × 250 box) → the strict SVG sent back. '' if invalid. */
export const signatureSvg = (svgPath: string): string =>
  isValidSignature(svgPath)
    ? `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${SIG_VIEWBOX}" width="${SIG_W}" height="${SIG_H}">` +
      `<path d="${svgPath}" fill="#1b2a5a"/></svg>`
    : '';

const ELEMENTS = new Set(['svg', 'g', 'path', 'polyline', 'line']);
const ATTRS = new Set([
  'xmlns',
  'viewBox',
  'width',
  'height',
  'd',
  'points',
  'x1',
  'y1',
  'x2',
  'y2',
  'fill',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
]);
const SVG_NS = 'http://www.w3.org/2000/svg';
const ATTR_RE = /\s+([A-Za-z][\w:-]*)="([^"<>&\\]*)"/y;
const BAD_VALUE_RE = /url\(|javascript:|data:/i;

/**
 * The strict rules bChatX checks (PHONE-SIGNING.md "The SVG is untrusted"), checked here before we send. Returns
 * null when the SVG passes, else the first rule it breaks. A small tokenizer, not a parser: anything it doesn't
 * recognise is a failure.
 */
export const checkStrictSvg = (svg: unknown): string | null => {
  if (typeof svg !== 'string' || !svg) return 'not a string';
  if (new TextEncoder().encode(svg).length > SVG_MAX_BYTES) return 'too large';
  if (svg.includes('&')) return 'entities are not allowed';
  const stack: string[] = [];
  let roots = 0;
  let i = 0;
  while (i < svg.length) {
    if (svg[i] !== '<') return 'text is not allowed';
    if (svg.startsWith('</', i)) {
      const m = /^<\/([a-z]+)>/.exec(svg.slice(i));
      if (!m || stack.pop() !== m[1]) return 'unbalanced tags';
      i += m[0].length;
      continue;
    }
    const m = /^<([A-Za-z][\w:-]*)/.exec(svg.slice(i));
    if (!m) return 'comments, CDATA, doctype and processing instructions are not allowed';
    const name = m[1];
    if (!ELEMENTS.has(name)) return `element <${name}> is not allowed`;
    if (name === 'svg' ? stack.length || roots++ : !stack.length) return 'exactly one root <svg> is required';
    i += m[0].length;
    const attrs = new Map<string, string>();
    for (;;) {
      ATTR_RE.lastIndex = i;
      const a = ATTR_RE.exec(svg);
      if (!a) break;
      if (!ATTRS.has(a[1])) return `attribute ${a[1]} is not allowed`;
      if (attrs.has(a[1])) return `duplicate attribute ${a[1]}`;
      if (BAD_VALUE_RE.test(a[2])) return 'attribute value is not allowed';
      attrs.set(a[1], a[2]);
      i = ATTR_RE.lastIndex;
    }
    if (attrs.has('xmlns') && (name !== 'svg' || attrs.get('xmlns') !== SVG_NS)) return 'bad xmlns';
    if (name === 'svg') {
      if (attrs.get('xmlns') !== SVG_NS) return 'root needs the SVG xmlns';
      if (attrs.get('width') !== String(SIG_W) || attrs.get('height') !== String(SIG_H))
        return `width and height must be ${SIG_W} and ${SIG_H}`;
    }
    if (svg.startsWith('/>', i)) i += 2;
    else if (svg[i] === '>') {
      stack.push(name);
      i += 1;
    } else return 'malformed tag';
  }
  if (stack.length || roots !== 1) return 'unbalanced tags';
  return null;
};

/** The pad request shown by BitsignHost; resolves to the pad's path, or null when declined. */
type Pending = { req: DrawRequest; resolve: (answer: DrawAnswer) => void };
let pending: Pending[] = [];
let answered = 0;
const listeners = new Set<() => void>();

/** Queue a pad for the user (one at a time, oldest first). */
export const askDrawSignature = (req: DrawRequest): Promise<DrawAnswer> =>
  new Promise((resolve) => {
    pending.push({ req, resolve });
    listeners.forEach((f) => f());
  });
export const currentDrawRequest = (): DrawRequest | null => pending[0]?.req ?? null;
/** Answer the request on screen (path from the pad, DRAW_REVIEW for Review, or null for Cancel / close). */
export const answerDrawRequest = (path: DrawAnswer) => {
  const [p, ...rest] = pending;
  if (!p) return;
  pending = rest;
  answered++;
  p.resolve(path);
  listeners.forEach((f) => f());
};
/** Changes with every answer, so the next pad starts empty (React key). */
export const drawRequestSeq = () => answered;
export const onDrawRequest = (f: () => void) => {
  listeners.add(f);
  return () => {
    listeners.delete(f);
  };
};

// The drawing kept over a Review: one slot, for one page and document, handed back once.
let kept: { key: string; strokes: SigStroke[] } | null = null;
const keptKey = (req: Pick<DrawRequest, 'origin' | 'docHash'>) => `${req.origin}\n${req.docHash}`;
export const keepDrawing = (req: DrawRequest, strokes: SigStroke[]) => {
  kept = strokes.length ? { key: keptKey(req), strokes } : null;
};
export const takeKeptDrawing = (req: Pick<DrawRequest, 'origin' | 'docHash'>): SigStroke[] | undefined => {
  if (!kept || kept.key !== keptKey(req)) return undefined;
  const { strokes } = kept;
  kept = null;
  return strokes;
};

export type BitsignReply = { result: unknown } | { error: { code: string; message: string } };

/** Handle one bitsign.* call from a paired site. `ask` shows the pad (tests pass their own). */
export async function handleBitsignCall(
  action: string,
  params: unknown,
  sessionOrigin: string,
  ask: (req: DrawRequest) => Promise<DrawAnswer> = askDrawSignature,
): Promise<BitsignReply> {
  if (action === BITSIGN_CAPABILITIES)
    return { result: { drawSignature: true, review: true, [ONE_APPROVAL_SEAL]: NATIVE_SEAL_ENABLED } };
  const req = validateDrawRequest(params, sessionOrigin);
  if (typeof req === 'string') return { error: { code: BAD_REQUEST_CODE, message: req } };
  const path = await ask(req);
  if (path === DRAW_REVIEW && req.review) return { result: { action: 'review' } };
  const svg = typeof path === 'string' && path ? signatureSvg(path) : '';
  if (!svg || checkStrictSvg(svg)) return { error: { code: USER_DENIED_CODE, message: DECLINED } };
  return { result: { svg, width: SIG_W, height: SIG_H } };
}

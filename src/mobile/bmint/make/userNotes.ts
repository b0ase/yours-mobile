/**
 * "Make your own note" (USER_NOTES_ENABLED, storeBuild.ts): user-made PoWNotes. Pure helpers + the bit-sign client.
 *
 * Flow: POST /api/bmint/render → safe SVG made by the server's generator (users never upload SVG) → the wallet inscribes
 * it with the user's OWN key (mint/mintMedia.ts: @1sat/actions inscribe + withFeeOutput + the issuer signature, MAP +
 * AIP by the identity-derived key) → POST /api/bmint/register {origin}. GET /api/bmint/notes?issuer= lists them.
 * The server is not built yet: 404 or a network error reads as "Not open yet".
 *
 * These are NOT official Mint notes (those are issued only by The Bitcoin Corporation Mint, notes/NotesPage.tsx).
 */
export const BMINT_API = 'https://www.bchatx.com';
export const NOT_OPEN = 'Not open yet';

export const USER_NOTE_TEMPLATES = [
  { id: 'classic', name: 'Classic' },
  { id: 'guilloche', name: 'Guilloché' },
  { id: 'modern', name: 'Modern' },
] as const;
export const USER_NOTE_COLOURWAYS = [
  { id: 'gold', name: 'Gold' },
  { id: 'emerald', name: 'Emerald' },
  { id: 'crimson', name: 'Crimson' },
  { id: 'midnight', name: 'Midnight' },
] as const;
export const USER_NOTE_FACES = [1, 5, 10, 20, 50, 100] as const;
export const MAX_SERIAL = 999_999;
export const MAX_TEXT = 40;
export const MAX_SVG_BYTES = 200_000;

export type UserNoteTemplate = (typeof USER_NOTE_TEMPLATES)[number]['id'];
export type UserNoteColourway = (typeof USER_NOTE_COLOURWAYS)[number]['id'];
export type RenderRequest = {
  template: string;
  serial: number;
  face: number;
  colourway: string;
  text?: string;
};

const has = <T extends { id: string }>(list: readonly T[], id: string) => list.some((t) => t.id === id);

/** null when the render request is valid, else a short message for the form. */
export function validateRender(r: RenderRequest): string | null {
  if (!has(USER_NOTE_TEMPLATES, r.template)) return 'Pick a template';
  if (!has(USER_NOTE_COLOURWAYS, r.colourway)) return 'Pick a colourway';
  if (!Number.isInteger(r.serial) || r.serial < 1 || r.serial > MAX_SERIAL)
    return `Serial must be a whole number from 1 to ${MAX_SERIAL}`;
  if (!(USER_NOTE_FACES as readonly number[]).includes(r.face)) return 'Pick a face value';
  if (r.text !== undefined) {
    if (r.text.length > MAX_TEXT) return `Text is at most ${MAX_TEXT} characters`;
    // Printable text only: no control characters or markup (the server renders it; keep the request plain).
    if ([...r.text].some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f || c === '<' || c === '>'))
      return 'Text can only use plain characters';
  }
  return null;
}

/** The request body sent to the server: trimmed text, omitted when empty. */
export function renderBody(r: RenderRequest): RenderRequest {
  const text = r.text?.trim();
  return {
    template: r.template,
    serial: r.serial,
    face: r.face,
    colourway: r.colourway,
    ...(text ? { text } : {}),
  };
}

/** A handle as MAP wants it: no '$', lower case, [a-z0-9._-]. null when it isn't one. */
export function normHandle(h: string | null | undefined): string | null {
  const s = (h ?? '').trim().replace(/^\$/, '').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s) ? s : null;
}

/** MAP for a user-made PoWNote: {app:"bmint", type:"pownote", issuer, serial, face}. All values strings. */
export function buildNoteMap(f: { issuer: string; serial: number; face: number }): Record<string, string> {
  const issuer = normHandle(f.issuer);
  if (!issuer) throw new Error('A $handle is needed to issue a note');
  if (!Number.isInteger(f.serial) || f.serial < 1 || f.serial > MAX_SERIAL) throw new Error('Bad serial');
  if (!(USER_NOTE_FACES as readonly number[]).includes(f.face)) throw new Error('Bad face value');
  return { app: 'bmint', type: 'pownote', issuer, serial: String(f.serial), face: String(f.face) };
}

/** The server's SVG, accepted only if it looks like one SVG document of sane size. Shown via <img> only. */
export function acceptSvg(svg: unknown): string | null {
  if (typeof svg !== 'string') return null;
  const s = svg.trim();
  if (!s || new TextEncoder().encode(s).length > MAX_SVG_BYTES) return null;
  if (!/^(<\?xml[^>]*\?>\s*)?<svg[\s>]/i.test(s) || !/<\/svg>$/i.test(s)) return null;
  return s;
}

export const svgToBase64 = (svg: string): string => {
  const bytes = new TextEncoder().encode(svg);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
};
export const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${svgToBase64(svg)}`;
export const svgBytes = (svg: string) => new TextEncoder().encode(svg).length;

export const isOrigin = (o: unknown): o is string => typeof o === 'string' && /^[0-9a-f]{64}_\d{1,6}$/i.test(o);

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: string };

/** fetch → JSON; 404 and network failures read as "Not open yet". */
async function call(path: string, init?: RequestInit, f: typeof fetch = fetch): Promise<ApiResult<unknown>> {
  let res: Response;
  try {
    res = await f(`${BMINT_API}${path}`, init);
  } catch {
    return { ok: false, error: NOT_OPEN };
  }
  if (res.status === 404) return { ok: false, error: NOT_OPEN };
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* not JSON */
  }
  if (!res.ok) {
    const msg = (body as { error?: unknown } | null)?.error;
    return { ok: false, error: typeof msg === 'string' && msg ? msg.slice(0, 200) : `Error ${res.status}` };
  }
  return { ok: true, value: body };
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export async function renderNote(r: RenderRequest, f?: typeof fetch): Promise<ApiResult<string>> {
  const bad = validateRender(r);
  if (bad) return { ok: false, error: bad };
  const res = await call('/api/bmint/render', json(renderBody(r)), f);
  if (!res.ok) return res;
  const svg = acceptSvg((res.value as { svg?: unknown } | null)?.svg);
  return svg ? { ok: true, value: svg } : { ok: false, error: 'The preview could not be read' };
}

export async function registerNote(origin: string, f?: typeof fetch): Promise<ApiResult<true>> {
  if (!isOrigin(origin)) return { ok: false, error: 'Bad origin' };
  const res = await call('/api/bmint/register', json({ origin }), f);
  return res.ok ? { ok: true, value: true } : res;
}

export type UserNote = { origin: string; serial?: number; face?: number; template?: string; colourway?: string };

export async function listNotes(issuer: string, f?: typeof fetch): Promise<ApiResult<UserNote[]>> {
  const h = normHandle(issuer);
  if (!h) return { ok: true, value: [] };
  const res = await call(`/api/bmint/notes?issuer=${encodeURIComponent(h)}`, undefined, f);
  if (!res.ok) return res;
  const raw = (res.value as { notes?: unknown } | null)?.notes ?? res.value;
  const list = Array.isArray(raw) ? raw : [];
  return {
    ok: true,
    value: list
      .filter((n): n is Record<string, unknown> => !!n && typeof n === 'object' && isOrigin((n as UserNote).origin))
      .map((n) => ({
        origin: n.origin as string,
        ...(typeof n.serial === 'number' && { serial: n.serial }),
        ...(typeof n.face === 'number' && { face: n.face }),
        ...(typeof n.template === 'string' && { template: n.template }),
        ...(typeof n.colourway === 'string' && { colourway: n.colourway }),
      })),
  };
}

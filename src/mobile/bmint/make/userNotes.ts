/**
 * "Make your own note" (USER_NOTES_ENABLED, storeBuild.ts): user-made PoWNotes. Pure helpers + the bit-sign client.
 *
 * Contract (bit-sign /api/bmint, owner 31 Oct 2026):
 *   1. POST /api/bmint/render {serial, face, title} (signed in) → {svg, map}. The server's generator makes the SVG
 *      (users never upload SVG); face (1000 | 10000 | 100000 | 1000000) also picks the colourway.
 *   2. The wallet inscribes EXACTLY that svg (image/svg+xml) with metaData = that map, signed with SIGMA on the same
 *      inscription output by the user's BAP signing key (mintUserNote.ts).
 *   3. POST /api/bmint/register {origin} (signed in) → {ok, note} or {error}.
 *   4. GET /api/bmint/notes?issuer= | ?origin= (public).
 * The server may not be deployed yet: 404 or a network error reads as "Not open yet".
 *
 * These are NOT official Mint notes (those are issued only by The Bitcoin Corporation Mint, notes/NotesPage.tsx).
 */
export const BMINT_API = 'https://www.bchatx.com';
export const NOT_OPEN = 'Not open yet';

/** Face values; each also selects the note's colourway on the server. */
export const USER_NOTE_FACES = [1_000, 10_000, 100_000, 1_000_000] as const;
export type UserNoteFace = (typeof USER_NOTE_FACES)[number];
export const MAX_SERIAL = 999_999;
export const MAX_TITLE = 18;
export const TITLE_RE = /^[A-Z0-9 .'!-]*$/;
export const MAX_SVG_BYTES = 200_000;

export type RenderRequest = { serial: number; face: number; title: string };
export type NoteMap = {
  app: 'bmint';
  type: 'pownote';
  issuer: string;
  serial: string;
  face: string;
  title: string;
};
export type Rendered = { svg: string; map: NoteMap };

/** A whole serial from 1 to MAX_SERIAL. */
const okSerial = (n: number) => Math.floor(n) === n && n >= 1 && n <= MAX_SERIAL;
const okFace = (n: number): n is UserNoteFace => (USER_NOTE_FACES as readonly number[]).includes(n);

/** What the title box keeps as you type: upper case, allowed characters only, at most MAX_TITLE. */
export const cleanTitleInput = (t: string): string =>
  t
    .toUpperCase()
    .replace(/[^A-Z0-9 .'!-]/g, '')
    .slice(0, MAX_TITLE);

/** null when the title is valid, else a short message. */
export function validateTitle(t: string): string | null {
  if (!t.trim()) return 'Give the note a title';
  if (t.length > MAX_TITLE) return `Title is at most ${MAX_TITLE} characters`;
  if (!TITLE_RE.test(t)) return "Title can use A-Z, 0-9, space and . ' ! - only";
  return null;
}

/** null when the render request is valid, else a short message for the form. */
export function validateRender(r: RenderRequest): string | null {
  if (!okSerial(r.serial)) return `Serial must be a whole number from 1 to ${MAX_SERIAL}`;
  if (!okFace(r.face)) return 'Pick a face value';
  return validateTitle(r.title);
}

/** The request body sent to the server: exactly {serial, face, title}, title trimmed. */
export const renderBody = (r: RenderRequest): RenderRequest => ({
  serial: r.serial,
  face: r.face,
  title: r.title.trim(),
});

/** A handle as MAP wants it: no '$', lower case, [a-z0-9._-]. null when it isn't one. */
export function normHandle(h: string | null | undefined): string | null {
  const s = (h ?? '').trim().replace(/^\$/, '').toLowerCase();
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(s) ? s : null;
}

/**
 * The server's MAP, accepted only if it is exactly {app:"bmint", type:"pownote", issuer, serial, face, title} and
 * matches what we asked for and who we are. It is inscribed as given (never rebuilt), so the server's byte check holds.
 */
export function acceptMap(raw: unknown, want: { issuer: string | null; req: RenderRequest }): NoteMap | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  const keys = Object.keys(m).sort().join(',');
  if (keys !== 'app,face,issuer,serial,title,type') return null;
  if (!Object.values(m).every((v) => typeof v === 'string')) return null;
  const map = m as NoteMap;
  if (map.app !== 'bmint' || map.type !== 'pownote') return null;
  if (map.serial !== String(want.req.serial) || map.face !== String(want.req.face)) return null;
  if (map.title !== want.req.title.trim().replace(/\s+/g, ' ') || validateTitle(map.title)) return null;
  if (!normHandle(map.issuer) || (want.issuer && normHandle(map.issuer) !== want.issuer)) return null;
  return { app: map.app, type: map.type, issuer: map.issuer, serial: map.serial, face: map.face, title: map.title };
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

/** POST JSON, with the bChatX session bearer when there is one (render and register need sign-in). */
const json = (body: unknown, token?: string | null): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
  credentials: 'omit',
});

export const SIGN_IN = 'Sign in to bChatX first';

export async function renderNote(
  r: RenderRequest,
  auth: { token: string | null; issuer: string | null },
  f?: typeof fetch,
): Promise<ApiResult<Rendered>> {
  const bad = validateRender(r);
  if (bad) return { ok: false, error: bad };
  if (!auth.token) return { ok: false, error: SIGN_IN };
  const res = await call('/api/bmint/render', json(renderBody(r), auth.token), f);
  if (!res.ok) return res;
  const v = res.value as { svg?: unknown; map?: unknown } | null;
  const svg = acceptSvg(v?.svg);
  const map = acceptMap(v?.map, { issuer: auth.issuer, req: r });
  if (!svg) return { ok: false, error: 'The preview could not be read' };
  if (!map) return { ok: false, error: 'The server sent an unexpected note record' };
  return { ok: true, value: { svg, map } };
}

export async function registerNote(origin: string, token: string | null, f?: typeof fetch): Promise<ApiResult<true>> {
  if (!isOrigin(origin)) return { ok: false, error: 'Bad origin' };
  if (!token) return { ok: false, error: SIGN_IN };
  const res = await call('/api/bmint/register', json({ origin }, token), f);
  return res.ok ? { ok: true, value: true } : res;
}

export type UserNote = { origin: string; issuer: string; serial?: number; face?: number; title?: string };

/** Public list: by issuer ($handle) or by one origin. */
export async function listNotes(
  q: { issuer: string } | { origin: string },
  f?: typeof fetch,
): Promise<ApiResult<UserNote[]>> {
  let query: string;
  if ('origin' in q) {
    if (!isOrigin(q.origin)) return { ok: true, value: [] };
    query = `origin=${encodeURIComponent(q.origin.toLowerCase())}`;
  } else {
    const h = normHandle(q.issuer);
    if (!h) return { ok: true, value: [] };
    query = `issuer=${encodeURIComponent(h)}`;
  }
  const res = await call(`/api/bmint/notes?${query}`, undefined, f);
  if (!res.ok) return res;
  const raw = (res.value as { notes?: unknown } | null)?.notes;
  const list = Array.isArray(raw) ? raw : [];
  return {
    ok: true,
    value: list
      .filter(
        (n): n is Record<string, unknown> =>
          !!n && typeof n === 'object' && isOrigin((n as UserNote).origin) && !!normHandle((n as UserNote).issuer),
      )
      .map((n) => ({
        origin: n.origin as string,
        issuer: normHandle(n.issuer as string)!,
        ...(typeof n.serial === 'number' && { serial: n.serial }),
        ...(typeof n.face === 'number' && { face: n.face }),
        ...(typeof n.title === 'string' && { title: n.title }),
      })),
  };
}

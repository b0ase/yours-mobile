import { describe, expect, test } from 'bun:test';
import {
  acceptMap,
  acceptSvg,
  cleanTitleInput,
  listNotes,
  normHandle,
  NOT_OPEN,
  registerNote,
  renderBody,
  renderNote,
  SIGN_IN,
  svgDataUrl,
  USER_NOTE_FACES,
  validateRender,
  validateTitle,
} from './userNotes';

const ok = { serial: 1, face: 10_000, title: 'HELLO' };
const auth = { token: 't', issuer: 'b0asex' };
const map = { app: 'bmint', type: 'pownote', issuer: 'b0asex', serial: '1', face: '10000', title: 'HELLO' };
const TXID = 'a'.repeat(64);
type Seen = { url?: string; init?: RequestInit };
const fake = (status: number, body: unknown, seen: Seen = {}): typeof fetch =>
  (async (url: string, init?: RequestInit) => {
    seen.url = url;
    seen.init = init;
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;

describe('face options', () => {
  test('exactly the four server faces', () => expect([...USER_NOTE_FACES]).toEqual([1000, 10000, 100000, 1000000]));
  test.each([1, 5, 20, 100, 10, 999])('rejects face %d', (face) =>
    expect(validateRender({ ...ok, face })).not.toBeNull(),
  );
  test.each([...USER_NOTE_FACES])('accepts face %d', (face) => expect(validateRender({ ...ok, face })).toBeNull());
});

describe('title validation', () => {
  test('accepts the allowed set up to 18', () => {
    expect(validateTitle("IT'S A NOTE! 1-2.")).toBeNull();
    expect(validateTitle('X'.repeat(18))).toBeNull();
  });
  test.each(['', '   ', 'X'.repeat(19), 'hello', 'A<B', 'A_B', 'Ä', 'A\nB'])('rejects %p', (t) =>
    expect(validateTitle(t)).not.toBeNull(),
  );
  test('input cleaner upper-cases, strips and caps at 18', () => {
    expect(cleanTitleInput('hello <world>!')).toBe('HELLO WORLD!');
    expect(cleanTitleInput('a'.repeat(30))).toBe('A'.repeat(18));
  });
  test('serial bounds', () => {
    expect(validateRender({ ...ok, serial: 0 })).not.toBeNull();
    expect(validateRender({ ...ok, serial: 1_000_000 })).not.toBeNull();
    expect(validateRender({ ...ok, serial: 1.5 })).not.toBeNull();
  });
  test('body is exactly {serial, face, title}', () =>
    expect(renderBody({ ...ok, title: ' HELLO ' })).toEqual({ serial: 1, face: 10_000, title: 'HELLO' }));
});

describe('MAP from the server', () => {
  const want = { issuer: 'b0asex', req: ok };
  test('accepted as given', () => expect(acceptMap(map, want)).toEqual(map));
  test.each([
    [{ ...map, app: 'x' }],
    [{ ...map, type: 'x' }],
    [{ ...map, serial: '2' }],
    [{ ...map, face: '1000' }],
    [{ ...map, title: 'OTHER' }],
    [{ ...map, issuer: 'someoneelse' }],
    [{ ...map, extra: 'x' }],
    [{ ...map, serial: 1 }],
    [{ app: 'bmint', type: 'pownote' }],
    [null],
    [[]],
  ])('rejects %o', (m) => expect(acceptMap(m, want)).toBeNull());
  test('normHandle', () => {
    expect(normHandle('$Rich')).toBe('rich');
    expect(normHandle(null)).toBeNull();
  });
});

describe('acceptSvg', () => {
  test('takes one SVG document', () => {
    expect(acceptSvg('<svg xmlns="http://www.w3.org/2000/svg"></svg>')).toBeTruthy();
    expect(acceptSvg('<?xml version="1.0"?><svg></svg>')).toBeTruthy();
  });
  test('refuses non-SVG, empty, huge or non-string', () => {
    expect(acceptSvg('<html></html>')).toBeNull();
    expect(acceptSvg('')).toBeNull();
    expect(acceptSvg(5)).toBeNull();
    expect(acceptSvg(`<svg>${'x'.repeat(200_001)}</svg>`)).toBeNull();
  });
  test('data URL is base64 image/svg+xml', () => {
    expect(svgDataUrl('<svg></svg>')).toBe(`data:image/svg+xml;base64,${btoa('<svg></svg>')}`);
  });
});

describe('API client', () => {
  test('404 and network errors read as Not open yet', async () => {
    expect(await renderNote(ok, auth, fake(404, {}))).toEqual({ ok: false, error: NOT_OPEN });
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await registerNote(`${TXID}_0`, 't', down)).toEqual({ ok: false, error: NOT_OPEN });
    expect(await listNotes({ issuer: 'me' }, down)).toEqual({ ok: false, error: NOT_OPEN });
  });
  test('render sends bearer + exact body, returns svg and map', async () => {
    const seen: Seen = {};
    const r = await renderNote(ok, auth, fake(200, { svg: '<svg></svg>', map }, seen));
    expect(r).toEqual({ ok: true, value: { svg: '<svg></svg>', map } });
    expect(seen.url).toBe('https://www.bchatx.com/api/bmint/render');
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe('Bearer t');
    expect(JSON.parse(seen.init?.body as string)).toEqual({ serial: 1, face: 10000, title: 'HELLO' });
  });
  test('render refuses a mismatched map; needs sign-in; invalid input never calls', async () => {
    expect((await renderNote(ok, auth, fake(200, { svg: '<svg></svg>', map: { ...map, face: '1' } }))).ok).toBe(false);
    expect(await renderNote(ok, { token: null, issuer: null })).toEqual({ ok: false, error: SIGN_IN });
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    expect((await renderNote({ ...ok, face: 3 }, auth, spy)).ok).toBe(false);
    expect(called).toBe(false);
  });
  test('register shows the server reason; rejects a bad origin', async () => {
    expect(await registerNote(`${TXID}_0`, 't', fake(200, { ok: true, note: {} }))).toEqual({ ok: true, value: true });
    expect(await registerNote(`${TXID}_0`, 't', fake(402, { error: 'It was not signed by your wallet.' }))).toEqual({
      ok: false,
      error: 'It was not signed by your wallet.',
    });
    expect((await registerNote('nope', 't')).ok).toBe(false);
    expect(await registerNote(`${TXID}_0`, null)).toEqual({ ok: false, error: SIGN_IN });
  });
  test('list by issuer or origin keeps only well-formed notes', async () => {
    const seen: Seen = {};
    const r = await listNotes(
      { issuer: '$Me' },
      fake(
        200,
        { notes: [{ origin: `${TXID}_0`, issuer: 'me', serial: 1, title: 'HI' }, { origin: 'x' }, null] },
        seen,
      ),
    );
    expect(r).toEqual({ ok: true, value: [{ origin: `${TXID}_0`, issuer: 'me', serial: 1, title: 'HI' }] });
    expect(seen.url).toContain('/api/bmint/notes?issuer=me');
    await listNotes({ origin: `${TXID}_0` }, fake(200, { notes: [] }, seen));
    expect(seen.url).toContain(`/api/bmint/notes?origin=${TXID}_0`);
  });
});

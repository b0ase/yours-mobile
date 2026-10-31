import { describe, expect, test } from 'bun:test';
import {
  acceptSvg,
  buildNoteMap,
  listNotes,
  normHandle,
  NOT_OPEN,
  registerNote,
  renderBody,
  renderNote,
  svgDataUrl,
  validateRender,
} from './userNotes';

const ok = { template: 'classic', colourway: 'gold', serial: 1, face: 10 };
const TXID = 'a'.repeat(64);
const fake = (status: number, body: unknown): typeof fetch =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('buildNoteMap', () => {
  test('builds the PoWNote MAP with string values', () => {
    expect(buildNoteMap({ issuer: '$B0aseX', serial: 42, face: 20 })).toEqual({
      app: 'bmint',
      type: 'pownote',
      issuer: 'b0asex',
      serial: '42',
      face: '20',
    });
  });
  test('rejects a missing handle, bad serial and bad face', () => {
    expect(() => buildNoteMap({ issuer: '', serial: 1, face: 1 })).toThrow();
    expect(() => buildNoteMap({ issuer: 'a b', serial: 1, face: 1 })).toThrow();
    expect(() => buildNoteMap({ issuer: 'me', serial: 0, face: 1 })).toThrow();
    expect(() => buildNoteMap({ issuer: 'me', serial: 1.5, face: 1 })).toThrow();
    expect(() => buildNoteMap({ issuer: 'me', serial: 1, face: 3 })).toThrow();
  });
  test('normHandle', () => {
    expect(normHandle('$Rich')).toBe('rich');
    expect(normHandle(null)).toBeNull();
    expect(normHandle('$')).toBeNull();
  });
});

describe('validateRender / renderBody', () => {
  test('accepts a good request', () => expect(validateRender(ok)).toBeNull());
  test.each([
    [{ ...ok, template: 'x' }],
    [{ ...ok, colourway: 'x' }],
    [{ ...ok, serial: 0 }],
    [{ ...ok, serial: 1_000_000 }],
    [{ ...ok, face: 7 }],
    [{ ...ok, text: 'x'.repeat(41) }],
    [{ ...ok, text: '<script>' }],
    [{ ...ok, text: 'a\nb' }],
  ])('rejects %o', (r) => expect(validateRender(r)).not.toBeNull());
  test('trims text and drops it when empty', () => {
    expect(renderBody({ ...ok, text: '  hi ' })).toEqual({ ...ok, text: 'hi' });
    expect(renderBody({ ...ok, text: '   ' })).toEqual(ok);
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
    expect(await renderNote(ok, fake(404, {}))).toEqual({ ok: false, error: NOT_OPEN });
    const down = (async () => {
      throw new Error('offline');
    }) as unknown as typeof fetch;
    expect(await registerNote(`${TXID}_0`, down)).toEqual({ ok: false, error: NOT_OPEN });
    expect(await listNotes('me', down)).toEqual({ ok: false, error: NOT_OPEN });
  });
  test('render returns the SVG; invalid input never calls the server', async () => {
    expect(await renderNote(ok, fake(200, { svg: '<svg></svg>' }))).toEqual({ ok: true, value: '<svg></svg>' });
    let called = false;
    const spy = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    expect((await renderNote({ ...ok, face: 3 }, spy)).ok).toBe(false);
    expect(called).toBe(false);
  });
  test('register passes server errors through; rejects a bad origin', async () => {
    expect(await registerNote(`${TXID}_0`, fake(200, { registered: true }))).toEqual({ ok: true, value: true });
    expect(await registerNote(`${TXID}_0`, fake(409, { error: 'Already registered' }))).toEqual({
      ok: false,
      error: 'Already registered',
    });
    expect((await registerNote('nope')).ok).toBe(false);
  });
  test('list keeps only well-formed notes', async () => {
    const r = await listNotes('me', fake(200, { notes: [{ origin: `${TXID}_0`, serial: 1 }, { origin: 'x' }, null] }));
    expect(r).toEqual({ ok: true, value: [{ origin: `${TXID}_0`, serial: 1 }] });
  });
});

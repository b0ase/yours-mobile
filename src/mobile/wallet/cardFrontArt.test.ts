import { describe, expect, test } from 'bun:test';
import {
  ART_ZOOM,
  cardFrontArtUri,
  PLACE_MAX,
  PLACE_MIN,
  artStyle,
  autoBrightness,
  clampLook,
  defaultPlacement,
  loadCardArtLook,
  saveCardArtLook,
} from './cardFrontArt';
import { bavatarSvg } from '../bavatar/bavatar';

const A = '02' + 'a1'.repeat(32);
const B = '03' + 'b2'.repeat(32);

describe('cardFrontArtUri', () => {
  test('bWalletX: the account bAvatar art, seeded by the identity key', () => {
    const uri = cardFrontArtUri(A, false);
    expect(uri.startsWith('data:image/svg+xml')).toBe(true);
    expect(decodeURIComponent(uri.split(',')[1])).toBe(bavatarSvg(A, { size: 512, label: '' }));
  });
  test('different accounts get different art; same account is cached and stable', () => {
    expect(cardFrontArtUri(A, false)).not.toBe(cardFrontArtUri(B, false));
    expect(cardFrontArtUri(A.toUpperCase(), false)).toBe(cardFrontArtUri(A, false));
  });
  test('bWallet edition keeps the yellow card', () => {
    expect(cardFrontArtUri(A, true)).toBe('');
  });
  test('no identity key: no art', () => {
    expect(cardFrontArtUri(undefined, false)).toBe('');
    expect(cardFrontArtUri('alice', false)).toBe('');
  });
});

describe('card art look', () => {
  test('bright art is dimmed toward the calm level; dim art is left alone', () => {
    expect(autoBrightness(0.52)).toBeCloseTo(0.5, 3);
    expect(autoBrightness(0.1)).toBe(1);
    expect(autoBrightness(5)).toBe(0.3);
    expect(autoBrightness(null)).toBe(0.8);
  });
  test('default placement is seeded and sits top-right, within range', () => {
    const p = defaultPlacement(A);
    expect(defaultPlacement(A)).toEqual(p);
    expect(p.x).toBeGreaterThan(55);
    expect(p.x).toBeLessThanOrEqual(PLACE_MAX);
    expect(p.y).toBeGreaterThanOrEqual(PLACE_MIN);
    expect(p.y).toBeLessThan(50);
  });
  test('artStyle puts the art centre where asked, with no edge showing', () => {
    const st = artStyle({ brightness: 0.5, x: 70, y: 30 });
    const [ox, oy] = st.transformOrigin.split(' ').map(parseFloat);
    expect(ox + ART_ZOOM * (50 - ox)).toBeCloseTo(70, 1);
    expect(oy + ART_ZOOM * (50 - oy)).toBeCloseTo(30, 1);
    expect(st.filter).toBe('brightness(0.500)');
    // Out of range is clamped: the art still covers the card.
    const edge = artStyle({ brightness: 2, x: 100, y: 0 });
    const [ex] = edge.transformOrigin.split(' ').map(parseFloat);
    expect(ex + ART_ZOOM * (0 - ex)).toBeLessThanOrEqual(0.01);
    expect(edge.filter).toBe('brightness(1.000)');
  });
  test('clampLook keeps brightness <= 1 so the shade contrast holds', () => {
    expect(clampLook({ brightness: 3, x: -5, y: 500 })).toEqual({ brightness: 1, x: PLACE_MIN, y: PLACE_MAX });
  });
  test('saved per identity key; reset removes it', () => {
    const mem = new Map<string, string>();
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => void mem.set(k, v),
      removeItem: (k: string) => void mem.delete(k),
    };
    expect(loadCardArtLook(A)).toBeNull();
    saveCardArtLook(A, { brightness: 0.5, x: 60, y: 40 });
    expect(loadCardArtLook(A)).toEqual({ brightness: 0.5, x: 60, y: 40 });
    expect(loadCardArtLook(B)).toBeNull();
    saveCardArtLook(A, null);
    expect(loadCardArtLook(A)).toBeNull();
  });
});

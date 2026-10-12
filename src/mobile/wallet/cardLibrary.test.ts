import { afterEach, describe, expect, test } from 'bun:test';
import {
  CARD_LIBRARY_MAX,
  addPicture,
  loadCardLibrary,
  pictureId,
  removePicture,
  saveCardLibrary,
  selectedPictureId,
  type CardPicture,
} from './cardLibrary';

const A = '02' + 'a1'.repeat(32);
const pic = (n: number) => 'data:image/jpeg;base64,' + 'x'.repeat(n);

const memStore = (quota = Infinity) => {
  const m = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => {
      if (v.length > quota) throw new Error('QuotaExceededError');
      m.set(k, v);
    },
    removeItem: (k: string) => void m.delete(k),
  };
  return m;
};
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe('card picture library', () => {
  test('starts empty', () => {
    memStore();
    expect(loadCardLibrary(A)).toEqual([]);
    expect(loadCardLibrary(null)).toEqual([]);
  });
  test('add puts the newest first and de-duplicates', () => {
    let l: CardPicture[] = [];
    l = addPicture(l, pic(1));
    l = addPicture(l, pic(2));
    l = addPicture(l, pic(1));
    expect(l.map((p) => p.uri)).toEqual([pic(1), pic(2)]);
    expect(l[0].id).toBe(pictureId(pic(1)));
  });
  test('caps the count, dropping the oldest', () => {
    let l: CardPicture[] = [];
    for (let i = 1; i <= CARD_LIBRARY_MAX + 3; i++) l = addPicture(l, pic(i));
    expect(l.length).toBe(CARD_LIBRARY_MAX);
    expect(l[0].uri).toBe(pic(CARD_LIBRARY_MAX + 3));
    expect(l.some((p) => p.uri === pic(1))).toBe(false);
  });
  test('remove takes one picture out', () => {
    const l = addPicture(addPicture([], pic(1)), pic(2));
    expect(removePicture(l, pictureId(pic(2))).map((p) => p.uri)).toEqual([pic(1)]);
  });
  test('select finds the picture now on the card', () => {
    const l = addPicture(addPicture([], pic(1)), pic(2));
    expect(selectedPictureId(l, pic(1))).toBe(pictureId(pic(1)));
    expect(selectedPictureId(l, pic(9))).toBeNull();
    expect(selectedPictureId(l, null)).toBeNull();
  });
  test('saves and loads per account; ignores junk', () => {
    const m = memStore();
    const l = addPicture([], pic(3));
    expect(saveCardLibrary(A, l)).toEqual(l);
    expect(loadCardLibrary(A.toUpperCase())).toEqual(l);
    m.set('bw-card-lib:' + A, JSON.stringify([{ id: 'x', uri: 'javascript:1' }, 5]));
    expect(loadCardLibrary(A)).toEqual([]);
  });
  test('out of room: drops oldest pictures until it fits', () => {
    memStore(250);
    let l: CardPicture[] = [];
    for (let i = 1; i <= 4; i++) l = addPicture(l, pic(100 + i));
    const saved = saveCardLibrary(A, l);
    expect(saved?.length).toBe(1);
    expect(saved?.[0].uri).toBe(pic(104));
    expect(saveCardLibrary(A, [{ id: 'big', uri: pic(1000) }])).toBeNull();
  });
});

import { describe, expect, test } from 'bun:test';
import type { MediaItem } from '../media/useWalletMedia';
import { captureVideoFrame, cardNftChoices, isCardVideoType } from './cardVideoFrame';
import { addPicture } from './cardLibrary';

const item = (type: string, extra: Partial<MediaItem> = {}): MediaItem =>
  ({
    output: { outpoint: `${type}_0`, satoshis: 1, spendable: true },
    name: type,
    type,
    kind: type.startsWith('video/') ? 'video' : type.startsWith('image/') ? 'images' : 'other',
    origin: `${type}_0`,
    url: 'https://x/' + type,
    flagged: false,
    ...extra,
  }) as MediaItem;

describe('cardNftChoices', () => {
  test('a wallet with only video NFTs still offers them', () => {
    const got = cardNftChoices([item('video/mp4'), item('video/webm', { pending: true })]);
    expect(got.map((i) => i.type)).toEqual(['video/mp4', 'video/webm']);
  });
  test('pictures yes; SVG, HTML, audio, flagged and pending pictures no', () => {
    const got = cardNftChoices([
      item('image/png'),
      item('image/svg+xml'),
      item('text/html'),
      item('audio/mpeg'),
      item('image/jpeg', { flagged: true }),
      item('video/mp4', { flagged: true }),
      item('image/webp', { pending: true }),
    ]);
    expect(got.map((i) => i.type)).toEqual(['image/png']);
  });
  test('video types', () => {
    expect(isCardVideoType('video/mp4; codecs=avc1')).toBe(true);
    expect(isCardVideoType('video/x-unknown')).toBe(false);
    expect(isCardVideoType(undefined)).toBe(false);
  });
});

const mockDoc = (opts: { taint?: boolean; noCtx?: boolean } = {}) => {
  const calls: string[] = [];
  const canvas = {
    width: 0,
    height: 0,
    getContext: () =>
      opts.noCtx
        ? null
        : {
            fillStyle: '',
            fillRect: () => calls.push('fill'),
            drawImage: (_v: unknown, x: number, y: number, w: number, h: number) =>
              calls.push(`draw ${x},${y},${w}x${h}`),
          },
    toDataURL: (type: string) => {
      if (opts.taint) throw new Error('SecurityError');
      return `data:${type};base64,AAA`;
    },
  };
  return { doc: { createElement: () => canvas } as unknown as Document, canvas, calls };
};

describe('captureVideoFrame', () => {
  const video = (w: number, h: number) => ({ videoWidth: w, videoHeight: h }) as unknown as HTMLVideoElement;
  test('draws the current frame resized to fit and returns a JPEG', () => {
    const { doc, canvas, calls } = mockDoc();
    expect(captureVideoFrame(video(1920, 1080), 900, 0.8, doc)).toBe('data:image/jpeg;base64,AAA');
    expect([canvas.width, canvas.height]).toEqual([900, 506]);
    expect(calls).toEqual(['fill', 'draw 0,0,900x506']);
  });
  test('no frame yet, no canvas, tainted canvas: plain errors', () => {
    expect(() => captureVideoFrame(video(0, 0), 900, 0.8, mockDoc().doc)).toThrow('hasn’t shown a frame');
    expect(() => captureVideoFrame(video(10, 10), 900, 0.8, mockDoc({ noCtx: true }).doc)).toThrow('can’t make');
    expect(() => captureVideoFrame(video(10, 10), 900, 0.8, mockDoc({ taint: true }).doc)).toThrow('can’t be copied');
  });
  test('the frame lands in My pictures with its source origin and time', () => {
    const [p] = addPicture([], 'data:image/jpeg;base64,AAA', 12, { origin: 'abc_0', t: 3.25 });
    expect(p.src).toEqual({ origin: 'abc_0', t: 3.25 });
    expect(addPicture([], 'data:image/jpeg;base64,B')[0].src).toBeUndefined();
  });
});

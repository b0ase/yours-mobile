/** The 11 bCorp note artworks (WebP, re-encoded from bcorp-mint) as templates: the art plus a serial. */
import { defaultSerialNumberConfig, makeLayer } from './mint-defaults';
import type { MintDocument } from './types';

const full = import.meta.glob<string>('../assets/templates/note-*[0-9].webp', {
  eager: true,
  query: '?url',
  import: 'default',
});
const thumbs = import.meta.glob<string>('../assets/templates/note-*-thumb.webp', {
  eager: true,
  query: '?url',
  import: 'default',
});

const num = (p: string) => Number(/note-(\d+)/.exec(p)?.[1] ?? 0);

export type ArtTemplate = { id: string; name: string; thumb: string; full: string; factory: () => MintDocument };

export const ART_TEMPLATES: ArtTemplate[] = Object.keys(full)
  .sort((a, b) => num(a) - num(b))
  .map((p) => {
    const n = num(p);
    const thumb = Object.entries(thumbs).find(([k]) => num(k) === n)?.[1] ?? full[p];
    return {
      id: `bcorp-art-${n}`,
      name: `bCorp note ${n}`,
      thumb,
      full: full[p],
      factory: () => ({
        name: `bCorp note ${n}`,
        description: '',
        width: 1200,
        height: 675,
        backgroundColor: '#0b0a08',
        circleMask: false,
        rimPattern: { enabled: false, teeth: 120, depth: 6, color: '#daa520' },
        layers: [
          makeLayer('image', 'Artwork', { src: full[p], fit: 'cover', x: 0.5, y: 0.5, scale: 1 }),
          makeLayer('serial-number', 'Serial', { ...defaultSerialNumberConfig(), x: 0.86, y: 0.93 }),
        ],
      }),
    };
  });

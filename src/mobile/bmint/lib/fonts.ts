/**
 * Self-hosted SIL OFL fonts for the note designer (no Google Fonts call: store builds and the CSP
 * prefer none). Each pattern layer is an SVG drawn through an <img>, and an SVG image cannot see the
 * page's fonts, so the woff2 files are also embedded as data URIs into any SVG that uses them.
 */
import bangers from '../assets/fonts/bangers-400.woff2?url';
import bebas from '../assets/fonts/bebas-neue-400.woff2?url';
import plex400 from '../assets/fonts/ibm-plex-mono-400.woff2?url';
import plex600 from '../assets/fonts/ibm-plex-mono-600.woff2?url';
import oswald from '../assets/fonts/oswald.woff2?url';
import marker from '../assets/fonts/permanent-marker-400.woff2?url';
import grotesk from '../assets/fonts/space-grotesk.woff2?url';

type Face = { family: string; url: string; weight: string };

export const FACES: readonly Face[] = [
  { family: 'Space Grotesk', url: grotesk, weight: '300 700' },
  { family: 'IBM Plex Mono', url: plex400, weight: '400' },
  { family: 'IBM Plex Mono', url: plex600, weight: '600 700' },
  { family: 'Oswald', url: oswald, weight: '200 700' },
  { family: 'Bebas Neue', url: bebas, weight: '400 700' },
  { family: 'Permanent Marker', url: marker, weight: '400 700' },
  { family: 'Bangers', url: bangers, weight: '400 700' },
];

/** The font picker: the self-hosted faces plus common system fonts. */
export const FONT_OPTIONS = [
  ...[...new Set(FACES.map((f) => f.family))].map((f) => ({ value: f, label: f })),
  { value: 'Georgia', label: 'Georgia' },
  { value: 'Courier New', label: 'Courier New' },
  { value: 'Impact', label: 'Impact' },
] as const;

const embedded = new Map<string, string>(); // family → @font-face rules with data URIs

const toDataUri = async (url: string) => {
  const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:font/woff2;base64,${btoa(s)}`;
};

let ready: Promise<void> | null = null;

/** Load every face into the page (for the canvas) and cache its embeddable rule. Safe to call often. */
export const loadFonts = (): Promise<void> =>
  (ready ??= Promise.all(
    FACES.map(async (f) => {
      try {
        const uri = await toDataUri(f.url);
        const rule = `@font-face{font-family:'${f.family}';src:url(${uri}) format('woff2');font-weight:${f.weight};}`;
        embedded.set(f.family, (embedded.get(f.family) ?? '') + rule);
        const face = new FontFace(f.family, `url(${uri})`, { weight: f.weight });
        document.fonts.add(await face.load());
      } catch {
        /* offline: fall back to system fonts */
      }
    }),
  ).then(() => undefined));

/** The embeddable @font-face rules loaded so far, by family (svg.ts withFonts). */
export const embeddedFonts = (): ReadonlyMap<string, string> => embedded;

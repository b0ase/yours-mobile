/**
 * Memorable chat names for Ask b, ported from bChatX (bit-sign src/lib/chat-name.ts, PR #471; owner, 26 Oct 2026:
 * "each chat should have an easy to remember chat name like silver-fox-pillow").
 *
 * `<app>-<handle>-<word>-<word>-<nn>`, e.g. `bwalletx-b0asex-silver-fox-12`. DERIVED from the chat's id, so the same
 * chat has the same name everywhere. Same word lists and hash as bChatX, so an id names the same chat on both.
 * Pure: shared by the header, b's context and the tests.
 */
const ADJ = [
  'amber',
  'arctic',
  'autumn',
  'bold',
  'brave',
  'bright',
  'calm',
  'cedar',
  'clever',
  'cobalt',
  'copper',
  'coral',
  'crimson',
  'crisp',
  'dawn',
  'eager',
  'emerald',
  'gentle',
  'golden',
  'granite',
  'happy',
  'hazel',
  'honest',
  'indigo',
  'ivory',
  'jade',
  'jolly',
  'kind',
  'lively',
  'lucky',
  'lunar',
  'maple',
  'mellow',
  'misty',
  'noble',
  'ocean',
  'olive',
  'onyx',
  'pearl',
  'plum',
  'polar',
  'quick',
  'quiet',
  'rapid',
  'red',
  'royal',
  'ruby',
  'rustic',
  'sage',
  'scarlet',
  'silver',
  'solar',
  'steady',
  'stone',
  'sunny',
  'swift',
  'teal',
  'tidy',
  'velvet',
  'violet',
  'warm',
  'wild',
  'witty',
  'zesty',
] as const;
const NOUN = [
  'badger',
  'bear',
  'beacon',
  'birch',
  'brook',
  'canyon',
  'cedar',
  'comet',
  'crane',
  'curtain',
  'dolphin',
  'eagle',
  'ember',
  'falcon',
  'fern',
  'finch',
  'fox',
  'garden',
  'harbor',
  'hawk',
  'heron',
  'island',
  'kestrel',
  'lantern',
  'lark',
  'lynx',
  'meadow',
  'moose',
  'night',
  'oak',
  'orchid',
  'otter',
  'owl',
  'panda',
  'pebble',
  'pillow',
  'pine',
  'planet',
  'quill',
  'rabbit',
  'raven',
  'reef',
  'ridge',
  'river',
  'robin',
  'rocket',
  'sail',
  'seal',
  'shore',
  'sparrow',
  'spruce',
  'star',
  'stone',
  'summit',
  'swan',
  'thistle',
  'tide',
  'tiger',
  'trail',
  'tulip',
  'valley',
  'whale',
  'willow',
  'wolf',
] as const;

/** FNV-1a over the id: stable, fast, and spread well enough for 64 × 64 × 90 names. */
function fnv(s: string, seed = 0x811c9dc5): number {
  let h = seed >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/^[$@]/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24);

/** `bwalletx-b0asex-silver-fox-12`. `scope` (an app, room ticker or repo) defaults to bwalletx. */
export function chatName(id: string, handle: string | null | undefined, scope = 'bwalletx'): string {
  const key = id.toLowerCase();
  const a = ADJ[fnv(key) % ADJ.length];
  const n = NOUN[fnv(key, 0x9e3779b1) % NOUN.length];
  const num = 10 + (fnv(key, 0x85ebca6b) % 90);
  return [slug(scope) || 'bwalletx', slug(handle || '') || null, a, n, String(num)].filter(Boolean).join('-');
}

/** The memorable part alone (`silver-fox-12`), for tight spaces. */
export const chatShortName = (id: string) => chatName(id, null, 'x').replace(/^x-/, '');

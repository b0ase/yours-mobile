/**
 * Emoji themes (owner, 18 Oct 2026): twelve ~$1 Store themes, one per emoji. Art is Twemoji (CC-BY 4.0, credited
 * in the Store and in src/mobile/wallet/emojiArt/ATTRIBUTION.md), never Apple or Google emoji images. Nobody owns an
 * emoji: these are looks you buy, nothing more. Picked to be broadly loved, friendly everywhere and free of crypto
 * clichés (no rocket, no gem, no moon-as-price joke: the Moon here is the night sky).
 * No imports, so accents.ts can build the packs from this list without a cycle.
 */
export const EMOJI_THEMES = [
  {
    id: 'emoji-frog',
    label: 'Frog',
    char: '🐸',
    code: '1f438',
    blurb: 'Pond green on black',
    accent: '#78B159',
    bg: '#050A04',
  },
  {
    id: 'emoji-fire',
    label: 'Fire',
    char: '🔥',
    code: '1f525',
    blurb: 'Flame orange on charcoal',
    accent: '#FF8A1F',
    bg: '#120603',
  },
  {
    id: 'emoji-wave',
    label: 'Wave',
    char: '🌊',
    code: '1f30a',
    blurb: 'Ocean blue, deep water',
    accent: '#4FA3F7',
    bg: '#020A14',
  },
  {
    id: 'emoji-blossom',
    label: 'Blossom',
    char: '🌸',
    code: '1f338',
    blurb: 'Cherry blossom pink at night',
    accent: '#F4ABBA',
    bg: '#12070B',
  },
  {
    id: 'emoji-spark',
    label: 'Spark',
    char: '⚡',
    code: '26a1',
    blurb: 'Lightning yellow on indigo',
    accent: '#FFE14D',
    bg: '#0A0824',
  },
  {
    id: 'emoji-moon',
    label: 'Moon',
    char: '🌙',
    code: '1f319',
    blurb: 'Moonlight on a navy sky',
    accent: '#E8DDB5',
    bg: '#060A1A',
  },
  {
    id: 'emoji-pizza',
    label: 'Pizza',
    char: '🍕',
    code: '1f355',
    blurb: 'Tomato red, a slice of fun',
    accent: '#F05A47',
    bg: '#120605',
  },
  {
    id: 'emoji-headphones',
    label: 'Headphones',
    char: '🎧',
    code: '1f3a7',
    blurb: 'Neon pink for music lovers',
    accent: '#FF4D8D',
    bg: '#0A0509',
  },
  {
    id: 'emoji-pup',
    label: 'Pup',
    char: '🐶',
    code: '1f436',
    blurb: 'Warm puppy tan',
    accent: '#E3A47F',
    bg: '#0F0A07',
  },
  {
    id: 'emoji-rainbow',
    label: 'Rainbow',
    char: '🌈',
    code: '1f308',
    blurb: 'Every colour, violet first',
    accent: '#B18CFF',
    bg: '#08060F',
  },
  {
    id: 'emoji-clover',
    label: 'Clover',
    char: '🍀',
    code: '1f340',
    blurb: 'Lucky emerald',
    accent: '#3CC47C',
    bg: '#03100A',
  },
  {
    id: 'emoji-cool',
    label: 'Cool',
    char: '😎',
    code: '1f60e',
    blurb: 'Ice blue on true black',
    accent: '#4DE1FF',
    bg: '#000000',
  },
] as const;

export type EmojiTheme = (typeof EMOJI_THEMES)[number];
export type EmojiPackId = EmojiTheme['id'];
export const EMOJI_PACK_IDS: readonly EmojiPackId[] = EMOJI_THEMES.map((e) => e.id);
export const isEmojiPack = (id: string): id is EmojiPackId => (EMOJI_PACK_IDS as readonly string[]).includes(id);
export const emojiTheme = (id: string): EmojiTheme | undefined => EMOJI_THEMES.find((e) => e.id === id);

/** Shown wherever the emoji art appears for sale (CC-BY 4.0 asks for credit). */
export const TWEMOJI_CREDIT = 'Emoji art: Twemoji by X Corp and contributors, CC-BY 4.0';
export const TWEMOJI_LICENSE_URL = 'https://creativecommons.org/licenses/by/4.0/';

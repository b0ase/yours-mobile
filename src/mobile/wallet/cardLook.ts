import { useEffect, useState } from 'react';
import { DEFAULT_ACCENT, accentById, type Accent } from '../theme/accents';
import { useAccentId } from '../theme/useAccent';

/**
 * Theme-follow vs customised (owner, 15 Oct 2026): a card the user has NOT customised follows the active theme
 * (White → white cards, Blue → blue …); a card the user HAS customised (chosen design, picture or colour) never
 * changes with the theme. "Customised" is tracked explicitly per card id (this store, plus the wallet card's own
 * saved design / picture / look), never inferred by comparing colours. Applies to the carousel and All cards alike.
 */
export const CARD_CUSTOM_EVENT = 'bw-card-custom-changed';
const KEY = 'bw-card-custom';

const readAll = (): Record<string, true> => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' ? (v as Record<string, true>) : {};
  } catch {
    return {};
  }
};

/** True when the user has customised this card (set when they save a design, picture or colour for it). */
export const isCardCustomised = (id: string): boolean => readAll()[id] === true;

/** Records (or clears) that the user customised this card. */
export function setCardCustomised(id: string, on: boolean): void {
  const all = readAll();
  if (on) all[id] = true;
  else delete all[id];
  try {
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    /* private mode: lasts this session only */
  }
  try {
    window.dispatchEvent(new Event(CARD_CUSTOM_EVENT));
  } catch {
    /* no window (tests) */
  }
}

/** Re-reads a card's customised flag when it changes. */
export function useCardCustomised(id: string): boolean {
  const [on, setOn] = useState(() => isCardCustomised(id));
  useEffect(() => {
    const read = () => setOn(isCardCustomised(id));
    read();
    window.addEventListener(CARD_CUSTOM_EVENT, read);
    return () => window.removeEventListener(CARD_CUSTOM_EVENT, read);
  }, [id]);
  return on;
}

/**
 * Whether a card wears the theme's look. Gold (the default) and accent-only colours set no pack, so every card
 * keeps its own look there; any full pack (Mono / Duo / Tri / your mix) restyles every uncustomised card.
 */
export const cardFollowsTheme = (pack: Pick<Accent, 'id' | 'kind' | 'scheme'>, customised: boolean): boolean =>
  (!customised || pack.scheme === 'light') && pack.id !== DEFAULT_ACCENT && pack.kind !== 'colour';
// Light packs (owner, 16 Oct 2026: "a white/light set of credit cards that go with the white theme"): every card
// turns light, customised or not, so a light theme never falls back to the dark card art. Only the wallet card's
// own picture or chosen design (WalletCard.tsx) is kept, and then on the light face.

/** The colour a card's pattern is drawn in: the pack's hue when it follows the theme, its own colour otherwise. */
export const cardPatternColour = (
  pack: Pick<Accent, 'id' | 'kind' | 'scheme' | 'accent'>,
  customised: boolean,
  own: string,
): string => (cardFollowsTheme(pack, customised) ? pack.accent : own);

/** True while this card wears the active theme's look (uncustomised, and a full pack is on). */
export function useCardThemed(id: string): boolean {
  const pack = accentById(useAccentId());
  return cardFollowsTheme(pack, useCardCustomised(id));
}

/**
 * Artist editions (VexVoid, NPG, NPGX) bring their own card art (cardPatternsEdition.ts). Owner bug, 18 Oct 2026:
 * an account whose card had a saved brightness/position (so "customised") kept its bAvatar, tinted red, under NPGX.
 * A bought edition is chosen on purpose, so its art goes on the card whatever the saved look; only the account's own
 * picture or a chosen Art/Collections design (ownArt) stays in front of it.
 */
export const editionArtOn = (pack: Pick<Accent, 'group' | 'scheme'>, ownArt: boolean): boolean =>
  pack.group === 'edition' && pack.scheme !== 'light' && !ownArt;

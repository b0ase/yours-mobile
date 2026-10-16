import { memo } from 'react';
import { patternUri } from './cardPatterns';
import { skinFor } from './cardSkins';
import { useCardBalance } from './balanceStore';
import { accentById } from '../theme/accents';
import { useAccentId } from '../theme/useAccent';
import { cardPatternColour, useCardCustomised } from './cardLook';
import { LIGHT_PATTERN_IDS } from './cardPatternsLight';
import './cardSkins.css';

/** White theme: each card gets one of the white designs, picked steadily from its id. */
const whiteArtFor = (id: string) => {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return LIGHT_PATTERN_IDS[h % LIGHT_PATTERN_IDS.length];
};

/**
 * The art layer for a balance card (carousel, All cards browser). Drop it as the first child of any card box
 * with position: relative; it fills the box, sits under the text and adds the skin's finish (foil sweep,
 * enamel glaze, neon edge …). Memoised: it only re-renders when the id or colour changes.
 */
export const CardSkin = memo(function CardSkin({ id, colour }: { id: string; colour?: string }) {
  const s = skinFor(id, colour);
  // An uncustomised card follows the theme: its pattern is drawn in the pack's hue (cardLook.ts, themes.css).
  const pack = accentById(useAccentId());
  const c = cardPatternColour(pack, useCardCustomised(id), s.colour);
  return (
    <span className={`bw-skin bw-skin--${s.finish}`} aria-hidden="true" style={{ ['--skin-c' as string]: c }}>
      <img
        className="bw-skin-art"
        src={patternUri(pack.id === 'white' ? whiteArtFor(id) : s.pattern, pack.id === 'white' ? pack.accent : c)}
        alt=""
        draggable={false}
        decoding="async"
      />
      <span className="bw-skin-fx" />
    </span>
  );
});

/** A balance in its unit, always with two decimals (0.00 on an empty card); sub-unit amounts keep their precision. */
const fmtCardBalance = (n: number, unit: string) => {
  const digits = { minimumFractionDigits: 2, maximumFractionDigits: n > 0 && n < 1 ? 8 : 2 };
  return unit === '$' ? `$${n.toLocaleString('en-US', digits)}` : `${n.toLocaleString('en-US', digits)} ${unit}`;
};

/**
 * A card's balance: live (from balanceStore, published by screens that already have it) while `live`, the last
 * known value otherwise; `fallback` covers a card whose balance has not been read yet (a 0.00 in its unit, or a short label for cards that are not balances). Renders nothing if
 * neither is known.
 */
export const CardBalance = memo(function CardBalance({
  id,
  live,
  fallback,
  className = 'bw-skin-bal',
}: {
  id: string;
  live: boolean;
  fallback?: string;
  className?: string;
}) {
  const b = useCardBalance(id, live);
  const text = b ? fmtCardBalance(b.amount, b.unit) : fallback;
  if (!text) return null;
  return <span className={className}>{text}</span>;
});

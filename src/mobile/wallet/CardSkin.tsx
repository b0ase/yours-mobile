import { memo } from 'react';
import { patternUri } from './cardPatterns';
import { skinFor } from './cardSkins';
import { useCardBalance } from './balanceStore';
import './cardSkins.css';

/**
 * The art layer for a balance card (carousel, All cards browser). Drop it as the first child of any card box
 * with position: relative; it fills the box, sits under the text and adds the skin's finish (foil sweep,
 * enamel glaze, neon edge …). Memoised: it only re-renders when the id or colour changes.
 */
export const CardSkin = memo(function CardSkin({ id, colour }: { id: string; colour?: string }) {
  const s = skinFor(id, colour);
  return (
    <span className={`bw-skin bw-skin--${s.finish}`} aria-hidden="true" style={{ ['--skin-c' as string]: s.colour }}>
      <img className="bw-skin-art" src={patternUri(s.pattern, s.colour)} alt="" draggable={false} decoding="async" />
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

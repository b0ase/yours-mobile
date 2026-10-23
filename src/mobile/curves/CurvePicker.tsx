import { useEffect, useMemo } from 'react';
import {
  PRESETS,
  curveHash,
  curveLines,
  makeCurve,
  maxPrice,
  priceAt,
  usd,
  usdToSats,
  type Curve,
  type CurveShape,
  type PresetId,
} from '../../lib/curves';
import { PERMANENT_NOTE, presetFor } from './curveChoice';

/**
 * Launch curve picker (mint pages): grade chips, shape toggle, floor, early-tier switch, a live chart and
 * plain lines. The chosen curve is committed on the deploy tx (curves/curveMap.ts) and is FIXED from then
 * on (owner, 23 Oct 2026), so the picker asks for an explicit "permanent" tick before review.
 * It only describes the curve: buying and listing live elsewhere.
 */
const GOLD = 'var(--bw-accent)';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';

const CHIPS: PresetId[] = ['name', 'film', 'project', 'company', 'studio', 'pumpfun', 'sigmoid'];
const SHAPES: { id: CurveShape; label: string }[] = [
  { id: 'linear', label: 'Straight' },
  { id: 'sigmoid', label: 'S-curve' },
  { id: 'exponential', label: 'Steep' },
];

export const CurvePicker = ({
  curve,
  onChange,
  accepted,
  onAccept,
  tokenSupply,
  bsvUsd,
}: {
  /** null = launch without a curve. */
  curve: Curve | null;
  onChange: (c: Curve | null) => void;
  accepted: boolean;
  onAccept: (v: boolean) => void;
  tokenSupply: number;
  bsvUsd?: number;
}) => {
  const set = (c: Curve | null) => {
    onAccept(false);
    onChange(c);
  };
  // A preset follows the token's supply (it can't sell more than exists).
  const fitted = curve?.preset ? presetFor(curve.preset, tokenSupply).supply : null;
  useEffect(() => {
    if (curve?.preset && fitted !== null && fitted !== curve.supply) set(presetFor(curve.preset, tokenSupply));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fitted]);
  const lines = useMemo(() => (curve ? curveLines(curve) : []), [curve]);
  const chip = (active: boolean) => ({
    borderColor: active ? GOLD : LINE,
    color: active ? GOLD : '#fff',
    background: active ? 'rgba(255,200,0,0.08)' : 'transparent',
  });
  const btn = 'rounded-full border px-3 min-h-[36px] text-xs font-semibold cursor-pointer';

  return (
    <div className="flex flex-col gap-3 rounded-xl border p-3" style={{ borderColor: LINE }} data-testid="curve-picker">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-sm font-bold text-white">Launch curve</span>
        <span className="text-[11px]" style={{ color: MUTED }}>
          Price as it sells
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Curve grade">
        {CHIPS.map((id) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={curve?.preset === id}
            className={btn}
            style={chip(curve?.preset === id)}
            onClick={() => set(presetFor(id, tokenSupply))}
          >
            {PRESETS[id].label}
          </button>
        ))}
        <button type="button" role="radio" aria-checked={!curve} className={btn} style={chip(!curve)} onClick={() => set(null)}>
          None
        </button>
      </div>
      {curve && (
        <>
          {curve.preset && (
            <p className="text-[11px] m-0" style={{ color: MUTED }}>
              {PRESETS[curve.preset].blurb}
            </p>
          )}
          <div className="flex gap-1.5" role="radiogroup" aria-label="Curve shape">
            {SHAPES.map((s) => (
              <button
                key={s.id}
                type="button"
                role="radio"
                aria-checked={curve.shape === s.id}
                className={`${btn} flex-1`}
                style={chip(curve.shape === s.id)}
                onClick={() => set(makeCurve({ ...curve, shape: s.id }))}
              >
                {s.label}
              </button>
            ))}
          </div>
          <div className="flex gap-2">
            <label className="flex-1 text-xs" style={{ color: MUTED }}>
              First price (USD)
              <input
                inputMode="decimal"
                className="mt-1 w-full rounded-xl px-3 py-2 text-sm outline-none border bg-transparent"
                style={{ borderColor: LINE, color: '#fff' }}
                aria-label="First price in USD"
                defaultValue={String(curve.floorUsd)}
                key={`${curve.preset}-${curve.shape}-floor`}
                onBlur={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v) && v >= 0) set(makeCurve({ ...curve, floorUsd: v }));
                }}
              />
            </label>
            <label className="flex-1 text-xs" style={{ color: MUTED }}>
              If all sell (USD)
              <input
                inputMode="decimal"
                className="mt-1 w-full rounded-xl px-3 py-2 text-sm outline-none border bg-transparent"
                style={{ borderColor: LINE, color: '#fff' }}
                aria-label="Raise if all sell in USD"
                defaultValue={String(Math.round(curve.ceilingRaiseUsd))}
                key={`${curve.preset}-${curve.shape}-${curve.floorUsd}-raise`}
                onBlur={(e) => {
                  const v = Number(e.target.value.replace(/[,_\s$]/g, ''));
                  if (Number.isFinite(v) && v > 0) set(makeCurve({ ...curve, ceilingRaiseUsd: v }));
                }}
              />
            </label>
          </div>
          <CurveChart curve={curve} />
          <ul className="m-0 p-0 list-none flex flex-col gap-1 text-xs text-white">
            {lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
            {bsvUsd ? (
              <li style={{ color: MUTED }}>
                First token ≈ {usdToSats(priceAt(curve, 0), bsvUsd).toLocaleString('en-US')} sats · smallest buy{' '}
                {usd(curve.minBuyUsd)}
              </li>
            ) : null}
          </ul>
          <label className="flex items-center gap-2 text-xs text-white cursor-pointer">
            <input
              type="checkbox"
              checked={!!curve.earlyTier}
              onChange={(e) =>
                set(makeCurve({ ...curve, earlyTier: e.target.checked ? { fraction: 0.01, maxUsdPerIdentity: 10 } : null }))
              }
            />
            Fair launch: cap each person in the cheapest 1%
          </label>
          <div className="flex flex-col gap-1 rounded-lg border p-2" style={{ borderColor: '#5a4a1a' }}>
            <label className="flex items-start gap-2 text-xs text-white cursor-pointer">
              <input type="checkbox" checked={accepted} onChange={(e) => onAccept(e.target.checked)} aria-label="Curve is permanent" />
              <span>{PERMANENT_NOTE}</span>
            </label>
            <span className="text-[10px] break-all" style={{ color: MUTED }}>
              Curve id {curveHash(curve).slice(0, 16)}…
            </span>
          </div>
        </>
      )}
    </div>
  );
};

/** Price line over 0–100% sold, early tier shaded. Linear scale except Steep, which reads better on log. */
export const CurveChart = ({ curve, height = 120 }: { curve: Curve; height?: number }) => {
  const W = 300;
  const H = height;
  const pad = 4;
  const log = curve.shape === 'exponential' && curve.floorUsd > 0;
  const top = maxPrice(curve);
  const y = (p: number) => {
    const lo = log ? Math.log10(curve.floorUsd) : 0;
    const hi = log ? Math.log10(top) : top;
    const v = log ? Math.log10(Math.max(p, curve.floorUsd)) : p;
    return H - pad - ((v - lo) / (hi - lo || 1)) * (H - 2 * pad);
  };
  const pts: string[] = [];
  for (let i = 0; i <= 60; i++) {
    const f = i / 60;
    pts.push(`${(pad + f * (W - 2 * pad)).toFixed(1)},${y(priceAt(curve, f)).toFixed(1)}`);
  }
  const tierW = curve.earlyTier ? Math.max(2, curve.earlyTier.fraction * (W - 2 * pad)) : 0;
  return (
    <figure className="m-0">
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="Price as the supply sells">
        <rect x={0} y={0} width={W} height={H} rx={8} fill="#0d0e11" />
        {tierW > 0 && <rect x={pad} y={pad} width={tierW} height={H - 2 * pad} fill="rgba(161,255,139,0.18)" />}
        <polyline points={`${pad},${H - pad} ${pts.join(' ')} ${W - pad},${H - pad}`} fill="rgba(255,200,0,0.10)" stroke="none" />
        <polyline points={pts.join(' ')} fill="none" stroke="var(--bw-accent)" strokeWidth={2} />
      </svg>
      <figcaption className="flex justify-between text-[10px]" style={{ color: MUTED }}>
        <span>{usd(curve.floorUsd)} at the start</span>
        <span>{log ? 'log scale · ' : ''}{usd(top)} at 100% sold</span>
      </figcaption>
    </figure>
  );
};

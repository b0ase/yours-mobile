/**
 * Store build stand-in for CurvePicker.tsx (vite.config.mobile.ts): no launch curve picker, and none of its text.
 * A store build mints a plain token with no price curve (CURVE_COINS_ENABLED, tokens/TokenMint.tsx).
 */
import type { Curve } from '../../lib/curves/curves';

export const CurvePicker = (_props: {
  curve: Curve;
  onChange: (c: Curve) => void;
  accepted: boolean;
  onAccept: (v: boolean) => void;
  tokenSupply: number;
  onUseStandardSupply?: () => void;
}) => null;

export const CurveChart = (_props: { curve: Curve; height?: number }) => null;

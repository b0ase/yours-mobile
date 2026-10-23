import { PRESETS, fitToSupply, type Curve, type PresetId } from '../../lib/curves';

export const PERMANENT_NOTE = 'This curve is permanent once you launch. Nobody, you included, can change it later.';

/** Why the picker blocks review (null = fine). */
export const curveProblem = (curve: Curve | null, accepted: boolean): string | null =>
  curve && !accepted ? 'Tick "permanent" under the launch curve to go on.' : null;

/** The curve a preset gives for a token of `tokenSupply` (the curve can't sell more than exists). */
export const presetFor = (id: PresetId, tokenSupply: number): Curve => fitToSupply({ ...PRESETS[id].curve }, tokenSupply);


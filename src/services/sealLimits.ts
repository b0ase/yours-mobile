/**
 * A seal's size and spend limits, shared by the web/extension one-approval seal (sealPass.ts) and the native seal
 * (mobile/chat/sealCheck.ts, nativeSeal.ts). Pure.
 */

/** The most a seal may spend without its own sheet (a seal pays only the network fee, a few hundred sats at most). */
export const SEAL_MAX_SATS = 1_000;
/** The longest reference a seal record may carry (it goes on chain in the seal's output, so it sets the fee). */
export const SEAL_REF_MAX_CHARS = 200;
/** The longest handle, block id, party or role a seal record may carry. */
export const SEAL_TEXT_MAX_CHARS = 100;
/** The most blocks one seal may cover. */
export const SEAL_FIELDS_MAX = 50;

// eslint-disable-next-line no-control-regex
const CTRL = /[\u0000-\u001f\u007f‪-‮⁦-⁩]/;

/** A string of at most `max` characters with no control or direction-override characters. */
export const shortText = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max && !CTRL.test(v);

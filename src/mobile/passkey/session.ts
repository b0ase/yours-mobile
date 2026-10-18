/**
 * The passkey made on "Continue with a passkey", held in memory only until the 12 words exist, so the backup is
 * sealed without a second Face ID prompt. Cleared as soon as it is used.
 */
export type PasskeySession = { rpId: string; credentialId: string; prf: Uint8Array };
let pending: PasskeySession | null = null;
export const setPasskeySession = (s: PasskeySession | null) => {
  pending?.prf.fill(0);
  pending = s;
};
export const takePasskeySession = (): PasskeySession | null => {
  const s = pending;
  pending = null;
  return s;
};

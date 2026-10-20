/**
 * Plain-language labels for protocols whose BRC-43 names are opaque to users.
 * Protocols absent from the table render their raw name unchanged.
 */
const KNOWN_PROTOCOLS: Record<string, { label: string; description: string }> = {
  '2:3241645161d8': {
    label: 'BRC-29 payment',
    description: 'An application is requesting permission to derive payment addresses for a specific recipient.',
  },
};

export const knownProtocol = (protocolID?: [number, string]) =>
  protocolID ? KNOWN_PROTOCOLS[`${protocolID[0]}:${protocolID[1]}`] : undefined;

/** Display name for a protocol: the friendly label when we have one. */
export const protocolLabel = (protocolID?: [number, string]) => knownProtocol(protocolID)?.label ?? protocolID?.[1];

/** Plain-language reading of the BRC-43 security level. */
export const securityLevelLabel = (level?: number): string => {
  switch (level) {
    case 0:
      return 'Level 0 · any app';
    // BRC-43 keys do not depend on the app: any app asking for the same protocol gets the same keys (audit C1).
    case 1:
      return 'Level 1 · same keys for any app using this protocol';
    case 2:
      return 'Level 2 · same keys for any app using this protocol with this recipient';
    default:
      return `Level ${level ?? 0}`;
  }
};

/**
 * Plain wording the WALLET writes for protocols it knows are read-only. A site cannot change this text.
 * Only protocols that reveal nothing secret and cannot spend belong here: they may be approved with one tap.
 */
const READ_ONLY_PROTOCOLS: Record<string, string> = {
  'identity key retrieval': 'see your public ID',
};

export const readOnlyProtocolPhrase = (protocolID?: [number, string]): string | undefined =>
  protocolID ? READ_ONLY_PROTOCOLS[protocolID[1].trim().toLowerCase()] : undefined;

/** "see your public ID" / "see your public ID and X": the sentence tail for a list of read-only phrases. */
export const joinPhrases = (phrases: string[]): string =>
  phrases.length <= 1 ? (phrases[0] ?? '') : `${phrases.slice(0, -1).join(', ')} and ${phrases[phrases.length - 1]}`;

/** Amount line for a spend: "1¢" on top, sats under it. Cents need a price; without one only sats are shown. */
export const spendAmount = (sats: number, usdPerBsv: number): { primary: string; secondary: string | null } => {
  const satsText = `${sats.toLocaleString()} sats`;
  if (!(usdPerBsv > 0)) return { primary: satsText, secondary: null };
  const cents = (sats / 100_000_000) * usdPerBsv * 100;
  const text =
    cents >= 100
      ? `$${(cents / 100).toFixed(2)}`
      : cents >= 1
        ? `${Math.round(cents)}¢`
        : cents > 0
          ? 'under 1¢'
          : '0¢';
  return { primary: text, secondary: satsText };
};

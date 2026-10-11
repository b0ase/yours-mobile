/** Approval card colours and font (owner-approved designs, 11 Oct 2026). */
export const CARD = {
  bg: '#0B0A08',
  ink: '#F1EAD9',
  muted: '#A39A85',
  soft: '#CFC8B6',
  chip: '#1A1812',
  gold: '#F5C542',
  goldHi: '#FFE08A',
  goldLo: '#B8860B',
  green: '#5FD38D',
  red: '#E5484D',
  redBg: '#0D0606',
  redInk: '#F4E6E6',
  redSoft: '#FF8A8A',
  redChip: '#2A1010',
  redLine: '#8C1D1D',
} as const;

/** Sora when the device has it, then the wallet's own bold system stack (no webfont in the extension). */
export const CARD_FONT =
  "Sora, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', system-ui, sans-serif";

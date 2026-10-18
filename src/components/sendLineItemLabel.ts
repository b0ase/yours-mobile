/**
 * Middle-ellipsis only for addresses/keys (one long unbroken token). Labels with spaces, such as
 * `Inscribe "My title"` or `Network fee (est.)`, are shown in full and wrap.
 */
export const lineItemLabel = (addr: string) => {
  if (addr.length <= 16 || /\s/.test(addr)) return addr;
  return `${addr.slice(0, 8)}...${addr.slice(-8)}`;
};

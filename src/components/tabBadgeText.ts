/** Tab badge text: '' for none, the count, or 99+. */
export const tabBadgeText = (n: number): string => (n > 0 ? (n > 99 ? '99+' : String(Math.floor(n))) : '');

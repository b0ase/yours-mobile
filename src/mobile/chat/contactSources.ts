/** Friend sources we can't read yet, said out loud rather than hidden. */
export const SOURCES_NOTE: { name: string; note: string }[] = [
  { name: 'Twetch', note: 'Twetch’s API is offline (503), so follows can’t be imported.' },
  { name: 'HandCash', note: 'Needs bChat to keep your HandCash login and expose your friends.' },
  { name: 'Treechat', note: 'Treechat has no public API.' },
];

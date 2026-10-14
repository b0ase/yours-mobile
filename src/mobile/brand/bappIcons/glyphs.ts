/**
 * bApp glyphs: line art on a 24-unit grid, drawn with `currentColor` (stroke, and fill for the few dots).
 * The renderer (render.ts) places one on the black tile in the app's colour, beside the gold b badge.
 */
export const GLYPHS = {
  bmovies:
    '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7.5 4v16M16.5 4v16M3 9h4.5M3 15h4.5M16.5 9H21M16.5 15H21"/>',
  bmusic: '<path d="M9 18V5.5l11-2V16"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/>',
  bnews:
    '<path d="M17 20H6a2 2 0 0 1-2-2V5a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v13a2 2 0 0 0 2 2 2 2 0 0 0 2-2V9h-4"/><path d="M8 8.5h5M8 12h5M8 15.5h3"/>',
  bradio:
    '<circle cx="12" cy="12" r="2"/><path d="M8.5 8.5a5 5 0 0 0 0 7M15.5 8.5a5 5 0 0 1 0 7M5.2 5.2a9.6 9.6 0 0 0 0 13.6M18.8 5.2a9.6 9.6 0 0 1 0 13.6"/>',
  bgames:
    '<path d="M7 7h10a5 5 0 0 1 5 5v2.5a2.5 2.5 0 0 1-4.6 1.4L16 14H8l-1.4 1.9A2.5 2.5 0 0 1 2 14.5V12a5 5 0 0 1 5-5z"/><path d="M7.5 9.5v3M6 11h3"/><circle cx="15.5" cy="10" r=".7" fill="currentColor" stroke="none"/><circle cx="17.5" cy="12" r=".7" fill="currentColor" stroke="none"/>',
  // A painter's palette with paint wells and a thumb hole (it used to read as a pencil).
  bart: '<path d="M12 3a9 9 0 0 0 0 18c1.1 0 1.9-.8 1.9-1.9 0-.5-.2-.9-.5-1.3-.3-.3-.5-.8-.5-1.2 0-1 .9-1.9 1.9-1.9H17a4 4 0 0 0 4-4C21 6.6 17 3 12 3z"/><circle cx="7.5" cy="11" r="1.3" fill="currentColor" stroke="none"/><circle cx="9.5" cy="7" r="1.3" fill="currentColor" stroke="none"/><circle cx="14.5" cy="7" r="1.3" fill="currentColor" stroke="none"/><circle cx="17.3" cy="10.5" r="1.3" fill="currentColor" stroke="none"/>',
  b3d: '<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M4 7.4l8 4.6 8-4.6M12 12v9.2"/>',
  bphotos:
    '<path d="M3 8.5a1.5 1.5 0 0 1 1.5-1.5H7l1.8-2.5h6.4L17 7h2.5A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><circle cx="12" cy="13.2" r="3.5"/>',
  bbooks:
    '<path d="M2.5 5H8a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2.5z"/><path d="M21.5 5H16a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h6.5z"/>',
  bwriter:
    '<path d="M20.5 3.5C13 4 7.5 9 6.5 17.5"/><path d="M20.5 3.5c-.5 6-4 10.5-11.5 11.5"/><path d="M4 20.5l2.5-3"/><path d="M14 9.5l-4.5 4.5"/>',
  bmail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 6.5L12 13l8.5-6.5"/>',
  bsocial:
    '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 5a3.5 3.5 0 0 1 0 7M18.5 14.5A6.5 6.5 0 0 1 21.5 20"/>',
  bchatx:
    '<path d="M4.5 4h15A1.5 1.5 0 0 1 21 5.5v10a1.5 1.5 0 0 1-1.5 1.5H11l-5 4v-4H4.5A1.5 1.5 0 0 1 3 15.5v-10A1.5 1.5 0 0 1 4.5 4z"/><path d="M9.5 8l5 5M14.5 8l-5 5"/>',
  bexchange: '<path d="M3 17l6-6 4 4 8-8"/><path d="M15 7h6v6"/><path d="M3 21h18"/>',
  bcredits:
    '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  bshares:
    '<path d="M11 18H4.5A1.5 1.5 0 0 1 3 16.5v-11A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5V12"/><path d="M7 8.5h10M7 12h5"/><circle cx="17" cy="16" r="3"/><path d="M15.5 18.6L15 22l2-1 2 1-.5-3.4"/>',
} as const;

export type GlyphSlug = keyof typeof GLYPHS;

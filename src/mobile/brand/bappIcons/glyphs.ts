/**
 * bApp glyphs: line art on a 24-unit grid, drawn with `currentColor` (stroke, and fill for the few dots).
 * The renderer (render.ts) places one on the black tile in the app's colour, beside the b badge in the app colour.
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
  bart: '<path d="M20.5 3.5L13.5 10.5"/><path d="M13.5 10.5c-1.3-.6-2.8.1-3.3 1.4-.4 1-1.1 1.6-2.2 1.9 1.7 1.1 4.1.9 5.4-.5.9-1 .9-2 .1-2.8z"/><path d="M5.5 15.5c1-.6 1.9.6 2.8.2.9-.4 1.9.5 1.4 1.4-.4.8.5 1.5-.2 2.3-.7.8-1.7.2-2.4.9-.7.7-1.9.3-2.1-.7-.2-.8-1.4-1-1.4-2 0-1 1.2-1.3 1.1-2.1z" fill="currentColor" stroke="none"/><circle cx="12.5" cy="18.5" r="1" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12.5" r=".9" fill="currentColor" stroke="none"/><circle cx="10" cy="21.5" r=".8" fill="currentColor" stroke="none"/>',
  b3d: '<path d="M12 2.8l8 4.6v9.2l-8 4.6-8-4.6V7.4z"/><path d="M4 7.4l8 4.6 8-4.6M12 12v9.2"/>',
  bphotos:
    '<path d="M3 8.5a1.5 1.5 0 0 1 1.5-1.5H7l1.8-2.5h6.4L17 7h2.5A1.5 1.5 0 0 1 21 8.5v10a1.5 1.5 0 0 1-1.5 1.5h-15A1.5 1.5 0 0 1 3 18.5z"/><circle cx="12" cy="13.2" r="3.5"/>',
  bbooks:
    '<path d="M2.5 5H8a4 4 0 0 1 4 4v11a3 3 0 0 0-3-3H2.5z"/><path d="M21.5 5H16a4 4 0 0 0-4 4v11a3 3 0 0 1 3-3h6.5z"/>',
  bwriter:
    '<path d="M20.5 3.5C13 4 7.5 9 6.5 17.5"/><path d="M20.5 3.5c-.5 6-4 10.5-11.5 11.5"/><path d="M4 20.5l2.5-3"/><path d="M14 9.5l-4.5 4.5"/>',
  bmail:
    '<rect x="3" y="5.5" width="18" height="13.5" rx="2"/><path d="M3.5 7L12 13.2 20.5 7"/><circle cx="12" cy="14.6" r="2.3" fill="currentColor" stroke="none"/>',
  bsocial:
    '<circle cx="9" cy="8.5" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0"/><path d="M15.5 5a3.5 3.5 0 0 1 0 7M18.5 14.5A6.5 6.5 0 0 1 21.5 20"/>',
  bchatx:
    '<path d="M4.5 4h15A1.5 1.5 0 0 1 21 5.5v10a1.5 1.5 0 0 1-1.5 1.5H11l-5 4v-4H4.5A1.5 1.5 0 0 1 3 15.5v-10A1.5 1.5 0 0 1 4.5 4z"/><path d="M9.5 8l5 5M14.5 8l-5 5"/>',
  bexchange:
    '<path d="M6 12v8M12 8.5v9M18 3.5v9"/><rect x="4.5" y="14" width="3" height="4" rx=".6" fill="currentColor" stroke="none"/><rect x="10.5" y="10.5" width="3" height="5" rx=".6"/><rect x="16.5" y="5.5" width="3" height="5" rx=".6" fill="currentColor" stroke="none"/><path d="M3 21.5h18"/>',
  bcredits:
    '<ellipse cx="12" cy="6" rx="7" ry="3"/><path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6"/><path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6"/>',
  bshares:
    '<path d="M11 18H4.5A1.5 1.5 0 0 1 3 16.5v-11A1.5 1.5 0 0 1 4.5 4h15A1.5 1.5 0 0 1 21 5.5V12"/><path d="M7 8.5h10M7 12h5"/><circle cx="17" cy="16" r="3"/><path d="M15.5 18.6L15 22l2-1 2 1-.5-3.4"/>',
  bjobs:
    '<rect x="3" y="7.5" width="18" height="12.5" rx="2"/><path d="M9 7.5V5.5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5.5v2"/><path d="M3 13h18"/><path d="M10.5 12v2.5h3V12"/>',
  bpaint:
    '<path d="M10 2.5h4v5h-4z"/><path d="M7 7.5h10v3H7z"/><path d="M7 10.5h10V14a1 1 0 0 1-1 1h-2.5v3.5a1.5 1.5 0 0 1-3 0V15H8a1 1 0 0 1-1-1z"/><path d="M16 15v2.5"/><circle cx="16" cy="19.8" r="1" fill="currentColor" stroke="none"/>',
  bdrive:
    '<rect x="6" y="6" width="12" height="12" rx="2"/><rect x="9.5" y="9.5" width="5" height="5" rx="1"/><path d="M9.5 2.5V6M14.5 2.5V6M9.5 18v3.5M14.5 18v3.5M2.5 9.5H6M2.5 14.5H6M18 9.5h3.5M18 14.5h3.5"/>',
  bsheets: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 9.5h18M3 14.75h18M9 4v16M15 4v16"/>',
  bcal: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/><rect x="13" y="13.5" width="4" height="4" rx=".8" fill="currentColor" stroke="none"/>',
  bcode: '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 4.5l-4 15"/>',
  bagents:
    '<rect x="4.5" y="8" width="15" height="11.5" rx="3"/><path d="M12 8V5.2M2.5 12.5v3M21.5 12.5v3M10 16.5h4"/><circle cx="12" cy="4" r="1.3"/><circle cx="9.3" cy="12.8" r="1.4" fill="currentColor" stroke="none"/><circle cx="14.7" cy="12.8" r="1.4" fill="currentColor" stroke="none"/>',
} as const;

export type GlyphSlug = keyof typeof GLYPHS;

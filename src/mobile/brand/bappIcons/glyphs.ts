/**
 * bApp glyphs (minimal set, owner 16 Oct 2026): one thin line drawing per bApp on a 24-unit grid, two to four
 * primitives each, strokes only (no fills), round caps and joins, all inside the 3–21 box so they share one
 * optical size. Drawn with `currentColor`; the renderer (render.ts) sets the colour per theme. A dot is a
 * zero-length round-capped line, so it is still a stroke.
 */
export const GLYPHS = {
  bmovies: '<rect x="3" y="9" width="18" height="11" rx="1.5"/><path d="M3.5 8.5l16.5-4.5"/>',
  bvideo: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10.5 9.5v5l4-2.5z"/>',
  bmusic: '<path d="M9 18V5.5l10-2V15"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="16.5" cy="15" r="2.5"/>',
  bnews: '<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 9h8M8 13h8M8 17h4"/>',
  bradio: '<circle cx="12" cy="12" r="1.5"/><path d="M8 8a5.7 5.7 0 0 0 0 8M16 8a5.7 5.7 0 0 1 0 8"/>',
  bgames: '<rect x="2.5" y="7" width="19" height="10" rx="5"/><path d="M7 12h3M8.5 10.5v3M15.5 11h.01M17.5 13h.01"/>',
  bart: '<path d="M12 3a9 9 0 1 0 0 18c1.4 0 1.8-1 1.2-2.1-.6-1.2.2-2.4 1.6-2.4H17a4 4 0 0 0 4-4C21 7 17 3 12 3z"/><path d="M8 10.5h.01M12 7.5h.01M16 10.5h.01"/>',
  bpaint:
    '<path d="M19.5 4l-8.5 8.5"/><path d="M11 12.5c-2.2-.6-4.5.9-4.5 3.5 0 1.9-1.4 2.8-3 3.2 3.8 1.6 9.2.2 7.5-6.7z"/>',
  b3d: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  bphotos:
    '<rect x="3" y="6.5" width="18" height="13.5" rx="2"/><circle cx="12" cy="13" r="3.5"/><path d="M9 6.5L10 4h4l1 2.5"/>',
  bbooks:
    '<path d="M12 6.5C10 5 7 4.5 3 5v13.5c4-.5 7 0 9 1.5 2-1.5 5-2 9-1.5V5c-4-.5-7 0-9 1.5z"/><path d="M12 6.5V20"/>',
  bwriter: '<path d="M20 4C11.5 5 6 10 5 20"/><path d="M20 4c-1 7-5 11-12.5 11.5"/>',
  bmail: '<rect x="3" y="5.5" width="18" height="13" rx="2"/><path d="M3.5 7l8.5 6.5L20.5 7"/>',
  bsocial:
    '<circle cx="9" cy="9" r="3"/><path d="M3.5 19a5.5 5.5 0 0 1 11 0"/><path d="M15 6.2a3 3 0 0 1 0 5.6M17 14a5.5 5.5 0 0 1 3.5 5"/>',
  bchat: '<path d="M4 5h16v11H10.5L6 19.5V16H4z"/>',
  bchatx: '<path d="M4 5h16v11H10.5L6 19.5V16H4z"/><path d="M10 8.5l4 4M14 8.5l-4 4"/>',
  bexchange: '<path d="M4 9h15.5l-4-4"/><path d="M20 15H4.5l4 4"/>',
  bcredits:
    '<ellipse cx="12" cy="7" rx="7" ry="3"/><path d="M5 7v10c0 1.7 3.1 3 7 3s7-1.3 7-3V7M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"/>',
  bshares: '<path d="M11 4a8.5 8.5 0 1 0 9 9h-9z"/><path d="M14 3a7 7 0 0 1 7 7h-7z"/>',
  btrust: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  bmint: '<circle cx="11" cy="13" r="7.5"/><path d="M19 3v4.5M16.75 5.25h4.5"/>',
  names: '<path d="M3.5 12.5V4h8.5l9 9-8.5 8.5z"/><path d="M8 8.5h.01"/>',
  bid: '<rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="12" r="2.5"/><path d="M14.5 10.5h4M14.5 13.5h3"/>',
  bsearch: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L20.5 20.5"/>',
  bdns: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c-3.5 4-3.5 14 0 18M12 3c3.5 4 3.5 14 0 18"/>',
  bedu: '<path d="M2.5 9.5L12 5l9.5 4.5L12 14z"/><path d="M6.5 11.8v4.2c3 2.5 8 2.5 11 0v-4.2"/>',
  bmaps: '<path d="M12 21s-6.5-6-6.5-11a6.5 6.5 0 0 1 13 0c0 5-6.5 11-6.5 11z"/><circle cx="12" cy="10" r="2.3"/>',
  bjobs: '<rect x="3" y="7.5" width="18" height="12.5" rx="2"/><path d="M9 7.5V5h6v2.5"/>',
  bdrive: '<path d="M7 18.5a4.5 4.5 0 0 1-.6-9A6 6 0 0 1 17.8 9a4.75 4.75 0 0 1-.3 9.5z"/>',
  bsheets: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M3 10h18M9 4v16"/>',
  bcal: '<rect x="3" y="5" width="18" height="15.5" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  bcode: '<path d="M8.5 7l-5 5 5 5M15.5 7l5 5-5 5"/>',
  bagents: '<rect x="5" y="8" width="14" height="11.5" rx="3"/><path d="M12 8V4.5M9.5 13.5h.01M14.5 13.5h.01"/>',
} as const;

export type GlyphSlug = keyof typeof GLYPHS;

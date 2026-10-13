/** "Mint as NFT" for a note design: the extra MAP fields bMint adds to the picture inscription. */
import type { MintDocument } from './types';

export type NoteMapInput = { doc: MintDocument; template: string };

/** MAP fields merged over mint.ts buildMap (app/type/name/description). Values are strings, as MAP needs. */
export function noteMap({ doc, template }: NoteMapInput): Record<string, string> {
  const map: Record<string, string> = {
    bmint: 'note',
    template: template || 'custom',
    size: `${doc.width}x${doc.height}`,
  };
  const serial = doc.layers.find((l) => l.type === 'serial-number' && l.visible);
  if (serial && serial.type === 'serial-number') {
    const c = serial.config;
    map.serial = `${c.prefix}${String(c.startNumber).padStart(c.digits, '0')}`;
  }
  return map;
}

/** The default inscription title for a design. */
export const noteTitle = (doc: MintDocument) => (doc.name.trim() || 'bMint note').slice(0, 100);

/** A file-system-safe name for downloads. */
export const fileBase = (doc: MintDocument) =>
  (doc.name.trim() || 'bmint-note')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'bmint-note';

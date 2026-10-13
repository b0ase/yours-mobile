/** Download names for the note studio's exports. */
import type { MintDocument } from './types';

/** A file-system-safe name for downloads. */
export const fileBase = (doc: MintDocument) =>
  (doc.name.trim() || 'bmint-note')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'bmint-note';

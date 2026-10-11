import { describe, expect, it } from 'bun:test';
import { defaultPictures } from './roomArt';

describe('defaultPictures', () => {
  it('falls back to bAvatar art, never a letter', () => {
    const p = defaultPictures('$VEXVOID');
    expect(p.length).toBe(2);
    expect(p[0]).toContain('/api/bavatar/vexvoid.svg');
    expect(p[1].startsWith('data:image/svg+xml')).toBe(true);
  });
  it('seeds from the issuer when known', () => {
    expect(defaultPictures('Some Token', 'vexvoid')[0]).toContain('/api/bavatar/vexvoid.svg');
  });
});

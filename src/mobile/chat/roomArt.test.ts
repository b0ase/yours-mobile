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

describe('DM avatars', () => {
  it('a DM is keyed on the other person, not the raw "$a ↔ $b" name or the viewer', async () => {
    const { dmPeer } = await import('./messages');
    const room = { name: '$alice ↔ $Bob', ticker: 'DM1' };
    expect(dmPeer(room, 'bob')).toBe('alice');
    expect(dmPeer(room, '$alice')).toBe('bob');
    expect(dmPeer({ name: 'Lounge', ticker: 'LOUNGE' }, 'bob')).toBeNull();
    const p = defaultPictures('$alice ↔ $Bob', dmPeer(room, 'bob'));
    expect(p[0]).toContain('/api/bavatar/alice.svg');
    expect(p.at(-1)!.startsWith('data:image/svg+xml')).toBe(true);
  });
});

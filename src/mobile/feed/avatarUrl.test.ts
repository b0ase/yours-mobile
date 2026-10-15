import { describe, expect, it } from 'bun:test';
import { avatarUrl } from './post';

const TX = 'a'.repeat(64);

describe('avatarUrl', () => {
  it('keeps https', () => expect(avatarUrl('https://pbs.twimg.com/a.jpg')).toBe('https://pbs.twimg.com/a.jpg'));
  it('upgrades http and protocol-relative', () => {
    expect(avatarUrl('http://x.com/a.png')).toBe('https://x.com/a.png');
    expect(avatarUrl('//cdn.x.com/a.png')).toBe('https://cdn.x.com/a.png');
  });
  it('maps chain refs to ORDFS', () => {
    expect(avatarUrl(`b://${TX}`)).toBe(`https://ordfs.network/${TX}_0`);
    expect(avatarUrl(`ord://${TX}_2`)).toBe(`https://ordfs.network/${TX}_2`);
    expect(avatarUrl(`1sat://${TX}`)).toBe(`https://ordfs.network/${TX}_0`);
    expect(avatarUrl(`bitfs://${TX}.out.1.3`)).toBe(`https://ordfs.network/${TX}_1`);
    expect(avatarUrl(TX)).toBe(`https://ordfs.network/${TX}_0`);
    expect(avatarUrl(`${TX}_4`)).toBe(`https://ordfs.network/${TX}_4`);
  });
  it('makes Treechat-relative paths absolute and maps ipfs', () => {
    expect(avatarUrl('/avatars/u.png')).toBe('https://app.treechat.com/avatars/u.png');
    expect(avatarUrl('ipfs://bafyabc')).toBe('https://ipfs.io/ipfs/bafyabc');
  });
  it('drops empty and unsafe values', () => {
    for (const v of [null, undefined, '', '  ', 'javascript:alert(1)', 'data:text/html,x', 'T'])
      expect(avatarUrl(v)).toBeNull();
  });
});

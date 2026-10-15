import { describe, expect, it } from 'bun:test';
import { normIdentity, offStageCameras, ownerOfIdentity, screenFeeds, screenKey } from './stageTiles';

describe('screenFeeds', () => {
  it('shows every screen share, not just the newest (Help Desk bug, 15 Oct 2026)', () => {
    const f = screenFeeds(['alice.screen', 'bob', 'carol.screen'], 'me', false);
    expect(f.map((x) => x.owner)).toEqual(['carol', 'bob', 'alice']);
    expect(f.map((x) => x.key)).toEqual(['screen:carol.screen', 'screen:bob', 'screen:alice.screen']);
  });

  it('labels each tile by handle with "· screen"', () => {
    expect(screenFeeds(['alice.screen'], 'me', false)[0].label).toBe('$alice · screen');
  });

  it('puts my own broadcast first and marks it mine', () => {
    const f = screenFeeds(['alice.screen'], 'Me', true);
    expect(f[0]).toMatchObject({ id: 'me', owner: 'me', mine: true });
    expect(f[1]).toMatchObject({ owner: 'alice', mine: false });
  });

  it('dedupes one identity by case and $', () => {
    expect(screenFeeds(['$Alice', 'alice'], 'me', false)).toHaveLength(1);
  });

  it('is empty when nobody shares', () => {
    expect(screenFeeds([], 'me', false)).toEqual([]);
  });
});

describe('offStageCameras', () => {
  it('keeps a camera whose owner has no stage tile', () => {
    expect(offStageCameras(['host', 'dave'], ['host'])).toEqual(['dave']);
  });

  it('matches LiveKit identities to stage handles ignoring case and $', () => {
    expect(offStageCameras(['$Host', 'BOB'], ['host', 'bob'])).toEqual([]);
  });
});

describe('identities', () => {
  it('normalises and strips the screen-device suffix', () => {
    expect(normIdentity(' $Alice ')).toBe('alice');
    expect(ownerOfIdentity('Alice.screen')).toBe('alice');
    expect(screenKey('$Bob')).toBe('screen:bob');
  });
});

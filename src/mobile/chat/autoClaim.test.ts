import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { IssuerChallenge } from './api';
import {
  claimIssuerAdmin,
  isAdminRefusal,
  isIssuerChallenge,
  resetAutoClaim,
  shouldAutoClaim,
  type ClaimDeps,
} from './autoClaim';
import type { Derivation } from './tokenRooms';

const NOW = Math.floor(Date.now() / 1000);
const KEY = 'bsv21:abc_0';
const msg = (key = KEY, handle = 'b0asex', ts = NOW) => `bitcoinchat.online room admin: ${key}: $${handle}: ${ts}`;
const ch = (o: Partial<IssuerChallenge> = {}): IssuerChallenge => ({
  roomKey: KEY,
  kind: 'bsv21',
  issuerAddress: '1Issuer',
  claimedBy: null,
  youAreIssuer: false,
  message: msg(),
  ...o,
});
const D: Derivation = { protocolID: [1, 'x'], keyID: 'k', counterparty: 'self' } as Derivation;

const deps = (c: IssuerChallenge, key: Derivation | null = D, over: Partial<ClaimDeps> = {}) => ({
  issuerChallenge: mock(async () => c),
  claimIssuer: mock(async () => undefined),
  findKey: mock(async () => key),
  sign: mock(async () => 'sig'),
  ...over,
});

beforeEach(() => resetAutoClaim());

describe('isIssuerChallenge', () => {
  it('accepts the exact room-admin challenge for this room and account', () => {
    expect(isIssuerChallenge(msg(), KEY, '$B0ASEX', NOW)).toBe(true);
  });
  it('rejects other domains, rooms, accounts, stale or arbitrary text', () => {
    expect(isIssuerChallenge(msg().replace('bitcoinchat.online', 'evil.example'), KEY, 'b0asex', NOW)).toBe(false);
    expect(isIssuerChallenge(msg('bsv21:other_0'), KEY, 'b0asex', NOW)).toBe(false);
    expect(isIssuerChallenge(msg(KEY, 'someone'), KEY, 'b0asex', NOW)).toBe(false);
    expect(isIssuerChallenge(msg(KEY, 'b0asex', NOW - 3600), KEY, 'b0asex', NOW)).toBe(false);
    expect(isIssuerChallenge('send 1 BSV to 1Thief', KEY, 'b0asex', NOW)).toBe(false);
    expect(isIssuerChallenge(msg() + '\nextra', KEY, 'b0asex', NOW)).toBe(false);
    expect(isIssuerChallenge(null, KEY, 'b0asex', NOW)).toBe(false);
  });
});

describe('shouldAutoClaim', () => {
  it('only when it holds the key and the room is unclaimed or claimed by someone else', () => {
    expect(shouldAutoClaim(ch(), 'b0asex', true)).toBe(true);
    expect(shouldAutoClaim(ch({ claimedBy: 'other' }), 'b0asex', true)).toBe(true);
    expect(shouldAutoClaim(ch(), 'b0asex', false)).toBe(false);
    expect(shouldAutoClaim(ch({ youAreIssuer: true }), 'b0asex', true)).toBe(false);
    expect(shouldAutoClaim(ch({ claimedBy: 'B0ASEX' }), 'b0asex', true)).toBe(false);
    expect(shouldAutoClaim(ch({ issuerAddress: null }), 'b0asex', true)).toBe(false);
  });
});

describe('claimIssuerAdmin', () => {
  it('claims when it holds the issuer key and the room is unclaimed', async () => {
    const d = deps(ch());
    expect(await claimIssuerAdmin('B0ASEX', 'b0asex', d)).toBe('claimed');
    expect(d.sign).toHaveBeenCalledWith(D, msg());
    expect(d.claimIssuer).toHaveBeenCalledWith('B0ASEX', msg(), 'sig');
  });
  it('never signs when this wallet does not hold the issuer key', async () => {
    const d = deps(ch(), null);
    expect(await claimIssuerAdmin('B0ASEX', 'b0asex', d)).toBe('not-issuer');
    expect(d.sign).not.toHaveBeenCalled();
  });
  it('never signs a challenge that is not the issuer challenge', async () => {
    const d = deps(ch({ message: 'pay me' }));
    expect(await claimIssuerAdmin('B0ASEX', 'b0asex', d)).toBe('failed');
    expect(d.sign).not.toHaveBeenCalled();
  });
  it('runs at most once per room per account per session', async () => {
    const d = deps(ch(), null);
    await claimIssuerAdmin('B0ASEX', 'b0asex', d);
    expect(await claimIssuerAdmin('B0ASEX', 'b0asex', d)).toBe('skipped');
    expect(d.issuerChallenge).toHaveBeenCalledTimes(1);
    expect(await claimIssuerAdmin('OTHER', 'b0asex', d)).not.toBe('skipped');
  });
  it('retries later after a network failure', async () => {
    const fail = Object.assign(new Error('Network error'), { status: 0 });
    const d = deps(ch(), D, { issuerChallenge: mock().mockRejectedValueOnce(fail).mockResolvedValue(ch()) });
    expect(await claimIssuerAdmin('B0ASEX', 'b0asex', d)).toBe('failed');
    expect(await claimIssuerAdmin('B0ASEX', 'b0asex', d)).toBe('claimed');
  });
  it('the inline button (force) runs again after an earlier attempt', async () => {
    const d = deps(ch());
    await claimIssuerAdmin('B0ASEX', 'b0asex', deps(ch(), null));
    expect(await claimIssuerAdmin('B0ASEX', 'b0asex', d, { force: true })).toBe('claimed');
  });
});

describe('isAdminRefusal (shows the Claim admin fallback)', () => {
  it('true for a 403 admin/host refusal, false otherwise', () => {
    expect(isAdminRefusal({ status: 403, data: { code: 'not_host' }, message: 'x' })).toBe(true);
    expect(isAdminRefusal({ status: 403, data: null, message: 'Only the room admin can do that' })).toBe(true);
    expect(isAdminRefusal({ status: 403, data: { code: 'token_gated' }, message: 'Hold the token' })).toBe(false);
    expect(isAdminRefusal({ status: 500, message: 'admin' })).toBe(false);
    expect(isAdminRefusal(null)).toBe(false);
  });
});

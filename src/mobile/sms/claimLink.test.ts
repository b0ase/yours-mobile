import { describe, expect, it, beforeEach } from 'bun:test';
import { PrivateKey } from '@bsv/sdk';
import {
  CLAIM_SESSION_KEY,
  CLAIM_SESSION_TTL_MS,
  ClaimApi,
  captureClaim,
  claimView,
  clearClaim,
  isTerminal,
  parseClaimLocation,
  parsePublicDrop,
  pendingClaim,
  type Lookup,
  type PublicDrop,
} from './claimLink';
import { mayReclaim, parseDrops } from './phoneApi';
import type { Caller } from './phoneApi';

const WIF = PrivateKey.fromRandom().toWif();
const TXID = 'ab'.repeat(32);
const CODE = 'Abc123_-xyzQWERTY';
const HASH = `#k=${WIF}&t=${TXID}`;

const memStore = () => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
};
const win = (pathname: string, hash: string, search = '') => {
  const calls: (string | undefined)[] = [];
  const w = {
    location: { pathname, hash, search },
    history: {
      replaceState: (_d: unknown, _u: string, url?: string) => {
        calls.push(url);
        w.location.hash = '';
      },
    },
  };
  return { w, calls };
};

describe('claim link: fragment handling', () => {
  beforeEach(() => clearClaim(memStore()));

  it('parses /claim/t/<code>#k=…&t=…', () => {
    expect(parseClaimLocation(`/claim/t/${CODE}`, HASH)).toEqual({ code: CODE, wif: WIF, txid: TXID });
    expect(parseClaimLocation(`/claim/t/${CODE}`, `#k=${WIF}`)?.txid).toBeNull();
    expect(parseClaimLocation(`/claim/t/${CODE}`, '#k=notakey')).toBeNull();
    expect(parseClaimLocation('/claim/x/abc', HASH)).toBeNull();
    expect(parseClaimLocation('/claim/t/a b', HASH)).toBeNull();
  });

  it('reads the key into memory and scrubs it from the address bar at once', () => {
    const s = memStore();
    const { w, calls } = win(`/claim/t/${CODE}`, HASH, '?x=1');
    const link = captureClaim(w, s, 1000);
    expect(link).toEqual({ code: CODE, wif: WIF, txid: TXID });
    expect(pendingClaim()).toEqual(link);
    expect(calls).toEqual([`/claim/t/${CODE}?x=1`]);
    expect(calls.join('')).not.toContain(WIF);
    expect(w.location.hash).toBe('');
  });

  it('scrubs a malformed fragment too', () => {
    const { w, calls } = win(`/claim/t/${CODE}`, '#k=garbage');
    expect(captureClaim(w, memStore())).toBeNull();
    expect(calls.length).toBe(1);
  });

  it('leaves other pages alone', () => {
    const { w, calls } = win('/names', '#section');
    expect(captureClaim(w, memStore())).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('survives the onboarding reload from this tab only, and expires', () => {
    const s = memStore();
    captureClaim(win(`/claim/t/${CODE}`, HASH).w, s, 1000);
    clearClaimMemoryOnly();
    expect(captureClaim(win('/', '').w, s, 2000)?.wif).toBe(WIF);
    clearClaimMemoryOnly();
    expect(captureClaim(win('/', '').w, s, 1000 + CLAIM_SESSION_TTL_MS + 1)).toBeNull();
    expect(s.m.has(CLAIM_SESSION_KEY)).toBe(false);
  });

  it('clearClaim forgets the key everywhere', () => {
    const s = memStore();
    captureClaim(win(`/claim/t/${CODE}`, HASH).w, s);
    clearClaim(s);
    expect(pendingClaim()).toBeNull();
    expect(s.m.size).toBe(0);
  });

  it('no request carries the key', async () => {
    const seen: string[] = [];
    const call: Caller = async (method, path, body, auth) => {
      seen.push(JSON.stringify({ method, path, body, auth }));
      return path.includes('/public/')
        ? {
            drop: {
              funded_address: '1x',
              amount_sats: 5000,
              status: 'sent',
              expires_at: '2099-01-01T00:00:00Z',
              sender_paymail: 'bob@bwalletx.com',
            },
          }
        : { ok: true };
    };
    const api = new ClaimApi(call);
    const link = parseClaimLocation(`/claim/t/${CODE}`, HASH)!;
    await api.lookup(link.code);
    await api.claimed(link.code, 'cd'.repeat(32));
    expect(seen[0]).toContain(`/api/public/sms-drops/${CODE}`);
    expect(seen[1]).toContain(`/api/bitsign/sms/drops/${CODE}/claimed`);
    for (const s of seen) {
      expect(s).not.toContain(WIF);
      expect(s).not.toContain('k=');
    }
    expect(seen.every((s) => s.includes('"auth":false'))).toBe(true);
  });
});

// Reset the module's memory copy without touching the session store (simulates a page reload).
function clearClaimMemoryOnly() {
  clearClaim(null);
}

const drop = (p: Partial<PublicDrop> = {}): Lookup => ({
  kind: 'ok',
  drop: {
    funded_address: '1x',
    amount_sats: 5000,
    status: 'sent',
    expires_at: '2099-01-01T00:00:00Z',
    sender_paymail: 'bob@bwalletx.com',
    ...p,
  },
});
const base = { phase: 'idle' as const, hasWallet: true, unlocked: true, now: Date.parse('2026-10-16') };

describe('claim state machine', () => {
  it('loading / not found / network', () => {
    expect(claimView({ ...base, lookup: { kind: 'loading' } })).toBe('loading');
    expect(claimView({ ...base, lookup: { kind: 'not_found' } })).toBe('not_found');
    expect(claimView({ ...base, lookup: { kind: 'network' } })).toBe('network');
  });

  it('closed drops: claimed, reclaimed (or failed send), expired', () => {
    expect(claimView({ ...base, lookup: drop({ status: 'claimed' }) })).toBe('already_claimed');
    expect(claimView({ ...base, lookup: drop({ status: 'reclaimed' }) })).toBe('reclaimed');
    expect(claimView({ ...base, lookup: drop({ status: 'failed' }) })).toBe('reclaimed');
    expect(claimView({ ...base, lookup: drop({ expires_at: '2026-10-01T00:00:00Z' }) })).toBe('expired');
  });

  it('no wallet → create; locked → unlock; open → ready', () => {
    expect(claimView({ ...base, hasWallet: false, unlocked: false, lookup: drop() })).toBe('need_wallet');
    expect(claimView({ ...base, unlocked: false, lookup: drop() })).toBe('need_unlock');
    expect(claimView({ ...base, lookup: drop() })).toBe('ready');
  });

  it('claiming → done, or failed with retry', () => {
    expect(claimView({ ...base, phase: 'claiming', lookup: drop() })).toBe('claiming');
    expect(claimView({ ...base, phase: { error: 'x' }, lookup: drop() })).toBe('failed');
    // done wins even after the status flips to claimed on a refetch
    expect(claimView({ ...base, phase: 'done', lookup: drop({ status: 'claimed' }) })).toBe('done');
  });

  it('terminal views forget the key; retryable ones keep it', () => {
    for (const v of ['done', 'already_claimed', 'reclaimed', 'expired', 'not_found'] as const)
      expect(isTerminal(v)).toBe(true);
    for (const v of ['network', 'need_wallet', 'need_unlock', 'ready', 'failed', 'loading'] as const)
      expect(isTerminal(v)).toBe(false);
  });

  it('parses the public drop and rejects junk', () => {
    expect(parsePublicDrop({ drop: { amount_sats: 1, status: 'sent', expires_at: 'x' } })?.status).toBe('sent');
    expect(parsePublicDrop({ drop: { amount_sats: 1, status: 'weird', expires_at: 'x' } })).toBeNull();
    expect(parsePublicDrop({})).toBeNull();
  });
});

describe('sender reclaim rule', () => {
  const now = Date.parse('2026-10-16');
  it('matches bit-sign mayReclaim', () => {
    expect(mayReclaim({ status: 'failed', expires_at: '2099-01-01' }, now)).toBe(true);
    expect(mayReclaim({ status: 'sent', expires_at: '2026-10-01' }, now)).toBe(true);
    expect(mayReclaim({ status: 'sent', expires_at: '2099-01-01' }, now)).toBe(false);
    expect(mayReclaim({ status: 'claimed', expires_at: '2026-10-01' }, now)).toBe(false);
  });
  it('parses the sender list', () => {
    const d = parseDrops({
      drops: [{ code: 'a', to: '•••• 1', amount_sats: 1, status: 'sent', expires_at: 'x' }, { code: 1 }],
    });
    expect(d.length).toBe(1);
  });
});

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { Utils } from '@bsv/sdk';
import {
  CLAIM_WINDOW_MS,
  claimErrorFor,
  claimPending,
  clearPending,
  loadPending,
  memoScript,
  parseSpeakClaim,
  parseSpeakQuote,
  savePending,
  speakOutputs,
  type KV,
  type PendingSpeak,
  type SpeakQuote,
} from './paySpeak';

const A = '1BjTE7Az3eUWQn4K56SxHJUwwy6zoHYp5g';
const B = '13WRxSgUYReyawKo2gbRvKHhDEYb29Xd3K';
const raw = {
  enabled: true,
  price_sats: 5000,
  outputs: [
    { address: A, sats: 3000 },
    { address: B, sats: 2000 },
  ],
  op_return: 'bitsign-speak abc123',
  expires_at: '2026-10-16T12:00:00Z',
  quote_id: 'q1',
};

const memKV = (): KV & { m: Map<string, string> } => {
  const m = new Map<string, string>();
  return {
    m,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
};

const err = (status: number, data: unknown = null) => Object.assign(new Error(`HTTP ${status}`), { status, data });
const pend: PendingSpeak = { ticker: 'LOUNGE', quoteId: 'q1', txid: 'tx1', rawtx: 'beef', paidAt: 1_000 };

describe('pay to speak: quote', () => {
  it('parses an enabled quote', () => {
    const q = parseSpeakQuote(raw);
    expect(q.enabled).toBe(true);
    expect((q as SpeakQuote).priceSats).toBe(5000);
    expect((q as SpeakQuote).quoteId).toBe('q1');
  });

  it('is disabled with the reason, and never invents a price', () => {
    expect(parseSpeakQuote({ enabled: false, reason: 'stage full' })).toEqual({ enabled: false, reason: 'stage full' });
    expect(parseSpeakQuote({ ...raw, price_sats: 0 }).enabled).toBe(false);
    expect(parseSpeakQuote({ ...raw, op_return: '' }).enabled).toBe(false);
    expect(parseSpeakQuote({ ...raw, outputs: [] }).enabled).toBe(false);
    expect(parseSpeakQuote(null).enabled).toBe(false);
  });
});

describe('pay to speak: outputs', () => {
  it('pays each output its sats and ends with the OP_FALSE OP_RETURN memo', () => {
    const q = parseSpeakQuote(raw) as SpeakQuote;
    const outs = speakOutputs(q);
    expect(outs).toHaveLength(3);
    expect(outs[0].satoshis).toBe(3000);
    expect(outs[1].satoshis).toBe(2000);
    expect(outs[2].satoshis).toBe(0);
    // OP_FALSE OP_RETURN <push len> <utf8 memo>
    const memoHex = Utils.toHex(Utils.toArray('bitsign-speak abc123', 'utf8'));
    expect(outs[2].lockingScript).toBe(`006a${(20).toString(16).padStart(2, '0')}${memoHex}`);
    expect(outs[2].lockingScript).toBe(memoScript('bitsign-speak abc123').toHex());
  });

  it('refuses to build without a memo', () => {
    const q = { ...(parseSpeakQuote(raw) as SpeakQuote), opReturn: '' };
    expect(() => speakOutputs(q)).toThrow();
  });
});

describe('pay to speak: persistence', () => {
  it('saves, loads and clears a paid seat', () => {
    const kv = memKV();
    savePending(pend, kv);
    expect(loadPending('lounge', 2_000, kv)).toEqual(pend);
    clearPending('LOUNGE', kv);
    expect(loadPending('LOUNGE', 2_000, kv)).toBeNull();
  });

  it('forgets a seat older than the 24 h claim window', () => {
    const kv = memKV();
    savePending(pend, kv);
    expect(loadPending('LOUNGE', pend.paidAt + CLAIM_WINDOW_MS + 1, kv)).toBeNull();
    expect(kv.m.size).toBe(0);
  });
});

describe('pay to speak: claim and retry', () => {
  const noWait = async () => undefined;

  it('retries "not seen" then succeeds, clearing the record', async () => {
    const kv = memKV();
    savePending(pend, kv);
    let n = 0;
    const out = await claimPending(
      {
        speakQuote: async () => ({}),
        speakClaim: async (_t, body) => {
          expect(body).toEqual({ quote_id: 'q1', txid: 'tx1', rawtx: 'beef' });
          if (++n < 3) throw err(404);
          return {
            ok: true,
            txid: 'tx1',
            role: 'speaker',
            livekit: { token: 'T', url: 'wss://x', room: 'r', grant: {} },
          };
        },
      },
      pend,
      { wait: noWait, kv },
    );
    expect(n).toBe(3);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.claim.livekit?.token).toBe('T');
    expect(kv.m.size).toBe(0);
  });

  it('keeps the payment when the stage is full', async () => {
    const kv = memKV();
    savePending(pend, kv);
    const out = await claimPending(
      { speakQuote: async () => ({}), speakClaim: async () => Promise.reject(err(409, { error: 'stage full' })) },
      pend,
      { wait: noWait, kv },
    );
    expect(out.ok).toBe(false);
    expect(kv.m.size).toBe(1);
  });

  it('drops the payment when the txid is already used', async () => {
    const kv = memKV();
    savePending(pend, kv);
    const out = await claimPending(
      { speakQuote: async () => ({}), speakClaim: async () => Promise.reject(err(409, { error: 'txid used' })) },
      pend,
      { wait: noWait, kv },
    );
    expect(out.ok).toBe(false);
    expect(kv.m.size).toBe(0);
  });

  it('gives up after the tries but keeps the record', async () => {
    const kv = memKV();
    savePending(pend, kv);
    let n = 0;
    await claimPending(
      { speakQuote: async () => ({}), speakClaim: async () => (n++, Promise.reject(err(502))) },
      pend,
      { wait: noWait, kv, tries: 3 },
    );
    expect(n).toBe(3);
    expect(kv.m.size).toBe(1);
  });

  it('parses a claim with no livekit', () => {
    expect(parseSpeakClaim({ ok: true, txid: 't', livekit: null })?.livekit).toBeNull();
    expect(parseSpeakClaim({ error: 'x' })).toBeNull();
  });
});

describe('pay to speak: error mapping', () => {
  it('maps every status', () => {
    expect(claimErrorFor(400, null).action).toBe('retry');
    expect(claimErrorFor(401, null).action).toBe('retry');
    expect(claimErrorFor(402, { error: 'underpaid' })).toEqual({
      message: 'The payment was less than the price.',
      action: 'drop',
    });
    expect(claimErrorFor(402, { error: 'no memo' }).message).toMatch(/memo/);
    expect(claimErrorFor(404, null).action).toBe('retry');
    expect(claimErrorFor(409, { error: 'stage full' }).action).toBe('retry');
    expect(claimErrorFor(409, { error: 'not joined' }).action).toBe('retry');
    expect(claimErrorFor(409, { error: 'space ended' }).action).toBe('drop');
    expect(claimErrorFor(409, { error: 'txid used' }).action).toBe('drop');
    expect(claimErrorFor(409, { error: 'quote expired' }).action).toBe('drop');
    expect(claimErrorFor(429, null).action).toBe('retry');
    expect(claimErrorFor(502, null).action).toBe('retry');
  });
});

describe('pay to speak: store build', () => {
  it('is gated by a literal env check and lazy-loaded', () => {
    const src = readFileSync(new URL('./paySpeak.ts', import.meta.url), 'utf8');
    expect(src).toContain("import.meta.env.VITE_STORE_BUILD === '1'");
    const screen = readFileSync(new URL('./SpaceScreen.tsx', import.meta.url), 'utf8');
    expect(screen).toContain("PAY_TO_SPEAK_ENABLED ? lazy(() => import('./PayToSpeak')) : null");
  });
});

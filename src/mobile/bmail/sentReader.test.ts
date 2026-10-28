import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { SentReader } from './SentReader';
import { NO_SENT_COPY, sentAttachments, sentBody } from './sentCopy';
import type { Sent } from './store';

const sent = (o: Partial<Sent> = {}): Sent => ({
  id: 'ab'.repeat(16),
  to: `02${'b'.repeat(64)}`,
  toLabel: '$bailey',
  at: Date.UTC(2026, 9, 28, 12),
  subject: 'Board minute',
  body: 'Please sign the minute attached.',
  sats: 1500,
  replyPaidSats: 0,
  txid: '7a2c64ea897630acd8b52f4a67103b939d0bb9dcfa16dd1d8d018bb124125f58',
  ...o,
});
const html = (s: Sent) => renderToStaticMarkup(createElement(SentReader, { s, money: (n: number) => `${n} sats` }));

describe('sent letters open read-only', () => {
  test('opening a sent letter shows its body, recipient, subject, postage and txid', () => {
    const out = html(sent());
    expect(out).toContain('Please sign the minute attached.');
    expect(out).toContain('To $bailey');
    expect(out).toContain('Board minute');
    expect(out).toContain('Postage 1500 sats');
    expect(out).toContain('7a2c64ea897630acd8b52f4a67103b939d0bb9dcfa16dd1d8d018bb124125f58');
    expect(out).not.toContain(NO_SENT_COPY);
  });

  test('a past letter without a kept body shows the plain message, not a blank', () => {
    for (const body of ['', '   ', undefined as unknown as string]) {
      const s = sent({ body });
      expect(sentBody(s)).toBeNull();
      expect(html(s)).toContain(NO_SENT_COPY);
    }
  });

  test('lists what went with it', () => {
    expect(
      sentAttachments(sent({ offer: {}, ordinal: { txid: 'f'.repeat(64), deliveries: [], name: 'Cert 011' } })),
    ).toEqual(['Company offer', 'NFT: Cert 011']);
    expect(sentAttachments(sent())).toEqual([]);
  });
});

import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import type { OneSatContext } from '@1sat/actions';
import {
  buildGrant,
  FACTS,
  factAvailable,
  isAppKey,
  sendGrant,
  shareGrantMessage,
  SHARE_GRANT_PROTOCOL,
} from './factShare';

const app = PrivateKey.fromRandom().toPublicKey().toString();

describe('factShare', () => {
  test('message matches bit-sign format with sorted fields', () => {
    expect(
      shareGrantMessage({
        ownerPubkey: 'o',
        granteePubkey: 'g',
        fields: ['sanctions', 'document_country'],
        expiresAt: 'e',
        signedAt: 's',
      }),
    ).toBe(
      'bit-sign kyc share grant\nidentity_key:o\ngrantee:g\nfields:document_country,sanctions\nexpires_at:e\nsigned_at:s',
    );
  });

  test('only server-grantable facts are available, one field each', () => {
    const avail = FACTS.filter(factAvailable);
    expect(avail.map((f) => f.id)).toEqual(['verified', 'country', 'strength', 'sanctions']);
    for (const f of avail) expect(f.fields.length).toBe(1);
    expect(isAppKey(app)).toBe(true);
    expect(isAppKey('nope')).toBe(false);
  });

  test('grant is signed by the identity key and verifies like bit-sign does', async () => {
    const wallet = new ProtoWallet(PrivateKey.fromRandom());
    const ctx = { wallet } as unknown as OneSatContext;
    const fact = FACTS.find((f) => f.id === 'country')!;
    const g = await buildGrant({ ctx, grantee: app, fact, days: 30, now: Date.parse('2026-10-16T00:00:00Z') });
    expect(g.fields).toEqual(['document_country']);
    expect(Date.parse(g.expires_at) - Date.parse(g.signed_at)).toBe(30 * 86_400_000);
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(
        shareGrantMessage({
          ownerPubkey: g.identity_key,
          granteePubkey: g.grantee,
          fields: g.fields,
          expiresAt: g.expires_at,
          signedAt: g.signed_at,
        }),
        'utf8',
      ),
      signature: Utils.toArray(g.signature, 'hex'),
      protocolID: SHARE_GRANT_PROTOCOL,
      keyID: '1',
      counterparty: g.identity_key,
    });
    expect(valid).toBe(true);
  });

  test('503 reads as not available yet', async () => {
    const http = async () => ({ status: 503, data: { error: 'grants_unavailable' } });
    const r = await sendGrant(http, 't', {} as never);
    expect(r).toEqual({ ok: false, reason: 'unavailable', message: 'Not available yet. Nothing was shared.' });
    expect(await sendGrant(async () => ({ status: 201, data: { ok: true } }), 't', {} as never)).toEqual({ ok: true });
  });
});

describe('revoke', () => {
  test('signs bit-sign revoke message under the revoke protocol and posts to /grants/<id>', async () => {
    const { revokeGrant, shareRevokeMessage, SHARE_REVOKE_PROTOCOL } = await import('./factShare');
    const wallet = new ProtoWallet(PrivateKey.fromRandom());
    const ctx = { wallet } as unknown as OneSatContext;
    let seen: { url: string; body: { identity_key: string; signed_at: string; signature: string } } | null = null;
    const http = async (req: { url: string; body?: unknown }) => {
      seen = req as never;
      return { status: 200, data: { ok: true } };
    };
    const r = await revokeGrant({ http: http as never, token: 't', ctx, grantId: 'ABC', origin: 'https://x' });
    expect(r).toEqual({ ok: true });
    expect(seen!.url).toBe('https://x/api/bitsign/identity/cert/grants/ABC');
    const b = seen!.body;
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(
        shareRevokeMessage({ ownerPubkey: b.identity_key, grantId: 'ABC', signedAt: b.signed_at }),
        'utf8',
      ),
      signature: Utils.toArray(b.signature, 'hex'),
      protocolID: SHARE_REVOKE_PROTOCOL,
      keyID: '1',
      counterparty: b.identity_key,
    });
    expect(valid).toBe(true);
    expect(shareRevokeMessage({ ownerPubkey: 'o', grantId: 'ABC', signedAt: 's' })).toBe(
      'bit-sign kyc share revoke\nidentity_key:o\ngrant_id:abc\nsigned_at:s',
    );
  });

  test('list 503 is unavailable', async () => {
    const { listGrants } = await import('./factShare');
    expect(await listGrants(async () => ({ status: 503, data: null }), 't')).toEqual({
      ok: false,
      reason: 'unavailable',
    });
  });
});

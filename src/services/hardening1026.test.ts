// b-Aware 26 Oct 2026: N3-3 (payment recipients), N3-4 (Deny/Escape), N3-5 (paymail capability URLs), N3-6 (nonce).
import { describe, expect, test } from 'bun:test';
import { PrivateKey, ProtoWallet, Utils } from '@bsv/sdk';
import { escapeDenies, sheetControls } from '../pages/requests/sheetControls';
import { describeLockingScript, guardSpendRecipients, takeRecipientsForSheet } from './spendRecipients';
import { buildSheetModel, type BundleRequest } from './permissionBundle';
import { discoverHost, fill } from '../mobile/names/names';
import { NONCE_ACTIONS, signRequest, signedMessage } from '../mobile/names/paymail';

describe('N3-4: refusing is always possible', () => {
  test('Deny waits only for an answer being sent; Allow also for arming, hold and unread lines', () => {
    for (const armed of [true, false])
      for (const hold of [true, false])
        for (const mustRead of [true, false]) {
          const c = sheetControls({ busy: false, armed, hold, mustRead });
          expect(c.denyDisabled).toBe(false);
          expect(c.allowDisabled).toBe(!armed || hold || mustRead);
        }
    expect(sheetControls({ busy: true, armed: true, hold: false, mustRead: false })).toEqual({
      allowDisabled: true,
      denyDisabled: true,
    });
  });

  test('Escape means Not now, except while an answer is being sent', () => {
    expect(escapeDenies({ key: 'Escape' }, false)).toBe(true);
    expect(escapeDenies({ key: 'Escape' }, true)).toBe(false);
    expect(escapeDenies({ key: 'Enter' }, false)).toBe(false);
    expect(escapeDenies({ key: 'Escape', defaultPrevented: true }, false)).toBe(false);
  });
});

describe('N3-3: the payment sheet lists where the outputs go', () => {
  const pkh = 'ab'.repeat(20);
  const addr = Utils.toBase58Check(Utils.toArray(pkh, 'hex'), [0]);
  test('describes P2PKH, ordinal/token, OP_RETURN and other scripts', () => {
    expect(describeLockingScript(`76a914${pkh}88ac`)).toBe(addr);
    expect(describeLockingScript(`0063036f7264${'00'.repeat(4)}6876a914${pkh}88ac`)).toBe(`${addr} (token or ordinal)`);
    expect(describeLockingScript('006a0568656c6c6f')).toBe('data (OP_RETURN)');
    expect(describeLockingScript('6a0568656c6c6f')).toBe('data (OP_RETURN)');
    expect(describeLockingScript('a914' + 'cd'.repeat(20) + '87')).toBe('a custom script');
    expect(describeLockingScript(undefined)).toBe('a custom script');
  });

  test('the outputs of the running action reach the sheet, and are gone after it', async () => {
    let seen: unknown[] = [];
    const m = guardSpendRecipients(
      {
        createAction: async () => {
          seen = takeRecipientsForSheet('site.example');
          return {};
        },
      },
      { adminOriginator: 'admin', normalize: (o) => o },
    );
    await m.createAction(
      {
        outputs: [
          { lockingScript: `76a914${pkh}88ac`, satoshis: 1000 },
          { lockingScript: '006a00', satoshis: 0 },
        ],
      },
      'site.example',
    );
    expect(seen).toEqual([
      { to: addr, satoshis: 1000 },
      { to: 'data (OP_RETURN)', satoshis: 0 },
    ]);
    expect(takeRecipientsForSheet('site.example')).toEqual([]);
  });

  test('the sheet model carries them on the payment', () => {
    const model = buildSheetModel({
      originator: 'site.example',
      items: [
        {
          requestID: 'p',
          type: 'spending',
          originator: 'site.example',
          spending: { satoshis: 1000 },
          recipients: [{ to: addr, satoshis: 1000 }],
        } as BundleRequest,
      ],
    } as never);
    expect(model.payment?.recipients).toEqual([{ to: addr, satoshis: 1000 }]);
  });
});

describe('N3-5: paymail capability URLs', () => {
  test('https on the paymail domain or a subdomain', () => {
    expect(fill('https://example.org/id/{alias}@{domain.tld}', 'bob', 'example.org')).toBe(
      'https://example.org/id/bob@example.org',
    );
    expect(fill('https://api.example.org/id/{alias}@{domain.tld}', 'bob', 'example.org')).toMatch(/^https:\/\/api\./);
  });

  test('our own names may use our paymail host', () => {
    expect(fill('https://pay.bwallet.space/api/paymail/id/{alias}@{domain.tld}', 'bob', 'bwalletx.com')).toMatch(
      /^https:\/\/pay\.bwallet\.space\//,
    );
    expect(() => fill('https://pay.bwallet.space/id/{alias}@{domain.tld}', 'bob', 'example.org')).toThrow(/unsafe/);
  });

  test('refused: http, another host, IP literals, private names, credentials', () => {
    for (const tpl of [
      'http://example.org/id/{alias}',
      'https://evil.example/id/{alias}',
      'https://example.org.evil.example/id/{alias}',
      'https://127.0.0.1/id/{alias}',
      'https://[::1]/id/{alias}',
      'https://192.168.1.1/id/{alias}',
      'https://user:pw@example.org/id/{alias}',
      'file:///etc/passwd',
      'not a url',
    ])
      expect(() => fill(tpl, 'bob', 'example.org')).toThrow();
    expect(() => fill('https://localhost/id/{alias}', 'bob', 'localhost')).toThrow(/unsafe/);
    expect(() => fill('https://printer.local/id/{alias}', 'bob', 'printer.local')).toThrow(/unsafe/);
  });

  test('the SRV target is allowed once discovered; a private SRV target is ignored', async () => {
    const srv = (target: string) => async () =>
      new Response(JSON.stringify({ Answer: [{ type: 33, data: `10 100 443 ${target}.` }] }));
    expect(() => fill('https://pm.hostco.example/id/{alias}', 'bob', 'srvdemo.io')).toThrow(/unsafe/);
    expect(await discoverHost(srv('pm.hostco.example'), 'srvdemo.io')).toBe('pm.hostco.example');
    expect(fill('https://pm.hostco.example/id/{alias}', 'bob', 'srvdemo.io')).toBe('https://pm.hostco.example/id/bob');
    expect(await discoverHost(srv('10.0.0.5'), 'privsrv.io')).toBe('privsrv.io');
    expect(() => fill('https://10.0.0.5/id/{alias}', 'bob', 'privsrv.io')).toThrow(/unsafe/);
  });
});

describe('N3-6: signed paymail requests carry a nonce', () => {
  const wallet = new ProtoWallet(PrivateKey.fromRandom());
  test('nonce actions get a fresh random nonce inside the signed fields', async () => {
    const a = await signRequest(wallet, 'apps-get', {});
    const b = await signRequest(wallet, 'apps-get', {});
    expect(a.fields.nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(a.fields.nonce).not.toBe(b.fields.nonce);
    const { valid } = await new ProtoWallet('anyone').verifySignature({
      data: Utils.toArray(
        signedMessage('apps-get', { ...a.fields, identityKey: a.identityKey, timestamp: String(a.timestamp) }),
        'utf8',
      ),
      signature: Utils.toArray(a.signature, 'hex'),
      protocolID: [2, 'bwallet paymail'],
      keyID: '1',
      counterparty: a.identityKey,
    });
    expect(valid).toBe(true);
  });

  test('stored proofs (ord, bind, release) keep their fixed fields', async () => {
    for (const action of ['ord', 'bind', 'release']) {
      expect(NONCE_ACTIONS.has(action)).toBe(false);
      expect((await signRequest(wallet, action, { alias: 'x' })).fields.nonce).toBeUndefined();
    }
  });
});

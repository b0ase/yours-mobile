import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { WalletPermissionsManager } from '@bsv/wallet-toolbox-client';
import { guardLabelsOnSpend } from './labelsOnSpend';
import { guardReservedBaskets } from './reservedBaskets';
import {
  guardReservedLabels,
  isReservedLabel,
  isReservedLabelProtocol,
  LABEL_METHODS,
  RESERVED_LABEL_PREFIXES,
  RESERVED_LABEL_REFUSAL,
  RESERVED_LABELS_VERSION,
  reservedLabelRefusal,
  revokeReservedLabelGrants,
  withoutReservedLabels,
} from './reservedLabels';
import { guardReservedProtocols } from './reservedProtocols';
import { guardSiteTokens } from './siteTokens';
import { guardSpendRecipients } from './spendRecipients';
import { stampLabel, usedLabel } from '../mobile/bmail/client';

const ADMIN = 'admin.bwalletx';
const SITE = 'site.example';
const TXID = 'ab'.repeat(32);
const STAMP = `bmail stamp ${TXID}.0`;
const PAID = `bmail paid ${TXID}.0 ${'cd'.repeat(20)}`;

describe('reserved action labels', () => {
  // Changing the list is a security decision: bump RESERVED_LABELS_VERSION and this test together.
  test('the list is pinned', () => {
    expect(RESERVED_LABELS_VERSION).toBe(1);
    expect(RESERVED_LABEL_PREFIXES).toEqual(['bmail']);
    expect(LABEL_METHODS).toEqual(['createAction', 'internalizeAction', 'listActions']);
  });

  test('a label is reserved as the wallet stores it: trimmed, lower-cased, any white space after the word', () => {
    for (const l of [STAMP, PAID, 'bmail', 'bmail x', '  BMAIL Paid Letter UPPER ', 'BMail\tstamp', 'bmail x'])
      expect(isReservedLabel(l)).toBe(true);
    for (const l of ['bmailer', 'my bmail', 'b mail stamp', 'tokenblaster', '', undefined, 7, ['bmail x']])
      expect(isReservedLabel(l)).toBe(false);
  });

  test("bMail's own record labels are reserved, whatever the letter", () => {
    const p = { txid: TXID, outputIndex: 3 };
    expect(isReservedLabel(stampLabel(p))).toBe(true);
    expect(isReservedLabel(usedLabel(p, '02' + 'ee'.repeat(32), 'letter 00ff'))).toBe(true);
  });

  test('the permission request for one is recognised, in any case and spacing', () => {
    for (const name of [
      `action label ${STAMP}`,
      'Action Label BMAIL paid x',
      ' action label  bmail x',
      'action label bmail',
    ])
      expect(isReservedLabelProtocol([1, name])).toBe(true);
    for (const name of ['action label tokenblaster', 'bmail', 'action labels bmail x', 'action label bmailer'])
      expect(isReservedLabelProtocol([1, name])).toBe(false);
    expect(isReservedLabelProtocol(undefined)).toBe(false);
    expect(withoutReservedLabels([{ protocolID: [1, `action label ${PAID}`] }, { protocolID: [1, 'x'] }])).toEqual([
      { protocolID: [1, 'x'] },
    ]);
  });

  test('refusal by method: only the three that take labels, and only a reserved one', () => {
    for (const method of LABEL_METHODS) {
      expect(reservedLabelRefusal(method, { labels: ['fine', ` ${PAID.toUpperCase()}`] })).toContain(
        RESERVED_LABEL_REFUSAL,
      );
      expect(reservedLabelRefusal(method, { labels: ['fine'] })).toBeNull();
      expect(reservedLabelRefusal(method, { labels: 'bmail x' })).toBeNull();
      expect(reservedLabelRefusal(method, {})).toBeNull();
    }
    expect(reservedLabelRefusal('signAction', { labels: [PAID] })).toBeNull();
  });

  const mock = () => {
    const calls: string[] = [];
    const granted: unknown[] = [];
    const m = {
      createAction: async (_a: unknown, o?: string) => (calls.push(`createAction:${o}`), { txid: 'x' }),
      internalizeAction: async (_a: unknown, o?: string) => (calls.push(`internalizeAction:${o}`), { accepted: true }),
      listActions: async (_a: unknown, o?: string) => (calls.push(`listActions:${o}`), { actions: [] }),
      ensureLabelAccess: async (a: { originator?: string }) => (calls.push(`label:${a.originator}`), true),
      ensureProtocolPermission: async (a: { originator?: string }) => (calls.push(`protocol:${a.originator}`), true),
      ensureSpendingAuthorization: async () => true,
      ensureBasketAccess: async () => true,
      listOutputs: async () => ({ outputs: [], totalOutputs: 0 }),
      grantGroupedPermission: async (p: unknown) => void granted.push(p),
    };
    return { m, calls, granted };
  };
  type Wallet = Record<string, (a: unknown, o?: string) => Promise<unknown>>;

  test('the guard refuses a site on every label method, before the wallet is reached; the wallet itself goes through', async () => {
    const { m, calls, granted } = mock();
    const w = guardReservedLabels(m, ADMIN) as unknown as Wallet;
    for (const method of LABEL_METHODS) {
      for (const originator of [SITE, undefined, '', 'ADMIN.BWALLETX'])
        await expect(w[method]({ labels: ['ok', PAID] }, originator)).rejects.toThrow(RESERVED_LABEL_REFUSAL);
      expect(calls).toEqual([]);
      await w[method]({ labels: [STAMP, PAID] }, ADMIN);
      await w[method]({ labels: ['tokenblaster'] }, SITE);
      expect(calls.splice(0)).toEqual([`${method}:${ADMIN}`, `${method}:${SITE}`]);
    }
    await expect(w.ensureLabelAccess({ originator: SITE, label: ` ${STAMP.toUpperCase()}` })).rejects.toThrow(
      RESERVED_LABEL_REFUSAL,
    );
    await expect(
      w.ensureProtocolPermission({ originator: SITE, protocolID: [1, `action label ${PAID}`] }),
    ).rejects.toThrow(RESERVED_LABEL_REFUSAL);
    expect(calls).toEqual([]);
    expect(await w.ensureLabelAccess({ originator: ADMIN, label: STAMP })).toBe(true);
    expect(await w.ensureLabelAccess({ originator: SITE, label: 'tokenblaster' })).toBe(true);
    await w.grantGroupedPermission({
      granted: { protocolPermissions: [{ protocolID: [1, `action label ${PAID}`] }, { protocolID: [1, 'posts'] }] },
    });
    expect(granted).toEqual([{ granted: { protocolPermissions: [{ protocolID: [1, 'posts'] }] } }]);
  });

  test('inside the whole chain of guards, as initWallet builds it: no outer guard lets a reserved label by', async () => {
    const { m, calls } = mock();
    const deps = { adminOriginator: ADMIN, normalize: (o: string) => o };
    const w = guardSiteTokens(
      guardSpendRecipients(
        guardLabelsOnSpend(
          guardReservedBaskets(guardReservedLabels(guardReservedProtocols(m, ADMIN), ADMIN), ADMIN),
          deps,
        ),
        deps,
      ),
      { ...deps, prompt: async () => true },
    ) as unknown as Wallet;
    const pay = { outputs: [{ lockingScript: '51', satoshis: 1000 }], description: 'x' };
    await expect(w.createAction({ ...pay, labels: ['game', PAID] }, SITE)).rejects.toThrow(RESERVED_LABEL_REFUSAL);
    await expect(
      w.internalizeAction({ tx: [1], outputs: [], description: 'x', labels: [STAMP, PAID] }, SITE),
    ).rejects.toThrow(RESERVED_LABEL_REFUSAL);
    await expect(w.listActions({ labels: [STAMP], includeLabels: true }, SITE)).rejects.toThrow(RESERVED_LABEL_REFUSAL);
    expect(calls.filter((c) => !c.startsWith('label') && !c.startsWith('protocol'))).toEqual([]);
    await w.listActions({ labels: [STAMP], includeLabels: true }, ADMIN);
    expect(calls).toContain(`listActions:${ADMIN}`);
  });

  test('with the real permissions manager: a site is refused with no permission request raised', async () => {
    const reached: string[] = [];
    const pm = new WalletPermissionsManager(
      {
        createAction: async () => (reached.push('createAction'), { txid: 'x' }),
        internalizeAction: async () => (reached.push('internalizeAction'), { accepted: true }),
        listActions: async () => (reached.push('listActions'), { actions: [], totalActions: 0 }),
      } as never,
      ADMIN,
      { encryptWalletMetadata: false },
    );
    const asked: unknown[] = [];
    pm.bindCallback('onProtocolPermissionRequested', async (r: unknown) => void asked.push(r));
    const w = guardReservedLabels(pm, ADMIN) as unknown as Wallet;
    await expect(w.createAction({ description: 'a site call', outputs: [], labels: [PAID] }, SITE)).rejects.toThrow(
      RESERVED_LABEL_REFUSAL,
    );
    await expect(
      w.internalizeAction({ tx: [1], outputs: [], description: 'a site call', labels: [PAID] }, SITE),
    ).rejects.toThrow(RESERVED_LABEL_REFUSAL);
    await expect(w.listActions({ labels: [STAMP] }, SITE)).rejects.toThrow(RESERVED_LABEL_REFUSAL);
    // The manager's own check, should a call reach it another way: refused there too, nothing asked.
    await expect(
      (pm as unknown as { ensureLabelAccess: (a: unknown) => Promise<boolean> }).ensureLabelAccess({
        originator: SITE,
        label: PAID,
        usageType: 'apply',
      }),
    ).rejects.toThrow(RESERVED_LABEL_REFUSAL);
    expect(reached).toEqual([]);
    expect(asked).toEqual([]);
  });

  test("a stored grant for a reserved label is removed; other grants and the wallet's own stay", async () => {
    const key = (originator: string, protocolName: string) => ({
      type: 'protocol',
      originator,
      protocolLevel: 1,
      protocolName,
    });
    let grants = [
      { key: key(SITE, `action label ${PAID}`) },
      { key: key(SITE, 'action label tokenblaster') },
      { key: key(ADMIN, `action label ${PAID}`) },
      { key: { type: 'basket', originator: SITE } },
    ];
    const store = {
      listGrants: async (f?: { type?: string }) => grants.filter((g) => !f?.type || g.key.type === f.type),
      deleteGrant: async (k: never) => void (grants = grants.filter((g) => g.key !== (k as unknown))),
    };
    expect(await revokeReservedLabelGrants(store as never, ADMIN)).toBe(1);
    expect(grants.length).toBe(3);
    expect(await revokeReservedLabelGrants(store as never, ADMIN)).toBe(0);
  });

  // Where the guard sits. Every outside caller (the extension's content script, the phone's in-app browser, bApp
  // frames, paired sites) comes in through background.ts's router and lands on the wallet initWallet builds.
  describe('wiring', () => {
    const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
    const bg = read('../background.ts');
    const init = read('../initWallet.ts');
    test('the router refuses a reserved label from any outside sender, before any wallet or sheet', () => {
      const router = bg.indexOf('if (!isFromExtension && message?.originator !== ADMIN_ORIGINATOR) {');
      const check = bg.indexOf("reservedLabelRefusal(String(message?.action ?? ''), message?.params)");
      const dispatch = bg.indexOf('runDappRequest(processCWIListActions(message, sendResponse))');
      expect(router).toBeGreaterThan(0);
      expect(check).toBeGreaterThan(router);
      expect(dispatch).toBeGreaterThan(check);
    });
    test('the router names the three label methods as the wallet does', async () => {
      const { CWIEventName } = await import('@1sat/wallet-browser');
      expect([CWIEventName.CREATE_ACTION, CWIEventName.INTERNALIZE_ACTION, CWIEventName.LIST_ACTIONS]).toEqual([
        ...LABEL_METHODS,
      ] as never);
    });
    test('no sheet is ever raised for one, and a grouped grant drops it', () => {
      expect(bg).toContain('isReservedLabelProtocol(request.protocolID) &&');
      expect(bg).toContain('return Promise.reject(new Error(RESERVED_LABEL_REFUSAL));');
      expect(bg).toContain('protocolPermissions: withoutReservedLabels(');
      // The refusal comes before the sheetless answers (pinned mint, stream passes) in showPermissionPrompt.
      expect(bg.indexOf('new Error(RESERVED_LABEL_REFUSAL)')).toBeLessThan(bg.indexOf('answerWithoutSheet(request as'));
    });
    test('the wallet chain has the guard inside every outer guard, and stored grants are removed at unlock', () => {
      expect(init).toMatch(/guardReservedBaskets\(\s*guardReservedLabels\(\s*guardReservedProtocols\(/);
      expect(init).toContain('revokeReservedLabelGrants(permissionStore, ADMIN_ORIGINATOR)');
    });
    test('the wallet builds these labels in one place only: bMail', () => {
      // A label starting with a reserved word, written anywhere else in src, would be a second writer of the record.
      const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
      const src = new URL('..', import.meta.url).pathname;
      const hits = execFileSync(
        'grep',
        ['-rlE', '[`\'"]bmail (stamp|paid|note) ', src, '--include=*.ts', '--include=*.tsx'],
        {
          encoding: 'utf8',
        },
      )
        .split('\n')
        .filter((f) => f && !/\.test\.tsx?$/.test(f))
        .map((f) => f.slice(src.length));
      expect(hits.sort()).toEqual(['mobile/bmail/client.ts']);
    });
  });
});

/**
 * Review of fix/sheet-recipients (LOW): labels on the spend sheet were kept per site, like the recipients were. A
 * second concurrent action from the site (or from the same host on another port) had its label deferred into the
 * FIRST action's run without any sheet, and its spend sheet showed the first action's labels.
 */
import { describe, expect, test } from 'bun:test';
import { normalizeOriginator } from '@1sat/wallet';
import { guardLabelsOnSpend, takeLabelsForSheet } from './labelsOnSpend';

type Spend = {
  originator: string;
  satoshis: number;
  lineItems: { type: string; description: string; satoshis: number }[];
};

const fakeManager = () => {
  const labelSheets: string[] = [];
  const spends: Spend[] = [];
  const answers: (() => void)[] = [];
  const m = {
    config: { seekPermissionWhenApplyingActionLabels: true },
    async ensureLabelAccess(args: { label: string }) {
      labelSheets.push(args.label);
      return true;
    },
    async ensureSpendingAuthorization(args: Spend) {
      spends.push(args);
      await new Promise<void>((r) => answers.push(r));
      return true;
    },
    async hasProtocolPermission() {
      return false;
    },
    async createAction(args: { labels: string[]; outputs: { satoshis: number }[] }, originator?: string) {
      await new Promise((r) => setTimeout(r, 1));
      for (const label of args.labels)
        await (this as typeof m).ensureLabelAccess({ originator, label, usageType: 'apply' } as never);
      const lineItems = args.outputs.map((o) => ({ type: 'output', satoshis: o.satoshis, description: 'x' }));
      // The toolbox's request originator is the hostname only.
      const site = new URL(`https://${originator}`).hostname;
      await (this as typeof m).ensureSpendingAuthorization({ originator: site, satoshis: 1, lineItems });
      return {};
    },
  };
  guardLabelsOnSpend(m, { adminOriginator: 'admin', normalize: normalizeOriginator });
  return { m, labelSheets, spends, answers };
};

describe('labels on the spend sheet belong to their own action', () => {
  for (const second of ['game.example', 'game.example:8443'])
    test(`a concurrent action from ${second} never takes or hides the first one's labels`, async () => {
      const f = fakeManager();
      const a = f.m.createAction({ labels: ['a-label'], outputs: [{ satoshis: 1_000 }] }, 'game.example');
      await new Promise((r) => setTimeout(r, 5));
      const b = f.m.createAction({ labels: ['b-label'], outputs: [{ satoshis: 5_000 }] }, second);
      await new Promise((r) => setTimeout(r, 10));
      const [spendA, spendB] = [...f.spends].sort((x, y) => x.lineItems[0].satoshis - y.lineItems[0].satoshis);
      // B's label was never let through on A's account: it asked on its own sheet.
      expect(f.labelSheets).toEqual(['b-label']);
      expect(takeLabelsForSheet(normalizeOriginator(spendB.originator), spendB)).toEqual([]);
      expect(takeLabelsForSheet(normalizeOriginator(spendA.originator), spendA)).toEqual(['a-label']);
      for (const r of f.answers) r();
      await Promise.all([a, b]);
    });
});

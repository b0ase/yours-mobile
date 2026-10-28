import { describe, expect, test } from 'bun:test';
import * as osp from './oneSatPrompt';

/** b-Aware 28 Oct 2026 (hilmiadi677, H-6): a pending 1Sat sheet survived Forget site; Approve then wrote a grant. */
describe('Forget site cancels pending 1Sat sheets for that origin', () => {
  test('pending prompts from the forgotten site are denied; others stay; Approve afterwards does nothing', async () => {
    const denyFor = (osp as Record<string, unknown>).denyOneSatPromptsFor as ((o: string) => string[]) | undefined;
    expect(typeof denyFor).toBe('function');
    const shown: string[] = [];
    osp.initOneSatPromptBridge({ showPrompt: (id) => shown.push(id) });
    const req = (originator: string) => ({ kind: 'basketAccess', originator, payload: {}, summary: '' }) as never;
    const forgotten = osp.showOneSatPrompt(req('https://site.example'));
    const other = osp.showOneSatPrompt(req('https://other.example'));
    expect(shown).toHaveLength(2);

    const denied = denyFor!('https://site.example');
    expect(denied).toEqual([shown[0]]);
    expect(await forgotten).toBe(false);
    // The stale sheet's Approve finds nothing to approve.
    expect(osp.handleOneSatPermissionResponse(shown[0], true)).toBe(false);
    // The other site's sheet is untouched.
    expect(osp.getPendingOneSatPrompt(shown[1])).toBeDefined();
    expect(osp.handleOneSatPermissionResponse(shown[1], true)).toBe(true);
    expect(await other).toBe(true);
  });

  test('the background Forget-site path calls it', async () => {
    const src = await Bun.file(new URL('../background.ts', import.meta.url)).text();
    const fn = src.slice(src.indexOf('denyPendingPromptsFor = (originator: string) =>'));
    expect(fn.slice(0, fn.indexOf('closeDappPopupIfNoUi()'))).toContain('denyOneSatPromptsFor(originator)');
  });
});

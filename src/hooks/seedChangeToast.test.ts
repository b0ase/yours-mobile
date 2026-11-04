/**
 * Release click-through, 4 Nov 2026: Recover change from my 12 words repeated its whole result in a long toast over the
 * tab bar, and its "Recover change" button wrapped onto two lines on a phone. The toast is one short line now (the
 * result stays under the button), and the row's two buttons sit one per line.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { seedChangeToast } from './seedChangeToast';

const summary =
  'Found 0.0005 BSV of change from your 12 words and added it to your wallet. Stopped at this scan’s limit: 101 more payments were not checked, so some change may still be missing. Change from payments made before this update can’t be found this way.';

describe('Recover change: a short toast, buttons on one line each', () => {
  test('each outcome is one short line, never the result text', () => {
    const cases = [
      seedChangeToast({ success: true, data: { paused: false } }),
      seedChangeToast({ success: true, data: { paused: true } }),
      seedChangeToast({ success: false, data: { paused: true } }),
      seedChangeToast(undefined),
    ];
    expect(cases.map((c) => c.type)).toEqual(['success', 'info', 'error', 'error']);
    for (const c of cases) {
      expect(c.text.length).toBeLessThanOrEqual(60);
      expect(c.text).not.toContain('BSV');
    }
  });

  test('the hook toasts the short line, not the summary it shows under the button', () => {
    const hook = readFileSync(join(import.meta.dir, 'useRecoveryTools.ts'), 'utf8');
    const start = hook.indexOf('const handleRecoverSeedChange');
    const body = hook.slice(start, hook.indexOf('\n  };', start));
    expect(body).toContain('seedChangeToast(');
    expect(body).not.toMatch(/addSnackbar\(text\b/);
    expect(summary.length).toBeGreaterThan(60);
  });

  test('Settings: the Recover change row stacks its two buttons and never wraps a label', () => {
    const settings = readFileSync(join(import.meta.dir, '..', 'pages', 'Settings.tsx'), 'utf8');
    const start = settings.indexOf('Recover change from my 12 words</span>');
    const row = settings.slice(start, settings.indexOf('</div>\n          </div>', start));
    expect(row).toContain('<div className="flex flex-col gap-1">');
    expect(row.match(/whiteSpace: 'nowrap'/g)?.length).toBe(2);
  });
});

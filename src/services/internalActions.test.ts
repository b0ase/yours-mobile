import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const bg = readFileSync(new URL('../background.ts', import.meta.url), 'utf8');

/** The internal-action switch is reached only for actions in noAuthRequired; a case missing there never answers. */
describe('background internal actions', () => {
  const listStart = bg.indexOf('const noAuthRequired = [');
  const list = bg.slice(listStart, bg.indexOf('];', listStart));
  const switchStart = bg.indexOf(
    'switch (message.action) {',
    bg.indexOf('if (noAuthRequired.includes(message.action))'),
  );
  const switchBody = bg.slice(switchStart, bg.indexOf('\n    }\n', switchStart));

  test.each(['MOVE_PROMPT_TO_WINDOW', 'DISMISS_PROMPT_PANEL'])('%s is listed, so its handler runs', (action) => {
    expect(list).toContain(`'${action}'`);
    expect(switchBody).toContain(`case '${action}':`);
  });

  test('every string case in that switch is listed in noAuthRequired', () => {
    const cases = [...switchBody.matchAll(/case '([A-Z0-9_]+)':/g)].map((m) => m[1]);
    expect(cases.length).toBeGreaterThan(10);
    const missing = cases.filter((c) => !list.includes(`'${c}'`));
    expect(missing).toEqual([]);
  });

  test('Open in bWalletX opens the wallet window and answers', () => {
    const h = switchBody.slice(switchBody.indexOf("case 'MOVE_PROMPT_TO_WINDOW':"));
    const body = h.slice(0, h.indexOf('return true;'));
    expect(body).toContain('createNewPopup()');
    expect(body).toContain("sendResponse({ type: 'MOVE_PROMPT_TO_WINDOW', success: true })");
  });
});

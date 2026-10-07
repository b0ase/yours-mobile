import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { ServiceContext, type ServiceContextProps } from '../../contexts/ServiceContext';
import { HomeHeader } from './HomeHeader';

const services = {
  chromeStorageService: { getCurrentAccountObject: () => ({ account: { addresses: { identityAddress: 'id' } } }) },
  apiContext: undefined,
} as unknown as ServiceContextProps;

describe('HOME', () => {
  test('always shows the balance and Send / Receive (the safeguard for an empty dock)', () => {
    const html = renderToStaticMarkup(
      createElement(
        ServiceContext.Provider,
        { value: services },
        createElement(HomeHeader, { onAction: () => undefined }),
      ),
    );
    expect(html).toContain('Balance');
    expect(html).toContain('Send');
    expect(html).toContain('Receive');
  });

  test('the HOME screen renders that header unconditionally (not from the dock)', () => {
    const src = readFileSync(join(import.meta.dir, 'HomeScreen.tsx'), 'utf8');
    expect(src).toContain('header={<HomeHeader');
    expect(src).not.toMatch(/useDock|dockStore/);
  });

  test('the phone layout is off by default', () => {
    const src = readFileSync(join(import.meta.dir, 'flag.ts'), 'utf8');
    expect(src).toContain("=== '1'");
  });
});

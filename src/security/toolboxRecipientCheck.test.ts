import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

/**
 * Security review M1: upstream wallet-toolbox < 2.4.0 signed recipient locking scripts supplied by storage
 * instead of the caller's requested outputs. Our fork (@bopen-io/wallet-toolbox-client, aliased as
 * @bsv/wallet-toolbox-client) carries the fix (verifyRequestedOutputsUnchanged, GHSA-36f9-7rg5-cpf8). The
 * function is not exported, so this test pulls it out of the shipped bundles and runs it, and checks
 * buildSignableTransaction still calls it before building the tx. A toolbox bump that drops the check fails here.
 */
const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('@bsv/wallet-toolbox-client/package.json'));

class WERR_INVALID_PARAMETER extends Error {}

const extract = (src: string, name: string): string => {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} missing from toolbox bundle`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unterminated ${name}`);
};

const P2PKH_A = '76a914' + '11'.repeat(20) + '88ac';
const P2PKH_ATTACKER = '76a914' + 'ee'.repeat(20) + '88ac';

for (const file of ['out/index.client.mjs', 'out/index.client.cjs']) {
  describe(`toolbox recipient check (${file})`, () => {
    const src = readFileSync(join(pkgDir, file), 'utf8');
    const verify = new Function(
      'WERR_INVALID_PARAMETER',
      `${extract(src, 'verifyRequestedOutputsUnchanged')}; return verifyRequestedOutputsUnchanged;`,
    )(WERR_INVALID_PARAMETER) as (storageOutputs: unknown[], args: unknown) => void;
    const args = { outputs: [{ lockingScript: P2PKH_A, satoshis: 1000 }] };

    test('buildSignableTransaction verifies requested outputs before building', () => {
      const body = extract(src, 'buildSignableTransaction');
      expect(body.indexOf('verifyRequestedOutputsUnchanged(')).toBeGreaterThan(-1);
      expect(body.indexOf('verifyRequestedOutputsUnchanged(')).toBeLessThan(body.indexOf('addPlannedOutputs('));
    });

    test('accepts the caller-requested script', () => {
      expect(() =>
        verify([{ vout: 0, providedBy: 'you', lockingScript: P2PKH_A, satoshis: 1000 }], args),
      ).not.toThrow();
    });

    test('refuses a storage-substituted recipient script', () => {
      expect(() =>
        verify([{ vout: 0, providedBy: 'you', lockingScript: P2PKH_ATTACKER, satoshis: 1000 }], args),
      ).toThrow(WERR_INVALID_PARAMETER);
    });

    test('refuses changed satoshis and reclassified outputs', () => {
      expect(() => verify([{ vout: 0, providedBy: 'you', lockingScript: P2PKH_A, satoshis: 999 }], args)).toThrow();
      expect(() =>
        verify([{ vout: 0, providedBy: 'storage', purpose: 'change', lockingScript: P2PKH_A, satoshis: 1000 }], args),
      ).toThrow();
      expect(() => verify([], args)).toThrow();
    });
  });
}

import { useEffect, useState } from 'react';
import { createPasskeyWithPrf, detectPrfSupport, getPrf, type PrfSupport } from './prf';
import { openSeed, sealSeed } from './seedBackup';

/**
 * /passkey-check (only in VITE_SEEDLESS=1 builds): reports what this browser says about WebAuthn PRF and lets a
 * tester prove it end to end with a throwaway passkey ("bWalletX PRF test") and a dummy phrase. No wallet data.
 */
export const PasskeyCheck = () => {
  const [s, setS] = useState<PrfSupport | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const add = (l: string) => setLog((x) => [...x, `${new Date().toLocaleTimeString()}  ${l}`]);

  useEffect(() => {
    detectPrfSupport().then(setS, (e) => add(`detect failed: ${String(e)}`));
  }, []);

  const test = async () => {
    if (!s) return;
    try {
      add(`create() rpId=${s.rpId}…`);
      const c = await createPasskeyWithPrf(s.rpId, 'bWalletX PRF test');
      add(`created ${c.credentialId.slice(0, 10)}…, PRF ${c.prf.length} bytes`);
      const dummy = 'test test test test test test test test test test test junk';
      const blob = await sealSeed(dummy, c.prf, { rpId: s.rpId, credentialId: c.credentialId });
      add('sealed dummy phrase; now get() again to reopen…');
      const g = await getPrf(s.rpId, c.credentialId);
      add(`get() PRF stable across calls: ${g.prf.every((b, i) => b === c.prf[i])}`);
      add(`round-trip: ${(await openSeed(blob, g.prf)) === dummy ? 'PASS' : 'FAIL'}`);
    } catch (e) {
      add(`FAIL: ${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}`);
    }
  };

  const row = (k: string, v: unknown) => (
    <tr key={k}>
      <td className="pr-4 py-1 opacity-70">{k}</td>
      <td className="py-1 font-mono break-all">{String(v)}</td>
    </tr>
  );

  return (
    <div className="p-5 text-sm text-white" style={{ background: '#0b0c0f', minHeight: '100vh' }}>
      <h1 className="text-lg font-bold mb-3">Passkey PRF check</h1>
      <p className="opacity-70 mb-3 text-xs">{navigator.userAgent}</p>
      {s ? (
        <table className="mb-4">
          <tbody>
            {row('origin', s.origin)}
            {row('rpId we would use', s.rpId)}
            {row('secure context', s.secureContext)}
            {row('WebAuthn', s.webauthn)}
            {row('platform authenticator', s.platformAuthenticator)}
            {row('getClientCapabilities extension:prf', s.prfCapability ?? 'not reported')}
            {row('likely to work', s.likely)}
          </tbody>
        </table>
      ) : (
        <p>Checking…</p>
      )}
      {s?.notes.map((n) => (
        <p key={n} className="text-xs opacity-80 mb-1">
          • {n}
        </p>
      ))}
      <button
        type="button"
        onClick={() => void test()}
        disabled={!s?.webauthn}
        className="mt-3 rounded-lg px-4 py-2 font-bold border-0"
        style={{ background: '#F5C542', color: '#000' }}
      >
        Run full test (makes a test passkey)
      </button>
      <pre className="mt-4 text-xs whitespace-pre-wrap" data-testid="passkey-check-log">
        {log.join('\n')}
      </pre>
    </div>
  );
};

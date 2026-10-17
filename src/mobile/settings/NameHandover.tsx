import { useEffect, useState } from 'react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { parseRecipient, resolveRecipient } from '../names/names';
import {
  acceptHandover,
  cancelRelease,
  incomingHandovers,
  releaseName,
  type Handover,
  type WalletName,
} from '../names/paymail';

const f: typeof fetch = (u, i) => fetch(u, i);
const short = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`;

/**
 * Hand a name to another wallet, or accept one (owner, 17 Oct 2026). A name moves only with both signatures:
 * this wallet's release and the recipient's accept. We can't move it for you, and a lost key can't be recovered.
 */
export function NameHandover({ names, onChanged }: { names: WalletName[]; onChanged: () => void }) {
  const { apiContext, chromeStorageService } = useServiceContext();
  const [incoming, setIncoming] = useState<Handover[]>([]);
  const [alias, setAlias] = useState('');
  const [to, setTo] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [released, setReleased] = useState('');
  const plain = names.filter((n) => n.kind === 'plain').map((n) => n.paymail.split('@')[0]);
  // This wallet's other accounts, so moving a name between your own accounts needs no pasted key.
  const current = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress;
  const mine = chromeStorageService
    .getAllAccounts()
    .filter((a) => a.addresses?.identityAddress !== current && a.pubKeys?.identityPubKey)
    .map((a) => ({ name: a.name || short(a.pubKeys.identityPubKey), key: a.pubKeys.identityPubKey }));

  useEffect(() => {
    let live = true;
    apiContext.wallet
      .getPublicKey({ identityKey: true })
      .then(({ publicKey }) => incomingHandovers(f, publicKey))
      .then((h) => live && setIncoming(h))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apiContext.wallet, names]);

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    setMsg('');
    try {
      await fn();
      setMsg(ok);
      onChanged();
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'That did not work');
    } finally {
      setBusy(false);
    }
  };

  const release = () =>
    act(async () => {
      const name = alias || plain[0];
      const r = /^0[23][0-9a-f]{64}$/i.test(to.trim())
        ? { pubkey: to.trim().toLowerCase() }
        : await resolveRecipient(f, parseRecipient(to));
      if (!r.pubkey) throw new Error("Couldn't find that wallet's key");
      await releaseName(f, apiContext.wallet, name, r.pubkey);
      setReleased(name);
    }, 'Released. The name moves when the other wallet accepts it.');

  return (
    <div className="px-4 py-3 flex flex-col gap-2" style={{ borderBottom: '1px solid #ffffff10' }}>
      {incoming.map((h) => (
        <div key={h.alias} className="flex items-center gap-2 text-sm text-white">
          <span className="truncate">
            {h.alias} offered to you by {short(h.from_key)}
          </span>
          <button
            type="button"
            disabled={busy}
            onClick={() => void act(() => acceptHandover(f, apiContext.wallet, h), `${h.alias} is yours.`)}
            className="ml-auto text-xs font-semibold bg-transparent border-0 p-0"
            style={{ color: 'var(--bw-accent)' }}
          >
            Accept
          </button>
        </div>
      ))}
      {plain.length > 0 && (
        <>
          <p className="text-xs m-0" style={{ color: '#98A2B3' }}>
            Hand a name to another wallet. It moves only when that wallet accepts. We can&apos;t move names for you, and
            a lost key can&apos;t be recovered.
          </p>
          {mine.length > 0 && (
            <div className="flex flex-wrap gap-1.5" aria-label="Your other accounts">
              {mine.map((a) => (
                <button
                  key={a.key}
                  type="button"
                  disabled={busy}
                  onClick={() => setTo(a.key)}
                  className="rounded-full px-2.5 py-1 text-xs bg-[var(--bw-surface)] border-0"
                  style={{
                    color: to === a.key ? 'var(--bw-on-accent, #010101)' : '#fff',
                    background: to === a.key ? 'var(--bw-accent)' : undefined,
                  }}
                >
                  {a.name}
                </button>
              ))}
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            {plain.length > 1 && (
              <select
                value={alias || plain[0]}
                onChange={(e) => setAlias(e.target.value)}
                className="rounded-lg bg-[var(--bw-surface)] px-2 py-1.5 text-sm text-white"
              >
                {plain.map((a) => (
                  <option key={a} value={a}>
                    {a}
                  </option>
                ))}
              </select>
            )}
            <input
              value={mine.find((a) => a.key === to)?.name ?? to}
              onChange={(e) => setTo(e.target.value)}
              placeholder="$name, name@domain or identity key"
              aria-label="Hand over to"
              className="flex-1 min-w-[180px] rounded-lg bg-[var(--bw-surface)] px-2 py-1.5 text-sm text-white outline-none"
            />
            <button
              type="button"
              disabled={busy || !to.trim()}
              onClick={() => void release()}
              className="rounded-lg px-3 py-1.5 text-xs font-bold"
              style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent, #010101)' }}
            >
              Hand over
            </button>
          </div>
          {released && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void act(() => cancelRelease(f, apiContext.wallet, released), 'Handover cancelled.')}
              className="self-start text-xs bg-transparent border-0 p-0 underline"
              style={{ color: 'var(--bw-muted)' }}
            >
              Cancel the handover of {released}
            </button>
          )}
        </>
      )}
      {msg && (
        <p role="status" className="text-xs m-0" style={{ color: '#98A2B3' }}>
          {msg}
        </p>
      )}
    </div>
  );
}

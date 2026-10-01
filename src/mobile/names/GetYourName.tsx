import { useEffect, useState } from 'react';
import { listOpns, registerOpns } from '@1sat/actions';
import type { WalletOutput } from '@bsv/sdk';
import { Search } from 'lucide-react';
import { Input } from '../../components/Input';
import { SendConfirmation } from '../../components/SendConfirmation';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { checkOpnsAvailability, bwalletPaymail, type Availability } from './names';
import { getMyName, onMyNameChange, setMyName } from './myName';

/**
 * Settings → Identity → "Get your name". Read-only OpNS search plus the names this wallet
 * already owns (OPNS basket). Binding an owned name to the wallet's identity key runs the
 * bundled registerOpns action behind the standard SendConfirmation sheet; nothing is
 * broadcast before the user confirms. Brand-new names must be mined on the OpNS tree,
 * which @1sat/actions doesn't bundle yet — we show where it would be mined from.
 */
// registerOpns = self-transfer of the 1-sat name ordinal + MAP; ~300-400 bytes at 100 sat/kB.
export const REGISTER_FEE_ESTIMATE_SATS = 50;

const nameOf = (o: WalletOutput) => o.tags?.find((t) => t.startsWith('name:'))?.slice(5);
const idOf = (o: WalletOutput) => o.tags?.find((t) => t.startsWith('id:')) ?? o.outpoint;

export const GetYourName = () => {
  const { theme } = useTheme();
  const { apiContext, chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [myName, setMine] = useState(getMyName(identityAddress));
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Availability | null>(null);
  const [owned, setOwned] = useState<{ name: string; id: string }[]>([]);
  const [pending, setPending] = useState<{ name: string; id: string } | null>(null);
  const [msg, setMsg] = useState('');

  useEffect(() => onMyNameChange(() => setMine(getMyName(identityAddress))), [identityAddress]);

  useEffect(() => {
    if (!apiContext) return;
    listOpns
      .execute(apiContext, { includeTags: true, limit: 100 })
      .then((r) =>
        setOwned(
          r.outputs.flatMap((o) => {
            const name = nameOf(o);
            return name ? [{ name, id: idOf(o) }] : [];
          }),
        ),
      )
      .catch(() => setOwned([]));
  }, [apiContext]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setMsg('');
    try {
      setResult(await checkOpnsAvailability((u, i) => fetch(u, i), query));
    } catch {
      setMsg('Lookup failed — check your connection');
    } finally {
      setBusy(false);
    }
  };

  const register = async (n: { name: string; id: string }) => {
    setPending(null);
    setBusy(true);
    try {
      const res = await registerOpns.execute(apiContext, { id: n.id });
      if (res.error) throw new Error(res.error);
      setMyName(identityAddress, n.name);
      setMsg(`${n.name} is now your name`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  };

  const gray = theme.color.global.gray;
  const fg = theme.color.global.contrast;
  const row = theme.color.global.row;
  const hosted = myName ? bwalletPaymail(myName.replace(/^\$/, '').split('@')[0]) : undefined;

  return (
    <div className="w-full rounded-2xl p-4 flex flex-col gap-3 mb-4" style={{ background: row }}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={{ color: fg }}>
          Get your name
        </span>
        {myName && (
          <span className="text-xs font-semibold" style={{ color: '#FFD24D' }}>
            {myName}
          </span>
        )}
      </div>
      <p className="text-[11px]" style={{ color: gray }}>
        A name people can send to instead of an address. OpNS names live on-chain as 1Sat ordinals.
        {hosted ? ` Your paymail: ${hosted}` : ''}
      </p>

      <div className="flex gap-2 items-center">
        <Input
          theme={theme}
          placeholder="Search a name"
          value={query}
          autoCapitalize="none"
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && search()}
          style={{ width: '100%', margin: 0 }}
        />
        <button
          type="button"
          onClick={search}
          disabled={busy}
          aria-label="Search"
          className="h-10 w-10 flex-shrink-0 rounded-lg flex items-center justify-center border-0 cursor-pointer"
          style={{ background: '#FFD24D', color: '#000' }}
        >
          <Search size={16} />
        </button>
      </div>

      {result?.status === 'invalid' && (
        <p className="text-xs" style={{ color: '#ff4444' }}>
          {result.reason}
        </p>
      )}
      {result?.status === 'taken' && (
        <p className="text-xs" style={{ color: gray }}>
          <b style={{ color: fg }}>{result.name}</b> is taken
          {result.owner ? ` (owner ${result.owner.slice(0, 8)}…)` : ''}.
          {owned.some((o) => o.name === result.name) ? ' You own it — use it below.' : ''}
        </p>
      )}
      {result?.status === 'available' && (
        <p className="text-xs" style={{ color: '#2ecc71' }}>
          {result.name} is available. New OpNS names are mined on the name tree
          {result.mineFrom ? ` (from ${result.mineFrom.slice(0, 10)}…)` : ''}; in-wallet mining is coming soon.
        </p>
      )}

      {owned.length > 0 && (
        <div className="flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-widest" style={{ color: gray }}>
            Names you own
          </span>
          {owned.map((n) => (
            <div key={n.id} className="flex items-center justify-between">
              <span className="text-sm" style={{ color: fg }}>
                {n.name}
              </span>
              {myName === n.name ? (
                <span className="text-xs" style={{ color: '#2ecc71' }}>
                  In use
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPending(n)}
                  className="px-3 py-1 rounded-lg text-xs font-semibold border-0 cursor-pointer"
                  style={{ background: '#FFD24D', color: '#000' }}
                >
                  Use this name
                </button>
              )}
            </div>
          ))}
        </div>
      )}
      {msg && (
        <p className="text-xs" style={{ color: gray }}>
          {msg}
        </p>
      )}

      <SendConfirmation
        show={!!pending}
        theme={theme}
        lineItems={pending ? [{ address: `OpNS: ${pending.name} → your identity key`, amount: '1 sat (kept)' }] : []}
        total={`~${REGISTER_FEE_ESTIMATE_SATS} sats network fee`}
        isProcessing={busy}
        onConfirm={() => pending && register(pending)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};

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
import { DEFAULT_SUPPLY, getPersonalLink, onPersonalChange, personalTicker, validateSupply } from './personalToken';
import { PERSONAL_FEE_ESTIMATE_SATS, deployPersonalToken, openPersonalRoom } from './claimPersonal';

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
  const [pending, setPending] = useState<{ name: string; id: string; tokenOnly?: boolean } | null>(null);
  const [msg, setMsg] = useState('');
  // Personal token: minted with the name (same confirmation) unless already linked.
  const [link, setLink] = useState(getPersonalLink(identityAddress));
  const [withToken, setWithToken] = useState(true);
  const [supply, setSupply] = useState(DEFAULT_SUPPLY);

  useEffect(() => onMyNameChange(() => setMine(getMyName(identityAddress))), [identityAddress]);
  useEffect(() => onPersonalChange(() => setLink(getPersonalLink(identityAddress))), [identityAddress]);

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

  const mintsToken = (name: string) => withToken && !link && !!personalTicker(name);
  const supplyError = validateSupply(supply);

  const mintPersonal = async (name: string) => {
    const l = await deployPersonalToken(apiContext, { identityAddress, name, supply });
    setMsg(`$${l.ticker} minted — ${Number(l.supply).toLocaleString()} to your wallet. Opening your room…`);
    // Signatures only; a fresh token may not be indexed yet — Chat retries until it is.
    openPersonalRoom(apiContext, identityAddress, l)
      .then((t) => setMsg(`$${l.ticker} minted and your room ${t ? `$${t} ` : ''}is open. Invite = send 1 $${l.ticker}.`))
      .catch(() => setMsg(`$${l.ticker} minted. Your room opens in Chat once the token is indexed.`));
  };

  const register = async (n: { name: string; id: string; tokenOnly?: boolean }) => {
    setPending(null);
    setBusy(true);
    try {
      if (!n.tokenOnly) {
        const res = await registerOpns.execute(apiContext, { id: n.id });
        if (res.error) throw new Error(res.error);
        setMyName(identityAddress, n.name);
        setMsg(`${n.name} is now your name`);
      }
      if (n.tokenOnly || mintsToken(n.name)) await mintPersonal(n.name);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Registration failed');
    } finally {
      setBusy(false);
    }
  };

  const confirmLines = (p: { name: string; tokenOnly?: boolean }) => {
    const lines = p.tokenOnly ? [] : [{ address: `OpNS: ${p.name} → your identity key`, amount: '1 sat (kept)' }];
    const t = personalTicker(p.name);
    if (t && (p.tokenOnly || mintsToken(p.name))) {
      lines.push({ address: `New token $${t} (${Number(supply).toLocaleString()}, to you) + your $${t} room`, amount: '1 sat (kept)' });
    }
    return lines;
  };
  const fee = (p: { name: string; tokenOnly?: boolean }) =>
    (p.tokenOnly ? 0 : REGISTER_FEE_ESTIMATE_SATS) + (p.tokenOnly || mintsToken(p.name) ? PERSONAL_FEE_ESTIMATE_SATS : 0);

  // A render helper, not a component: a nested component would remount and drop input focus.
  const tokenOptions = () => {
    const t = personalTicker(myName || query) ?? 'NAME';
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[11px]" style={{ color: gray }}>
          A personal token, ticker <b style={{ color: fg }}>${t}</b>, all to your wallet, plus a room only holders can
          enter. Invite = send 1 ${t}. It's for access, not trading.
        </p>
        <label className="text-[11px] flex items-center gap-2" style={{ color: gray }}>
          Supply
          <input
            value={supply}
            inputMode="numeric"
            onChange={(e) => setSupply(e.target.value)}
            className="flex-1 rounded-lg px-2 py-1 text-xs bg-transparent outline-none"
            style={{ color: fg, border: `1px solid ${supplyError ? '#ff4444' : '#3a2f0c'}` }}
          />
        </label>
        {supplyError && (
          <span className="text-[11px]" style={{ color: '#ff4444' }}>
            {supplyError}
          </span>
        )}
        {myName ? (
          <button
            type="button"
            disabled={busy || !!supplyError}
            onClick={() => setPending({ name: myName, id: '', tokenOnly: true })}
            className="self-start px-3 py-1 rounded-lg text-xs font-semibold border-0 cursor-pointer disabled:opacity-50"
            style={{ background: '#FFD24D', color: '#000' }}
          >
            Create ${t} token + room
          </button>
        ) : null}
      </div>
    );
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
          {!link && (
            <label className="text-[11px] flex items-center gap-2" style={{ color: gray }}>
              <input type="checkbox" checked={withToken} onChange={(e) => setWithToken(e.target.checked)} />
              Also mint my personal token ({supplyError ? 'fix supply below' : `${Number(supply).toLocaleString()}`}) and
              open my room
            </label>
          )}
          {!link && withToken && !myName && tokenOptions()}
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
      {myName && personalTicker(myName) && (
        <div className="flex flex-col gap-2 rounded-xl p-3" style={{ border: '1px solid #3a2f0c' }}>
          <span className="text-[10px] uppercase tracking-widest" style={{ color: gray }}>
            Your token
          </span>
          {link ? (
            <p className="text-xs" style={{ color: fg }}>
              <b style={{ color: '#FFD24D' }}>${link.ticker} ✓</b> · {Number(link.supply).toLocaleString()} minted ·{' '}
              {link.roomTicker ? 'room open' : 'room opens once indexed'}. Invite someone by sending them 1 ${link.ticker}{' '}
              from the room.
            </p>
          ) : (
            tokenOptions()
          )}
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
        lineItems={pending ? confirmLines(pending) : []}
        total={`~${pending ? fee(pending) : REGISTER_FEE_ESTIMATE_SATS} sats network fee`}
        isProcessing={busy}
        onConfirm={() => pending && register(pending)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};

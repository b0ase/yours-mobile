import { useEffect, useRef, useState } from 'react';
import { askNotifyPermissionOnce } from '../notify/engine';
import { buyOpns, listOpns, registerOpns } from '@1sat/actions';
import { ChevronDown, ChevronUp, Search } from 'lucide-react';
import { Input } from '../../components/Input';
import { SendConfirmation } from '../../components/SendConfirmation';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useTheme } from '../../hooks/useTheme';
import { bareName, checkOpnsAvailability, type Availability } from './names';
import { getMyName, onMyNameChange, setMyName } from './myName';
import { DEFAULT_SUPPLY, getPersonalLink, onPersonalChange, personalTicker, validateSupply } from './personalToken';
import { PERSONAL_FEE_ESTIMATE_SATS, deployPersonalToken, openPersonalRoom } from './claimPersonal';
import { showOnWallet } from '../tokens/indexFund';
import { getPaymail, ownedFromOutputs, setPaymail, syncAccountNames, type OwnedName } from './accountName';
import { syncBchatHandle } from './bchatHandle';
import { claimPaymail, paymailAvailable, paymailEnabled, PAYMAIL_ALIAS_RE, toAlias } from './paymail';
import { BWALLET_PAYMAIL_DOMAIN } from './config';
import { estimateMintFee, fetchMineNode } from './opnsMint';
import { EXPECTED_HASHES } from './opnsPow';
import { formatEta, MiningCancelled, mineName, NameTakenError, waitForOrigin, type Progress } from './opnsRegister';
import { moneyNow } from '../money/money';
import { walletOutpoint } from '../market/walletOutpoint';

/**
 * Settings → Identity → "Make your name payable" (rendered under the profile name).
 *
 *  - Paymail: claim <alias>@BWALLET_PAYMAIL_DOMAIN (signed by the identity key, no fee). Hidden when unconfigured.
 *  - OpNS: search; for a free name, Register this name mines it on-device (Web Worker) and broadcasts
 *    one mint per missing character, then auto-runs Use this name (registerOpns). Names you own can be
 *    bound with Use this name; listed names can be bought (buyOpns).
 * Every transaction goes through the standard SendConfirmation sheet first.
 */
// registerOpns = self-transfer of the 1-sat name ordinal + MAP; ~300-400 bytes at 100 sat/kB.
export const REGISTER_FEE_ESTIMATE_SATS = 50;
// Node locking script size used for the fee estimate before the node is loaded (covenant ≈ 6 kB).
export const NODE_SCRIPT_ESTIMATE = 6200;
// Rough phone hash rate for the pre-mining estimate; the live estimate uses the measured rate.
export const PHONE_HASHRATE = 400_000;

type Pending =
  | { kind: 'bind'; name: string; id: string; tokenOnly?: boolean }
  | { kind: 'mint'; name: string; chars: number }
  | { kind: 'buy'; name: string; outpoint: string; price: number };

const f = (u: string, i?: RequestInit) => fetch(u, i);

export const GetYourName = ({
  profileName = '',
  hidePaymail = false,
}: {
  profileName?: string;
  /** The handle sheet claims the paymail itself; hide this block there. */
  hidePaymail?: boolean;
}) => {
  const { theme } = useTheme();
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const ordAddress = account?.addresses?.ordAddress ?? '';
  const [myName, setMine] = useState(getMyName(identityAddress));
  const [query, setQuery] = useState(toAlias(profileName).replace(/_/g, '-'));
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Availability | null>(null);
  const [mineFromDomain, setMineFromDomain] = useState<string | null>(null);
  const [owned, setOwned] = useState<OwnedName[]>([]);
  const [pending, setPending] = useState<Pending | null>(null);
  const [msg, setMsg] = useState('');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [mining, setMining] = useState('');
  const abort = useRef<AbortController | null>(null);
  // Paymail
  const [paymail, setPm] = useState(getPaymail(identityAddress));
  const [alias, setAlias] = useState(toAlias(profileName));
  const [aliasState, setAliasState] = useState<'idle' | 'checking' | 'free' | 'taken' | 'invalid'>('idle');
  // Personal token: minted with the name (same confirmation) unless already linked.
  const [link, setLink] = useState(getPersonalLink(identityAddress));
  const [withToken, setWithToken] = useState(true);
  const [supply, setSupply] = useState(DEFAULT_SUPPLY);

  useEffect(
    () =>
      onMyNameChange(() => {
        setMine(getMyName(identityAddress));
        setPm(getPaymail(identityAddress));
      }),
    [identityAddress],
  );
  useEffect(() => onPersonalChange(() => setLink(getPersonalLink(identityAddress))), [identityAddress]);
  // Default both searches to the profile name once it loads.
  useEffect(() => {
    if (!profileName) return;
    setQuery((q) => q || toAlias(profileName).replace(/_/g, '-'));
    setAlias((a) => a || toAlias(profileName));
  }, [profileName]);
  useEffect(() => () => abort.current?.abort(), []);

  const refreshOwned = async (): Promise<OwnedName[]> => {
    if (!apiContext) return [];
    try {
      const r = await listOpns.execute(apiContext, { includeTags: true, limit: 100 });
      const o = ownedFromOutputs(r.outputs);
      setOwned(o);
      return o;
    } catch {
      setOwned([]);
      return [];
    }
  };
  useEffect(() => {
    void refreshOwned();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiContext]);

  const search = async () => {
    if (!query.trim()) return;
    setBusy(true);
    setMsg('');
    setMineFromDomain(null);
    try {
      const r = await checkOpnsAvailability(f, query);
      setResult(r);
      if (r.status === 'available') setMineFromDomain((await fetchMineNode(f, r.name))?.domain ?? null);
    } catch {
      setMsg('Lookup failed — check your connection');
    } finally {
      setBusy(false);
    }
  };

  // The token + room follow the handle: the paymail alias, else the OpNS name in use.
  const handleName = bareName(paymail) || myName;
  // OpNS stays reachable but closed once there's a paymail handle (and nothing OpNS is in flight).
  const [opnsOpen, setOpnsOpen] = useState(false);
  const showOpns = opnsOpen || !paymail || !!progress || !!mining || (owned.length > 0 && !myName);

  const mintsToken = (name: string) => withToken && !link && !!personalTicker(name);
  const supplyError = validateSupply(supply);

  const mintPersonal = async (name: string) => {
    const l = await deployPersonalToken(apiContext, {
      identityAddress,
      name,
      supply,
      payAddress: account?.addresses?.bsvAddress,
    });
    void showOnWallet(chromeStorageService, l.tokenId);
    void askNotifyPermissionOnce();
    setMsg(`$${l.ticker} minted — ${Number(l.supply).toLocaleString()} to your wallet. Opening your room…`);
    // Signatures only; a fresh token may not be indexed yet — Chat retries until it is.
    openPersonalRoom(apiContext, identityAddress, l)
      .then((t) =>
        setMsg(`$${l.ticker} minted and your room ${t ? `$${t} ` : ''}is open. Invite = send 1 $${l.ticker}.`),
      )
      .catch(() =>
        setMsg(`$${l.ticker} minted. Set up your room from Chat or Settings › My tokens when you're ready.`),
      );
  };

  const bind = async (n: { name: string; id: string; tokenOnly?: boolean }) => {
    if (!n.tokenOnly) {
      const res = await registerOpns.execute(apiContext, { id: n.id, profileName: profileName || undefined });
      if (res.error) throw new Error(res.error);
      setMyName(identityAddress, n.name);
      setMsg(`${n.name} is now your name`);
    }
    if (n.tokenOnly || mintsToken(n.name)) await mintPersonal(n.name);
  };

  /** Mine + broadcast a new name, wait until it's indexed, then bind it (the Use this name flow). */
  const registerNew = async (name: string) => {
    const ctl = new AbortController();
    abort.current = ctl;
    setMining(name);
    try {
      const steps = await mineName({ ctx: apiContext, fetch: f }, name, ctl.signal, setProgress);
      setProgress(null);
      setMsg(`Mined ${name} (${steps.length} transaction${steps.length === 1 ? '' : 's'}). Waiting for it to confirm…`);
      const seen = await waitForOrigin(f, name, ctl.signal);
      const mine = (await refreshOwned()).find((o) => o.name === name);
      if (!mine) {
        setMsg(`${name} was mined. It will appear under Names you own shortly; then tap Use this name.`);
        return;
      }
      if (!seen) setMsg(`${name} isn't indexed yet; binding it anyway…`);
      await bind({ name, id: mine.id });
      syncAccountNames(apiContext, identityAddress, { force: true }).catch(() => undefined);
    } catch (e) {
      setProgress(null);
      if (e instanceof MiningCancelled) setMsg('Mining cancelled. Characters already mined stay yours.');
      else if (e instanceof NameTakenError) {
        setMsg(`${e.message}. Characters already mined stay yours; try another name.`);
        setResult(null);
        void refreshOwned();
      } else throw e;
    } finally {
      abort.current = null;
      setMining('');
    }
  };

  const confirm = async (p: Pending) => {
    setPending(null);
    setBusy(true);
    try {
      if (p.kind === 'bind') await bind(p);
      else if (p.kind === 'mint') await registerNew(p.name);
      else {
        const res = await buyOpns.execute(apiContext, { outpoint: walletOutpoint(p.outpoint), name: p.name });
        if (res.error) throw new Error(res.error);
        setMsg(`You bought ${p.name}. Binding it to your identity…`);
        const mine = (await refreshOwned()).find((o) => o.name === p.name);
        if (mine) await bind({ name: p.name, id: mine.id });
      }
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Failed');
    } finally {
      setBusy(false);
    }
  };

  // ---- paymail ---------------------------------------------------------------
  const ownPaymail = paymail === `${alias}@${BWALLET_PAYMAIL_DOMAIN}`;
  useEffect(() => {
    if (!paymailEnabled()) return;
    if (!alias) return setAliasState('idle');
    if (!PAYMAIL_ALIAS_RE.test(alias)) return setAliasState('invalid');
    setAliasState('checking');
    const t = setTimeout(() => {
      paymailAvailable(f, alias)
        .then((free) => setAliasState(free || ownPaymail ? 'free' : 'taken'))
        .catch(() => setAliasState('idle'));
    }, 400);
    return () => clearTimeout(t);
  }, [alias, ownPaymail]);

  const claim = async () => {
    setBusy(true);
    setMsg('');
    try {
      const pm = await claimPaymail(f, apiContext.wallet, alias, { ordAddress, name: profileName });
      setPaymail(identityAddress, pm);
      setPm(pm);
      await syncBchatHandle(apiContext, pm, { signIn: true });
      setMsg(`${pm} is yours. People can pay it from any paymail wallet.`);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : 'Claim failed');
    } finally {
      setBusy(false);
    }
  };

  // ---- confirmation sheet ----------------------------------------------------
  const confirmLines = (p: Pending) => {
    if (p.kind === 'mint')
      return [
        {
          address: `Mine OpNS name "${p.name}" (${p.chars} mint transaction${p.chars === 1 ? '' : 's'})`,
          amount: `${p.chars} sat${p.chars === 1 ? '' : 's'} (kept)`,
        },
        { address: `Then bind ${p.name} → your identity key`, amount: '1 sat (kept)' },
      ];
    if (p.kind === 'buy') return [{ address: `Buy OpNS name "${p.name}"`, amount: moneyNow(p.price) }];
    const lines = p.tokenOnly ? [] : [{ address: `OpNS: ${p.name} → your identity key`, amount: '1 sat (kept)' }];
    const t = personalTicker(p.name);
    if (t && (p.tokenOnly || mintsToken(p.name))) {
      lines.push({
        address: `New token $${t} (${Number(supply).toLocaleString()}, to you) + your $${t} room`,
        amount: '1 sat (kept)',
      });
    }
    return lines;
  };
  const fee = (p: Pending) => {
    if (p.kind === 'mint') return p.chars * estimateMintFee(NODE_SCRIPT_ESTIMATE) + REGISTER_FEE_ESTIMATE_SATS;
    if (p.kind === 'buy') return REGISTER_FEE_ESTIMATE_SATS * 2;
    return (
      (p.tokenOnly ? 0 : REGISTER_FEE_ESTIMATE_SATS) +
      (p.tokenOnly || mintsToken(p.name) ? PERSONAL_FEE_ESTIMATE_SATS : 0)
    );
  };

  const gray = theme.color.global.gray;
  const fg = theme.color.global.contrast;
  const row = theme.color.global.row;
  const gold = '#FFD24D';
  const btn = 'px-3 py-1 rounded-lg text-xs font-semibold border-0 cursor-pointer disabled:opacity-50';

  // A render helper, not a component: a nested component would remount and drop input focus.
  const tokenOptions = () => {
    const t = personalTicker(handleName || query) ?? 'NAME';
    return (
      <div className="flex flex-col gap-2">
        <p className="text-[11px]" style={{ color: gray }}>
          A personal token, ticker <b style={{ color: fg }}>${t}</b>, all to your wallet, plus a room only holders can
          enter. Invite = send 1 ${t}. It's for access, not trading. The room can be set up later.
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
        {handleName ? (
          <button
            type="button"
            disabled={busy || !!supplyError}
            onClick={() => setPending({ kind: 'bind', name: handleName, id: '', tokenOnly: true })}
            className={`self-start ${btn}`}
            style={{ background: gold, color: '#000' }}
          >
            Create ${t} token + room
          </button>
        ) : null}
      </div>
    );
  };

  const charsToMine =
    result?.status === 'available' && mineFromDomain !== null ? result.name.length - mineFromDomain.length : 0;
  const nextChar = progress ? (mining[progress.domain.length] ?? '') : '';

  return (
    <div className="w-full rounded-2xl p-4 flex flex-col gap-3 mb-4" style={{ background: row }}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold" style={{ color: fg }}>
          Make your name payable
        </span>
        {(paymail || myName) && (
          <span className="text-xs font-semibold" style={{ color: gold }}>
            {bareName(paymail) || myName}
          </span>
        )}
      </div>
      <p className="text-[11px]" style={{ color: gray }}>
        {profileName ? (
          <>
            Your profile name is <b style={{ color: fg }}>{profileName}</b>. Give it a handle people can pay instead of
            an address.
          </>
        ) : (
          'Save your profile name above first, then give it a handle people can pay instead of an address.'
        )}
      </p>

      {paymailEnabled() && !hidePaymail && (
        <div className="flex flex-col gap-2 rounded-xl p-3" style={{ border: '1px solid #3a2f0c' }}>
          <span className="text-[10px] uppercase tracking-widest" style={{ color: gray }}>
            Paymail
          </span>
          {paymail ? (
            <p className="text-xs" style={{ color: fg }}>
              <b style={{ color: gold }}>{paymail} ✓</b> receives BSV (P2P) and tokens. Payments land in this wallet the
              next time it's open.
            </p>
          ) : null}
          <div className="flex gap-2 items-center">
            <Input
              theme={theme}
              placeholder="name"
              value={alias}
              autoCapitalize="none"
              onChange={(e) => setAlias(toAlias(e.target.value))}
              style={{ width: '100%', margin: 0 }}
            />
            <span className="text-xs whitespace-nowrap" style={{ color: gray }}>
              @{BWALLET_PAYMAIL_DOMAIN}
            </span>
          </div>
          <div className="flex items-center justify-between gap-2">
            <span
              className="text-[11px]"
              style={{
                color:
                  aliasState === 'free'
                    ? '#2ecc71'
                    : aliasState === 'checking' || aliasState === 'idle'
                      ? gray
                      : '#ff4444',
              }}
            >
              {aliasState === 'free' && (ownPaymail ? 'Yours' : 'Available')}
              {aliasState === 'taken' && 'Taken'}
              {aliasState === 'invalid' && 'a-z, 0-9, - or _'}
              {aliasState === 'checking' && 'Checking…'}
            </span>
            <button
              type="button"
              disabled={busy || aliasState !== 'free' || ownPaymail}
              onClick={claim}
              className={btn}
              style={{ background: gold, color: '#000' }}
            >
              {paymail ? 'Change to' : 'Claim'} {alias || 'name'}@{BWALLET_PAYMAIL_DOMAIN}
            </button>
          </div>
        </div>
      )}

      {/* OpNS is optional once the account has a paymail handle: a quiet disclosure, closed by default. */}
      <button
        type="button"
        onClick={() => setOpnsOpen((o) => !o)}
        aria-expanded={showOpns}
        className="flex items-center justify-between bg-transparent border-0 p-0 cursor-pointer"
      >
        <span className="text-[10px] uppercase tracking-widest" style={{ color: gray }}>
          OpNS name (on-chain{paymail ? ', optional' : ''})
        </span>
        {showOpns ? <ChevronUp size={14} color={gray} /> : <ChevronDown size={14} color={gray} />}
      </button>
      {showOpns && (
        <>
          <div className="flex gap-2 items-center">
            <Input
              theme={theme}
              placeholder="Search a name"
              value={query}
              autoCapitalize="none"
              onChange={(e) => setQuery(e.target.value.toLowerCase())}
              onKeyDown={(e) => e.key === 'Enter' && search()}
              style={{ width: '100%', margin: 0 }}
            />
            <button
              type="button"
              onClick={search}
              disabled={busy}
              aria-label="Search"
              className="h-10 w-10 flex-shrink-0 rounded-lg flex items-center justify-center border-0 cursor-pointer"
              style={{ background: gold, color: '#000' }}
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
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs" style={{ color: gray }}>
                <b style={{ color: fg }}>{result.name}</b> is taken
                {result.owner ? ` (owner ${result.owner.slice(0, 8)}…)` : ''}.
                {owned.some((o) => o.name === result.name) ? ' You own it — use it below.' : ''}
                {result.listing ? ` For sale: ${moneyNow(result.listing.price)}.` : ''}
              </p>
              {result.listing && !owned.some((o) => o.name === result.name) && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    result.listing &&
                    setPending({
                      kind: 'buy',
                      name: result.name,
                      outpoint: result.listing.outpoint,
                      price: result.listing.price,
                    })
                  }
                  className={btn}
                  style={{ background: gold, color: '#000' }}
                >
                  Buy
                </button>
              )}
            </div>
          )}
          {result?.status === 'available' && !progress && !mining && (
            <div className="flex flex-col gap-2">
              <p className="text-xs" style={{ color: '#2ecc71' }}>
                {result.name} is available.
                {mineFromDomain !== null
                  ? ` It's mined from "${mineFromDomain || '(root)'}": ${charsToMine} character${
                      charsToMine === 1 ? '' : 's'
                    }, one transaction each, roughly ${formatEta(
                      (charsToMine * EXPECTED_HASHES) / PHONE_HASHRATE,
                    )} of mining on a phone.`
                  : " Couldn't find where to mine it from; try again shortly."}
              </p>
              {mineFromDomain !== null && charsToMine > 0 && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => setPending({ kind: 'mint', name: result.name, chars: charsToMine })}
                  className={`self-start ${btn}`}
                  style={{ background: gold, color: '#000' }}
                >
                  Register this name
                </button>
              )}
            </div>
          )}

          {progress && progress.phase !== 'done' && (
            <div className="flex flex-col gap-2 rounded-xl p-3" style={{ border: '1px solid #3a2f0c' }}>
              <span className="text-xs" style={{ color: fg }}>
                {progress.phase === 'broadcasting'
                  ? `Broadcasting "${progress.domain}${nextChar}"…`
                  : `Mining character ${progress.charIndex + 1} of ${progress.charsTotal}: "${progress.domain}${nextChar}"`}
              </span>
              <div className="w-full h-2 rounded-full overflow-hidden" style={{ background: '#2a2410' }}>
                <div
                  className="h-full"
                  style={{
                    background: gold,
                    width: `${Math.min(
                      100,
                      ((progress.charIndex + Math.min(0.95, progress.tried / EXPECTED_HASHES)) /
                        Math.max(1, progress.charsTotal)) *
                        100,
                    )}%`,
                  }}
                />
              </div>
              <div className="flex items-center justify-between">
                <span className="text-[11px]" style={{ color: gray }}>
                  {progress.rate > 0
                    ? `${Math.round(progress.rate / 1000)}k hashes/s · ${formatEta(progress.etaSeconds)} left`
                    : 'Starting…'}
                </span>
                <button
                  type="button"
                  onClick={() => abort.current?.abort()}
                  className={btn}
                  style={{ background: 'transparent', color: gray, border: `1px solid ${gray}` }}
                >
                  Cancel
                </button>
              </div>
              <p className="text-[10px]" style={{ color: gray }}>
                Keep the app open. Time per character varies a lot: it's luck, like Bitcoin mining.
              </p>
            </div>
          )}

          {owned.length > 0 && (
            <div className="flex flex-col gap-2">
              <span className="text-[10px] uppercase tracking-widest" style={{ color: gray }}>
                Names you own{owned.length > 1 && !myName ? ' — pick one' : ''}
              </span>
              {!link && (
                <label className="text-[11px] flex items-center gap-2" style={{ color: gray }}>
                  <input type="checkbox" checked={withToken} onChange={(e) => setWithToken(e.target.checked)} />
                  Also mint my personal token ({supplyError ? 'fix supply below' : `${Number(supply).toLocaleString()}`}
                  ) and open my room
                </label>
              )}
              {!link && withToken && !myName && tokenOptions()}
              {owned.map((n) => (
                <div key={n.id} className="flex items-center justify-between">
                  <span className="text-sm" style={{ color: fg }}>
                    {n.name}
                    {n.published && (
                      <span className="text-[10px] ml-2" style={{ color: gray }}>
                        bound
                      </span>
                    )}
                  </span>
                  {myName === n.name ? (
                    <span className="text-xs" style={{ color: '#2ecc71' }}>
                      In use
                    </span>
                  ) : n.published ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setMyName(identityAddress, n.name)}
                      className={btn}
                      style={{ background: gold, color: '#000' }}
                    >
                      Show this name
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setPending({ kind: 'bind', name: n.name, id: n.id })}
                      className={btn}
                      style={{ background: gold, color: '#000' }}
                    >
                      Use this name
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}
      {handleName && personalTicker(handleName) && (
        <div className="flex flex-col gap-2 rounded-xl p-3" style={{ border: '1px solid #3a2f0c' }}>
          <span className="text-[10px] uppercase tracking-widest" style={{ color: gray }}>
            Your token
          </span>
          {link ? (
            <p className="text-xs" style={{ color: fg }}>
              <b style={{ color: gold }}>${link.ticker} ✓</b> · {Number(link.supply).toLocaleString()} minted ·{' '}
              {link.roomTicker ? 'room open' : 'room not set up yet'}. Invite someone by sending them 1 ${link.ticker}{' '}
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
        total={`~${moneyNow(pending ? fee(pending) : REGISTER_FEE_ESTIMATE_SATS)} network fee`}
        isProcessing={busy}
        onConfirm={() => pending && confirm(pending)}
        onCancel={() => setPending(null)}
      />
    </div>
  );
};

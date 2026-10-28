import { useEffect, useState } from 'react';
import { AtSign, BadgeCheck, Copy, Check, MoreHorizontal, Plus } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { NameHandover } from './NameHandover';
import {
  bindMyNames,
  listPaymails,
  paymailAvailability,
  paymailEnabled,
  PAYMAIL_ALIAS_RE,
  toAlias,
  unlinkPaymail,
  type WalletName,
} from '../names/paymail';
import { setPaymail } from '../names/accountName';
import { ErrorActions } from '../errors/ErrorActions';
import {
  addExtraName,
  extraFeeLabel,
  loadHandles,
  makeMainName,
  extraNameFeeFor,
  removeName,
  type ExtraNameFee,
} from '../names/extraNames';
import type { HandlesInfo } from '../chat/api';
import { SendConfirmation } from '../../components/SendConfirmation';
import { useTheme } from '../../hooks/useTheme';
import { PAID_FEATURES_ENABLED } from '../storeBuild';
import { PROVIDER, actionText, confirmText, nameActions } from './nameActions';

const f = (u: string, i?: RequestInit) => fetch(u, i);

/** The server's cap on plain names per identity key (site/lib/paymail.js MAX_PLAIN_NAMES). */
const MAX_PLAIN_NAMES = 5;

/**
 * Settings › Identity: every name that receives for this wallet (owner, 4 Oct 2026: a wallet may
 * have more than one, "but NOT invisibly"). The main one is its identity, token and room.
 */
export const WalletNames = () => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService.getCurrentAccountObject().account?.addresses?.identityAddress ?? '';
  const [names, setNames] = useState<WalletName[] | null>(null);
  const [menu, setMenu] = useState(''); // paymail whose ⋯ menu is open
  const [full, setFull] = useState(''); // paymail shown in full (tap / long-press a truncated name)
  const [confirm, setConfirm] = useState<{ action: 'remove' | 'unlink'; name: WalletName } | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  const [copied, setCopied] = useState('');
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState('');
  // Extra names are paid once, on bit-sign (1p each; owner, 15 Oct 2026). Its list gives the max and the fee.
  const { theme } = useTheme();
  const [handles, setHandles] = useState<HandlesInfo | null>(null);
  const [feeConfirm, setFeeConfirm] = useState(false);
  // Owner pricing (27 Oct 2026): 5+ character names are free; shorter ones are priced, quoted when added.
  const [nameFee, setNameFee] = useState<ExtraNameFee | null>(null);
  useEffect(() => {
    if (!PAID_FEATURES_ENABLED) return;
    let live = true;
    loadHandles(apiContext)
      .then((h) => live && setHandles(h))
      .catch(() => live && setHandles(null));
    return () => {
      live = false;
    };
  }, [apiContext, tick]);
  const feeLabel = extraFeeLabel(nameFee);
  const plainCount = names?.filter((n) => n.kind === 'plain').length ?? 0;
  const atMax = plainCount >= (handles?.max ?? MAX_PLAIN_NAMES);
  const hasMain = !!names?.some((n) => n.kind === 'plain' && n.main);
  // After any change: re-read the names and cache the main one, so the top bar and Receive follow it.
  const refresh = async () => {
    const { publicKey } = await apiContext.wallet.getPublicKey({ identityKey: true });
    const next = (await listPaymails(f, publicKey)).find((n) => n.main)?.paymail;
    if (identityAddress) setPaymail(identityAddress, next ?? '');
    setTick((t) => t + 1);
  };
  const run = async (key: string, fn: () => Promise<unknown>, fallback: string) => {
    setBusy(key);
    setError('');
    try {
      await fn();
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof Error ? e.message : fallback);
      return false;
    } finally {
      setBusy('');
    }
  };
  const copy = (pm: string) => {
    void navigator.clipboard?.writeText(pm).then(
      () => {
        setCopied(pm);
        setTimeout(() => setCopied((c) => (c === pm ? '' : c)), 1500);
      },
      () => setError('Could not copy'),
    );
  };
  const add = async (confirmed = false) => {
    const a = toAlias(draft);
    if (!PAYMAIL_ALIAS_RE.test(a)) return setError('Use a-z, 0-9, - or _ (up to 32)');
    let fee = confirmed ? nameFee : null;
    if (!confirmed) {
      setError('');
      // Check before paying, so nobody pays for a name they can't have; then quote its price.
      const { publicKey } = await apiContext.wallet.getPublicKey({ identityKey: true });
      const a2 = await paymailAvailability(f, a, publicKey).catch(() => null);
      if (a2 && a2.state !== 'free') return setError(a2.message || 'That name is taken');
      try {
        fee = await extraNameFeeFor(f, a);
      } catch (e) {
        return setError(e instanceof Error ? e.message : 'Could not get the price');
      }
      setNameFee(fee);
      if (fee) return setFeeConfirm(true);
    }
    setFeeConfirm(false);
    // The wallet signs the new name's binding ("name -> my key", docs/NAME-BINDINGS.md) straight after the claim,
    // so other wallets can check it before paying. A failed signature leaves the name unsigned, never unclaimed.
    const go = async () => {
      await addExtraName(apiContext, f, a, fee);
      const { publicKey } = await apiContext.wallet.getPublicKey({ identityKey: true });
      await bindMyNames(f, apiContext.wallet, publicKey).catch(() => 0);
    };
    if (await run('add', go, 'Could not add that name')) {
      setDraft('');
      setAdding(false);
    }
  };
  useEffect(() => {
    let live = true;
    apiContext.wallet
      .getPublicKey({ identityKey: true })
      .then(({ publicKey }) => listPaymails(f, publicKey))
      .then((n) => live && setNames(n))
      .catch(() => live && setNames([]));
    return () => {
      live = false;
    };
  }, [apiContext.wallet, tick]);
  if (names === null) return null;
  if (!names.length) return <NameHandover names={[]} onChanged={() => setTick((t) => t + 1)} />;
  return (
    <>
      <NameHandover names={names} onChanged={() => setTick((t) => t + 1)} />
      <div className="px-4 py-3" style={{ borderBottom: '1px solid #ffffff10' }}>
        <p className="text-sm font-semibold m-0 mb-0.5" style={{ color: 'var(--bw-text)' }}>
          Names
        </p>
        <p className="text-xs m-0 mb-2" style={{ color: '#98A2B3' }}>
          {names.length > 1 ? `This wallet receives at ${names.length} names` : 'This wallet receives at'}
        </p>
        <div role="list" className="flex flex-col">
          {names.map((n) => {
            const actions = nameActions(n);
            return (
              <div
                key={n.paymail}
                role="listitem"
                data-testid="wallet-name-row"
                className="grid items-center gap-x-2 py-1.5 text-sm"
                style={{ gridTemplateColumns: '14px minmax(0,1fr) 40px 24px 28px', color: 'var(--bw-text)' }}
              >
                {n.kind === 'plain' ? (
                  <AtSign size={14} color="#98A2B3" />
                ) : (
                  <BadgeCheck size={14} color="var(--bw-accent)" aria-label={`Linked to ${PROVIDER[n.kind]}`} />
                )}
                <span
                  title={n.paymail}
                  onClick={() => setFull((f) => (f === n.paymail ? '' : n.paymail))}
                  className={full === n.paymail ? 'break-all' : 'truncate'}
                  style={{ minWidth: 0 }}
                >
                  {n.paymail}
                </span>
                <span className="justify-self-start">
                  {n.main && (
                    <span
                      className="text-[10px] font-bold rounded px-1.5 py-0.5"
                      style={{ background: 'rgb(var(--bw-accent-rgb)/0.13)', color: 'var(--bw-accent)' }}
                    >
                      Main
                    </span>
                  )}
                </span>
                <button
                  type="button"
                  aria-label={`Copy ${n.paymail}`}
                  onClick={() => copy(n.paymail)}
                  className="bg-transparent border-0 p-0 flex items-center justify-center h-6"
                  style={{ color: 'var(--bw-muted)' }}
                >
                  {copied === n.paymail ? <Check size={14} color="var(--bw-accent)" /> : <Copy size={14} />}
                </button>
                <span className="relative flex justify-end">
                  <button
                    type="button"
                    aria-label={`Options for ${n.paymail}`}
                    aria-haspopup="menu"
                    aria-expanded={menu === n.paymail}
                    disabled={!!busy}
                    onClick={() => setMenu((m) => (m === n.paymail ? '' : n.paymail))}
                    className="bg-transparent border-0 p-0 flex items-center justify-center w-7 h-6 rounded"
                    style={{ color: 'var(--bw-muted)' }}
                  >
                    {busy === n.paymail ? <span className="text-[10px]">…</span> : <MoreHorizontal size={16} />}
                  </button>
                  {menu === n.paymail && (
                    <>
                      <div className="fixed inset-0 z-[150]" onClick={() => setMenu('')} />
                      <div
                        role="menu"
                        className="absolute right-0 top-7 z-[160] w-64 max-w-[calc(100vw-32px)] rounded-xl p-1 shadow-lg"
                        style={{ background: 'var(--bw-card)', border: '1px solid var(--bw-line)' }}
                      >
                        {actions.length === 0 && (
                          <p className="text-xs m-0 px-3 py-2" style={{ color: 'var(--bw-muted)' }}>
                            This is your main name. To remove it, set another name as main first.
                          </p>
                        )}
                        {actions.map((a) => {
                          const t = actionText(a, n);
                          return (
                            <button
                              key={a}
                              type="button"
                              role="menuitem"
                              onClick={() => {
                                setMenu('');
                                if (a === 'main')
                                  void run(
                                    n.paymail,
                                    () => makeMainName(apiContext, f, n.paymail),
                                    'Could not change your main name',
                                  );
                                else setConfirm({ action: a, name: n });
                              }}
                              className="block w-full text-left bg-transparent border-0 rounded-lg px-3 py-2"
                            >
                              <span
                                className="block text-sm font-semibold"
                                style={{ color: a === 'main' ? 'var(--bw-accent)' : 'var(--bw-text)' }}
                              >
                                {t.label}
                              </span>
                              <span className="block text-[11px] mt-0.5" style={{ color: 'var(--bw-muted)' }}>
                                {t.hint}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                    </>
                  )}
                </span>
              </div>
            );
          })}
        </div>
        {plainCount > 1 && (
          <p className="text-[11px] m-0 mt-1" style={{ color: 'var(--bw-muted)' }}>
            You can change your main name once every 30 days.
          </p>
        )}
        {PAID_FEATURES_ENABLED && atMax && (
          <p className="text-[11px] m-0 mt-1" style={{ color: 'var(--bw-muted)' }}>
            A wallet can have up to {handles?.max ?? MAX_PLAIN_NAMES} names.
          </p>
        )}
        {adding && (
          <p className="text-[11px] m-0 mt-2" style={{ color: 'var(--bw-muted)' }}>
            Up to 5 names on this key. Names of 5+ letters are free; short names cost more. Your wallet signs each one.
          </p>
        )}
        {adding ? (
          <div className="flex items-center gap-2 mt-2">
            <input
              value={draft}
              onChange={(e) => setDraft(toAlias(e.target.value))}
              placeholder="a name for this wallet"
              autoCapitalize="none"
              autoCorrect="off"
              className="flex-1 min-w-0 rounded px-2 py-1.5 text-sm"
              style={{ background: 'var(--bw-surface)', color: 'var(--bw-text)', border: '1px solid var(--bw-line)' }}
            />
            <button
              type="button"
              disabled={!!busy || !draft}
              onClick={() => void add()}
              className="text-xs font-bold rounded px-3 py-1.5 border-0"
              style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent)' }}
            >
              {busy === 'add' ? 'Adding…' : 'Add'}
            </button>
            <button
              type="button"
              onClick={() => {
                setAdding(false);
                setDraft('');
              }}
              className="text-xs bg-transparent border-0 p-0"
              style={{ color: 'var(--bw-muted)' }}
            >
              Cancel
            </button>
          </div>
        ) : (
          // Store build (docs/STORE-AUDIT.md 1.6): only the free paymail, so no paid extra names.
          // Owner, 28 Oct 2026: a clear "Add a name" button, always shown; when a name can't be added it says why.
          PAID_FEATURES_ENABLED &&
          (!!handles || paymailEnabled()) && (
            <>
              <button
                type="button"
                data-testid="add-a-name"
                disabled={atMax || !hasMain}
                onClick={() => setAdding(true)}
                className="flex w-full items-center justify-center gap-1.5 mt-3 rounded-xl py-2.5 text-sm font-bold border-0"
                style={{
                  background: atMax || !hasMain ? 'var(--bw-surface)' : 'var(--bw-accent)',
                  color: atMax || !hasMain ? 'var(--bw-muted)' : 'var(--bw-on-accent)',
                }}
              >
                <Plus size={16} /> Add a name
              </button>
              {!hasMain && (
                <p className="text-[11px] m-0 mt-1" style={{ color: 'var(--bw-muted)' }}>
                  Choose your main handle first (Change handle, below). Then you can add more names.
                </p>
              )}
            </>
          )
        )}
        <SendConfirmation
          show={feeConfirm}
          theme={theme}
          lineItems={[{ address: `Add ${toAlias(draft)}`.slice(0, 16), amount: feeLabel }]}
          total={feeLabel}
          isProcessing={busy === 'add'}
          onConfirm={() => void add(true)}
          onCancel={() => setFeeConfirm(false)}
        />
        {confirm && (
          <div
            className="fixed inset-0 z-[200] flex items-end"
            style={{ background: 'rgb(0 0 0 / 0.5)' }}
            onClick={() => !busy && setConfirm(null)}
          >
            <div
              role="dialog"
              aria-modal="true"
              className="w-full p-4 pb-8 rounded-t-2xl"
              style={{ background: 'var(--bw-card)', color: 'var(--bw-text)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <p className="text-sm font-bold m-0 mb-1 break-all">
                {confirm.action === 'remove' ? 'Remove' : 'Unlink'} {confirm.name.paymail}?
              </p>
              <p className="text-xs m-0 mb-4" style={{ color: 'var(--bw-muted)' }}>
                {confirmText(confirm.action, confirm.name, names.length - 1)}
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => setConfirm(null)}
                  className="flex-1 rounded py-2 text-sm"
                  style={{
                    background: 'var(--bw-surface)',
                    color: 'var(--bw-text)',
                    border: '1px solid var(--bw-line)',
                  }}
                >
                  Keep it
                </button>
                <button
                  type="button"
                  disabled={!!busy}
                  onClick={() => {
                    const pm = confirm.name.paymail;
                    const go =
                      confirm.action === 'remove'
                        ? () => removeName(apiContext, f, pm)
                        : () => unlinkPaymail(f, apiContext.wallet, pm);
                    void run(pm, go, confirm.action === 'remove' ? 'Could not remove' : 'Could not unlink').then(() =>
                      setConfirm(null),
                    );
                  }}
                  className="flex-1 rounded py-2 text-sm font-bold border-0"
                  style={{ background: 'var(--bw-accent)', color: 'var(--bw-on-accent)' }}
                >
                  {busy === confirm.name.paymail
                    ? confirm.action === 'remove'
                      ? 'Removing…'
                      : 'Unlinking…'
                    : confirm.action === 'remove'
                      ? 'Remove'
                      : 'Unlink'}
                </button>
              </div>
            </div>
          </div>
        )}
        {error && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] m-0 mt-1" style={{ color: '#FDA29B' }}>
              {error}
            </p>
            <ErrorActions message={String(error)} />
          </div>
        )}
      </div>
    </>
  );
};

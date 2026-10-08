/**
 * Token room settings. ONLY THE TOKEN'S ISSUER configures a token room (bit-sign resolves the
 * issuer address from chain). Everyone else sees the room's rules read-only.
 *
 *  - Issuer who hasn't claimed yet, and this wallet holds the issuer key → "Claim admin".
 *  - Claimed issuer → minimum to enter, spend rule, title, cover, bans, and whether new
 *    members can see earlier messages (HistoryToggle; saved on its own, not by Save).
 *  - Anyone else → "Room rules" summary.
 */
import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, X } from 'lucide-react';
import type { OneSatContext } from '@1sat/actions';
import { useBackClose } from '../backStack';
import type { BchatClient, IssuerChallenge } from './api';
import { issuerCandidates } from './holdings';
import { findKeyFor, signBsmWith } from './issuerKey';
import { spendFloorError } from './roomSpend';
import { HistoryToggle } from './HistoryToggle';
import {
  amountLabel,
  formatRaw,
  parseLookup,
  spendLabel,
  spendEnforced,
  SPEND_ENFORCED_NOTE,
  SPEND_COMING_NOTE,
  toRawAmount,
  type RoomSpendRule,
  type TokenRoomEntry,
  type TokenRoomLookup,
} from './tokenRooms';
import type { Derivation } from './tokenRooms';

const GOLD = '#FFD24D';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';
const RED = '#F97066';

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));
const inputCls = 'w-full rounded-xl px-3 py-2 text-sm text-white outline-none';

const SSheet = ({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[150] flex items-end" style={{ background: 'rgba(0,0,0,0.6)' }} onClick={onClose}>
      <div
        className="w-full max-h-[85vh] overflow-y-auto rounded-t-3xl px-5 pt-4"
        style={{
          background: '#0e0e0e',
          borderTop: `1px solid ${LINE}`,
          paddingBottom: 'calc(env(safe-area-inset-bottom) + 20px)',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between mb-3">
          <span className="text-white font-semibold">{title}</span>
          <button onClick={onClose} aria-label="Close" className="p-1">
            <X size={20} color={MUTED} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};

/** Downscale an image file to a small JPEG data URL (the server caps covers at ~220KB). */
const toCoverDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      const scale = Math.min(1, 640 / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d')?.drawImage(img, 0, 0, c.width, c.height);
      URL.revokeObjectURL(url);
      resolve(c.toDataURL('image/jpeg', 0.8));
    };
    img.onerror = () => reject(new Error('Could not read that image'));
    img.src = url;
  });

const Row = ({ label, value }: { label: string; value: string }) => (
  <div className="flex items-center justify-between py-2 text-sm" style={{ borderBottom: `1px solid ${LINE}` }}>
    <span style={{ color: MUTED }}>{label}</span>
    <span className="text-white text-right ml-3">{value}</span>
  </div>
);

export const RoomSettingsSheet = ({
  client,
  ctx,
  ticker,
  entry,
  onBans,
  onClose,
}: {
  client: BchatClient;
  ctx: OneSatContext;
  ticker: string;
  entry: TokenRoomEntry;
  onBans: () => void;
  onClose: () => void;
}) => {
  const [look, setLook] = useState<TokenRoomLookup | null>(null);
  const [challenge, setChallenge] = useState<IssuerChallenge | null>(null);
  const [key, setKey] = useState<Derivation | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [saved, setSaved] = useState('');
  const dec = entry.key.startsWith('coll:') ? 0 : entry.gate.dec;
  const symbol = entry.gate.symbol;

  const [min, setMin] = useState('');
  const [name, setName] = useState('');
  const [spendAmt, setSpendAmt] = useState('');
  const [per, setPer] = useState<RoomSpendRule['per']>('message');
  const [to, setTo] = useState<RoomSpendRule['to'] | 'sats'>('burn');

  const load = useCallback(async () => {
    setError('');
    try {
      const [l, ch] = await Promise.all([
        client.tokenRoom(entry.key).then(parseLookup),
        client.issuerChallenge(ticker),
      ]);
      setLook(l);
      setChallenge(ch);
      const g = l?.gate ?? entry.gate;
      setMin(formatRaw(g.minRaw, dec));
      setName(l?.room?.name ?? '');
      setSpendAmt(l?.spend ? (l.spend.unit === 'sats' ? l.spend.amountRaw : formatRaw(l.spend.amountRaw, dec)) : '');
      if (l?.spend) {
        setPer(l.spend.per);
        setTo(l.spend.unit === 'sats' ? 'sats' : l.spend.to);
      }
      // Can this wallet sign for the issuer address? Only then is the claim offered.
      if (ch.issuerAddress && !ch.youAreIssuer) {
        setKey(await findKeyFor(ctx.wallet, ch.issuerAddress, await issuerCandidates(ctx)).catch(() => null));
      }
    } catch (e) {
      setError(errText(e));
    }
  }, [client, ctx, entry.key, entry.gate, ticker, dec]);
  useEffect(() => {
    void load();
  }, [load]);

  const run = async (label: string, fn: () => Promise<void>, done: string) => {
    setBusy(label);
    setError('');
    setSaved('');
    try {
      await fn();
      setSaved(done);
      await load();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy('');
    }
  };

  const claim = () =>
    run(
      'claim',
      async () => {
        if (!key) throw new Error('This wallet does not hold the issuer key');
        const ch = await client.issuerChallenge(ticker);
        if (!ch.message) throw new Error('No issuer address on chain for this token');
        await client.claimIssuer(ticker, ch.message, await signBsmWith(ctx.wallet, key, ch.message));
      },
      "You're the room admin.",
    );

  const save = () =>
    run(
      'save',
      async () => {
        const minRaw = toRawAmount(min, dec);
        if (!minRaw) throw new Error('Minimum must be a positive amount');
        let spend: RoomSpendRule | null = null;
        if (spendAmt.trim() && spendAmt.trim() !== '0') {
          if (to === 'sats') {
            if (per !== 'message') throw new Error('Sats are charged per message');
            const sats = toRawAmount(spendAmt, 0);
            if (!sats) throw new Error('Spend must be a whole number of sats');
            const floor = spendFloorError('sats', sats);
            if (floor) throw new Error(floor);
            spend = { amountRaw: sats, per, to: 'issuer', unit: 'sats' };
          } else {
            const amountRaw = toRawAmount(spendAmt, dec);
            if (!amountRaw) throw new Error('Spend must be a positive amount');
            spend = { amountRaw, per, to };
          }
        }
        await client.updateRoomSettings(ticker, {
          min: formatRaw(minRaw, dec),
          spend,
          ...(name.trim() ? { name: name.trim() } : {}),
        });
      },
      'Saved.',
    );

  const pickCover = async (file: File | undefined) => {
    if (!file) return;
    await run('cover', async () => client.setRoomCover(ticker, await toCoverDataUrl(file)), 'Cover updated.');
  };

  const isIssuer = !!challenge?.youAreIssuer;
  const gate = look?.gate ?? entry.gate;
  const issuerLine = challenge?.claimedBy
    ? `$${challenge.claimedBy}`
    : look?.personal
      ? `$${look.personal.by}`
      : 'Not claimed yet';

  return (
    <SSheet title={isIssuer ? 'Room settings' : 'Room rules'} onClose={onClose}>
      {!look && !error && (
        <p className="text-xs" style={{ color: MUTED }}>
          Loading…
        </p>
      )}

      {look && !isIssuer && (
        <>
          <Row label="To enter" value={`Hold ${amountLabel(gate.minRaw, gate)}`} />
          <Row label="To chat" value={spendLabel(look.spend, symbol, dec)} />
          {look.spend && (
            <p className="text-xs mt-1" style={{ color: MUTED }}>
              {spendEnforced(look.spend) ? SPEND_ENFORCED_NOTE : SPEND_COMING_NOTE}
            </p>
          )}
          <Row label="Admin" value={issuerLine} />
          <p className="text-xs mt-3" style={{ color: MUTED }}>
            Only the token's issuer can change these rules.
          </p>
          {key && challenge?.issuerAddress && (
            <button
              onClick={claim}
              disabled={!!busy}
              className="w-full mt-4 rounded-2xl py-3 font-bold disabled:opacity-50 flex items-center justify-center gap-2"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              <ShieldCheck size={18} />
              {busy === 'claim' ? 'Signing…' : "You're the issuer · Claim admin"}
            </button>
          )}
        </>
      )}

      {look && isIssuer && (
        <div className="flex flex-col gap-3">
          <HistoryToggle client={client} ticker={ticker} />
          <label className="text-xs" style={{ color: MUTED }}>
            Title
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={80}
              className={`${inputCls} mt-1`}
              style={{ background: PANEL, border: `1px solid ${LINE}` }}
            />
          </label>
          <label className="text-xs" style={{ color: MUTED }}>
            Minimum to enter ({entry.key.startsWith('coll:') ? 'items' : `$${symbol}`})
            <input
              value={min}
              onChange={(e) => setMin(e.target.value)}
              inputMode="decimal"
              className={`${inputCls} mt-1`}
              style={{ background: PANEL, border: `1px solid ${LINE}` }}
            />
          </label>
          <div className="text-xs" style={{ color: MUTED }}>
            Spend to chat (blank = free)
            <div className="flex gap-2 mt-1">
              <input
                value={spendAmt}
                onChange={(e) => setSpendAmt(e.target.value)}
                inputMode="decimal"
                placeholder="0"
                className={inputCls}
                style={{ background: PANEL, border: `1px solid ${LINE}` }}
              />
              <select
                value={per}
                onChange={(e) => setPer(e.target.value as RoomSpendRule['per'])}
                className="rounded-xl px-2 text-sm text-white"
                style={{ background: PANEL, border: `1px solid ${LINE}` }}
              >
                <option value="message">per message</option>
                <option value="minute">per minute (coming)</option>
                <option value="hour">per hour (coming)</option>
                <option value="day">per day (coming)</option>
              </select>
              <select
                value={to}
                onChange={(e) => setTo(e.target.value as RoomSpendRule['to'] | 'sats')}
                className="rounded-xl px-2 text-sm text-white"
                style={{ background: PANEL, border: `1px solid ${LINE}` }}
              >
                <option value="burn">burned</option>
                <option value="issuer">{`$${symbol} to you`}</option>
                <option value="sats">sats to you</option>
              </select>
            </div>
            <p className="mt-1">
              {per === 'message' ? SPEND_ENFORCED_NOTE : SPEND_COMING_NOTE} You never pay to post in your own room.
            </p>
          </div>
          <button
            onClick={save}
            disabled={!!busy}
            className="w-full rounded-2xl py-3 font-bold disabled:opacity-50"
            style={{ background: GOLD, color: '#1a1300' }}
          >
            {busy === 'save' ? 'Saving…' : 'Save'}
          </button>
          <div className="flex gap-2">
            <label
              className="flex-1 text-center rounded-2xl py-2 text-sm text-white"
              style={{ background: PANEL, border: `1px solid ${LINE}` }}
            >
              {busy === 'cover' ? 'Uploading…' : 'Cover image'}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                className="hidden"
                onChange={(e) => void pickCover(e.target.files?.[0])}
              />
            </label>
            <button
              onClick={onBans}
              className="flex-1 rounded-2xl py-2 text-sm text-white"
              style={{ background: PANEL, border: `1px solid ${LINE}` }}
            >
              Bans
            </button>
          </div>
        </div>
      )}

      {saved && (
        <p className="text-xs mt-2" style={{ color: GOLD }}>
          {saved}
        </p>
      )}
      {error && (
        <p className="text-xs mt-2" style={{ color: RED }}>
          {error}
        </p>
      )}
    </SSheet>
  );
};

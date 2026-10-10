/**
 * "Pay 1¢ to join" on a ticketed Space's locked card (door.ts). One confirm sheet: the price in your display
 * currency (sats small), who it goes to ($host and their key), then the wallet pays the host directly. The host's
 * phone sends the ticket; this waits for its reply and for bit-sign to let you in.
 */
import { useEffect, useRef, useState } from 'react';
import type { WalletInterface } from '@bsv/sdk';
import { useServiceContext } from '../../hooks/useServiceContext';
import { resolveCallee } from '../calls/peer';
import { shortKey } from '../calls/machine';
import { fmtSats, fmtUsd, usdToSats, useBsvUsd } from '../money/money';
import {
  clearPending,
  doorPriceUsd,
  loadPending,
  payAtDoor,
  readDoorReply,
  resendDoorRequest,
  type DoorRequest,
} from './door';
import { ErrorActions } from '../errors/ErrorActions';

const GOLD = '#FFD24D';
const MUTED = '#8a8f98';
const LINE = '#1f2127';
const POLL_MS = 4000;
const f = (u: string, i?: RequestInit) => fetch(u, i);
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

type Step =
  | { s: 'idle' }
  | { s: 'confirm'; hostKey: string; sats: number }
  | { s: 'paying' }
  | { s: 'waiting'; id: string; note?: string }
  | { s: 'admitted' };

export const DoorButton = ({
  ticker,
  host,
  entryUsd,
  live,
  isMember,
  onAdmitted,
}: {
  ticker: string;
  /** The Space host's handle, from bit-sign's Space page. */
  host: string;
  entryUsd: number | null;
  live: boolean;
  /** Ask bit-sign whether I'm in now (I hold the ticket). */
  isMember: () => Promise<boolean>;
  onAdmitted: () => void;
}) => {
  const { apiContext, chromeStorageService } = useServiceContext();
  const wallet = apiContext.wallet as unknown as WalletInterface;
  const ordAddress = chromeStorageService?.getCurrentAccountObject?.()?.account?.addresses?.ordAddress ?? '';
  const rate = useBsvUsd();
  const usd = doorPriceUsd(entryUsd);
  const [step, setStep] = useState<Step>({ s: 'idle' });
  const [err, setErr] = useState('');
  const [me, setMe] = useState('');
  const [pending, setPending] = useState<DoorRequest | null>(null);
  const poll = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let live = true;
    wallet
      .getPublicKey({ identityKey: true })
      .then(({ publicKey }) => {
        if (!live) return;
        const k = publicKey.toLowerCase();
        setMe(k);
        const p = loadPending(k, ticker);
        setPending(p);
        if (p) setStep({ s: 'waiting', id: p.id });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wallet, ticker]);

  // Waiting: watch for the host's reply and for bit-sign to admit me.
  useEffect(() => {
    if (step.s !== 'waiting') return;
    const id = step.id;
    let busy = false;
    const tick = async () => {
      if (busy) return;
      busy = true;
      try {
        if (await isMember().catch(() => false)) {
          clearPending(me);
          setStep({ s: 'admitted' });
          onAdmitted();
          return;
        }
        const r = await readDoorReply(wallet, id).catch(() => null);
        if (r && !r.ok) setStep({ s: 'waiting', id, note: r.note ?? 'The host could not send a ticket.' });
        if (r?.ok) setStep({ s: 'waiting', id, note: 'Ticket sent. Letting you in…' });
      } finally {
        busy = false;
      }
    };
    void tick();
    poll.current = setInterval(() => void tick(), POLL_MS);
    return () => {
      if (poll.current) clearInterval(poll.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- step.id identifies the wait
  }, [step.s, step.s === 'waiting' ? step.id : '', wallet, me]);

  const open = async () => {
    setErr('');
    try {
      const sats = usdToSats(usd, rate);
      if (!sats) throw new Error('Waiting for the BSV price. Try again in a moment.');
      if (!ordAddress) throw new Error('Your wallet has no address for the ticket.');
      // The host's identity key from their $handle (paymail pki). The payment goes to a key derived from it,
      // so it can only reach the host: never a platform address, never an address typed or copied.
      const peer = await resolveCallee(f, `$${host}`);
      if (peer.key === me) throw new Error('You are the host of this Space.');
      setStep({ s: 'confirm', hostKey: peer.key, sats });
    } catch (e) {
      setErr(errText(e));
    }
  };

  const pay = async () => {
    if (step.s !== 'confirm') return;
    const { hostKey, sats } = step;
    setStep({ s: 'paying' });
    setErr('');
    try {
      const r = await payAtDoor(wallet, { me, hostKey, ticker, ordAddress, usd, sats });
      setPending(loadPending(me, ticker));
      setStep({ s: 'waiting', id: r.id });
    } catch (e) {
      const p = loadPending(me, ticker);
      setPending(p);
      // Paid but not delivered: wait anyway (Send again re-delivers the same payment, never pays twice).
      setStep(
        p
          ? { s: 'waiting', id: p.id, note: 'Paid, but the host didn’t get the message. Tap Send again.' }
          : { s: 'idle' },
      );
      setErr(errText(e));
    }
  };

  const resend = async () => {
    if (!pending) return;
    setErr('');
    try {
      await resendDoorRequest(wallet, { ...pending, at: Date.now() });
      setStep({ s: 'waiting', id: pending.id, note: 'Sent again.' });
    } catch (e) {
      setErr(errText(e));
    }
  };

  const price = fmtUsd(usd);

  if (step.s === 'admitted') return null;

  return (
    <div className="mt-3">
      {step.s === 'idle' && (
        <button
          onClick={() => void open()}
          disabled={!live}
          className="w-full h-11 rounded-xl font-bold disabled:opacity-50"
          style={{ background: GOLD, color: '#010101' }}
        >
          Pay {price} to join
        </button>
      )}
      {step.s === 'idle' && !live && (
        <p className="mt-2 text-xs" style={{ color: MUTED }}>
          Pay at the door opens when the host is live.
        </p>
      )}

      {step.s === 'confirm' && (
        <div className="rounded-2xl p-4 text-sm" style={{ background: '#121318', border: `1px solid ${LINE}` }}>
          <div className="font-semibold">Pay at the door</div>
          <div className="flex justify-between mt-3">
            <span style={{ color: MUTED }}>Entry</span>
            <span className="font-semibold">
              {price}{' '}
              <span className="text-[11px]" style={{ color: MUTED }}>
                ({fmtSats(step.sats)})
              </span>
            </span>
          </div>
          <div className="flex justify-between mt-1">
            <span style={{ color: MUTED }}>To</span>
            <span className="font-semibold">${host}</span>
          </div>
          <div className="text-[11px] mt-1 text-right" style={{ color: MUTED }}>
            key {shortKey(step.hostKey)}
          </div>
          <div className="flex justify-between mt-1">
            <span style={{ color: MUTED }}>You get</span>
            <span className="font-semibold">1 ticket · ${ticker}</span>
          </div>
          <p className="text-[11px] mt-3" style={{ color: MUTED }}>
            Paid straight to the host, plus a network fee under 1¢. The host’s phone sends your ticket, usually within a
            minute. Keep the ticket to come back in.
          </p>
          <div className="flex gap-2 mt-4">
            <button
              onClick={() => setStep({ s: 'idle' })}
              className="flex-1 h-11 rounded-xl font-bold"
              style={{ border: `1px solid ${LINE}` }}
            >
              Cancel
            </button>
            <button
              onClick={() => void pay()}
              className="flex-1 h-11 rounded-xl font-bold"
              style={{ background: GOLD, color: '#010101' }}
            >
              Pay {price}
            </button>
          </div>
        </div>
      )}

      {step.s === 'paying' && (
        <p className="text-sm" style={{ color: GOLD }}>
          Paying…
        </p>
      )}

      {step.s === 'waiting' && (
        <div className="rounded-2xl p-3 text-sm" style={{ border: `1px solid ${LINE}` }}>
          <div className="font-semibold" style={{ color: GOLD }}>
            Paid. Waiting for your ticket…
          </div>
          <p className="text-xs mt-1" style={{ color: MUTED }}>
            {step.note ?? 'The host’s phone sends it. You’re let in as soon as it arrives.'}
          </p>
          {pending && (
            <button
              onClick={() => void resend()}
              className="mt-2 rounded-full px-3 py-1 text-xs font-semibold"
              style={{ border: `1px solid ${GOLD}`, color: GOLD }}
            >
              Send again
            </button>
          )}
        </div>
      )}

      {err && (
        <div className="flex flex-col gap-1.5">
          <p className="mt-2 text-xs" style={{ color: '#F97066' }}>
            {err}
          </p>
          <ErrorActions message={String(err)} />
        </div>
      )}
    </div>
  );
};

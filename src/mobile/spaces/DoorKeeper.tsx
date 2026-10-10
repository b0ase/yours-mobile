/**
 * The host's side of "Pay at the door" (door.ts). Mounted next to the Space screen; it does nothing unless you are
 * the live Space's host in a room gated by a BSV-21 ticket. Every few seconds it reads the door box, checks each
 * payment, and sends 1 ticket (the room's entry amount) from your wallet to the payer. A small pill shows the door
 * price and how many were let in; payments it could not finish are listed to check by hand.
 */
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { WalletInterface } from '@bsv/sdk';
import { sendBsv21 } from '@1sat/actions';
import { useServiceContext } from '../../hooks/useServiceContext';
import { getErrorMessage } from '../../utils/tools';
import type { BchatClient } from '../chat/api';
import { gateOfRoom } from '../chat/tokenRooms';
import { fmtUsd, usdToSats, useBsvUsd } from '../money/money';
import { parsePage } from './invite';
import { parseSpaceState } from './model';
import { doorPriceUsd, loadLedger, needsHandCheck, runDoor } from './door';

const GOLD = '#FFD24D';
const PASS_MS = 5000;

type Door = { tokenId: string; amountRaw: string; usd: number };

export const DoorKeeper = ({ client, ticker, me }: { client: BchatClient; ticker: string; me: string }) => {
  const { apiContext } = useServiceContext();
  const wallet = apiContext.wallet as unknown as WalletInterface;
  const rate = useBsvUsd();
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const [door, setDoor] = useState<Door | null>(null);
  const [hostKey, setHostKey] = useState('');
  const [admitted, setAdmitted] = useState(0);
  const [check, setCheck] = useState<string[]>([]);
  const [note, setNote] = useState('');
  const [open, setOpen] = useState(false);

  // Am I the live host of a ticketed (BSV-21, hold) room? Then open the door.
  useEffect(() => {
    if (door) return;
    let live = true;
    const t = ticker.replace(/^\$/, '').toUpperCase();
    const look = async () => {
      try {
        const [rooms, st, key] = await Promise.all([
          client.rooms(),
          client.space(t).then((d) => parseSpaceState(d, me)),
          wallet.getPublicKey({ identityKey: true }).then((r) => r.publicKey.toLowerCase()),
        ]);
        if (!st.space || st.space.host !== me.replace(/^\$/, '').toLowerCase()) return;
        const room = rooms.find((r) => r.ticker.toUpperCase() === t);
        const gate = room ? gateOfRoom(room) : null;
        if (!gate || !gate.key.startsWith('bsv21:')) return;
        const page = parsePage(((await client.spacePageLink(t).catch(() => null)) as { page?: unknown } | null)?.page);
        const usd = doorPriceUsd(page?.entry.kind === 'token' ? page.entry.usd : null);
        if (!live) return;
        setHostKey(key);
        setDoor({ tokenId: gate.key.slice('bsv21:'.length), amountRaw: gate.minRaw || '1', usd });
      } catch {
        /* not hosting, or offline: the door stays shut */
      }
    };
    void look();
    // The Space may start after this mounts (Go live): look again until the door opens.
    const id = setInterval(() => void look(), 15_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [client, ticker, me, wallet, door]);

  useEffect(() => {
    if (!door || !hostKey) return;
    const t = ticker.replace(/^\$/, '').toUpperCase();
    setCheck(needsHandCheck(loadLedger(hostKey), t).map((c) => c.txid));
    let busy = false;
    const pass = async () => {
      if (busy) return;
      busy = true;
      try {
        const r = await runDoor(wallet, {
          hostKey,
          ticker: t,
          priceSats: usdToSats(door.usd, rateRef.current),
          sendTicket: async ({ ordAddress }) => {
            const res = await sendBsv21.execute(apiContext, {
              tokenId: door.tokenId,
              recipients: [{ amount: BigInt(door.amountRaw), destination: { address: ordAddress } }],
            });
            if (!res.txid || res.error) throw new Error(getErrorMessage(res.error));
            return res.txid;
          },
        });
        if (r.admitted) setAdmitted((n) => n + r.admitted);
        if (r.lastNote) setNote(r.lastNote);
        if (r.check) setCheck(needsHandCheck(loadLedger(hostKey), t).map((c) => c.txid));
      } catch (e) {
        setNote(e instanceof Error ? e.message.slice(0, 120) : 'Door offline');
      } finally {
        busy = false;
      }
    };
    void pass();
    const id = setInterval(() => void pass(), PASS_MS);
    return () => clearInterval(id);
  }, [door, hostKey, ticker, wallet, apiContext]);

  if (!door || typeof document === 'undefined') return null;
  return createPortal(
    <div
      className="fixed right-2 text-[11px]"
      style={{ top: 'calc(env(safe-area-inset-top, 0px) + 58px)', zIndex: 1001, maxWidth: 260 }}
    >
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded-full px-3 py-1 font-semibold"
        style={{ background: 'rgba(0,0,0,.7)', border: `1px solid ${GOLD}`, color: GOLD }}
      >
        Door {fmtUsd(door.usd)} · {admitted} in{check.length ? ` · ${check.length} to check` : ''}
      </button>
      {open && (
        <div className="mt-1 rounded-xl p-2 text-white" style={{ background: 'rgba(0,0,0,.85)' }}>
          <p>Listeners pay {fmtUsd(door.usd)} to you. Your phone sends each one a ticket. Keep this Space open.</p>
          {note && <p className="mt-1 opacity-70">Last: {note}</p>}
          {check.map((txid) => (
            <p key={txid} className="mt-1 break-all opacity-90">
              Paid, ticket not confirmed. Check Activity, then send by hand if needed: {txid.slice(0, 12)}…
            </p>
          ))}
        </div>
      )}
    </div>,
    document.body,
  );
};

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Copy } from 'lucide-react';
import { PublicKey } from '@bsv/sdk';
import { MESSAGE_SIGNING_PROTOCOL } from '@1sat/types';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBackClose } from '../backStack';
import { sendMessageAsync } from '../../utils/chromeHelpers';
import { YoursEventName } from '../../inject';
import { listPaymails, type WalletName } from '../names/paymail';
import { useAccountNames } from '../names/accountNames';
import { loadSession, SESSION_EVENT } from '../chat/api';
import { useKyc } from '../kyc/useKyc';

/**
 * Settings › Identity › Identity map (owner, 8 Oct 2026): one picture of the current account.
 * Seed → identity key → keys derived by purpose (BRC-42) → the labels that point at them.
 * Public values only: never a private key, never the seed.
 */

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const CARD = '#17191E';

const shortKey = (k: string, head = 6, tail = 4) =>
  !k ? '' : k.length <= head + tail + 1 ? k : `${k.slice(0, head)}…${k.slice(-tail)}`;

const useCopy = () => {
  const [copied, setCopied] = useState('');
  const copy = (v: string) => {
    void navigator.clipboard?.writeText(v).catch(() => undefined);
    setCopied(v);
    setTimeout(() => setCopied(''), 1500);
  };
  return { copied, copy };
};

type NodeProps = {
  title: string;
  what: string;
  value?: string;
  shown?: string;
  depth?: 0 | 1 | 2;
  badge?: ReactNode;
  children?: ReactNode;
  copy: (v: string) => void;
  copied: string;
};

const Node = ({ title, what, value, shown, depth = 0, badge, children, copy, copied }: NodeProps) => (
  <div style={{ marginLeft: depth * 14 }} className="relative">
    {depth > 0 && (
      <span aria-hidden className="absolute -left-[9px] top-0 bottom-0" style={{ borderLeft: `1px solid ${GOLD}55` }} />
    )}
    <div
      className="rounded-xl px-3 py-2.5 mb-2"
      style={{ background: CARD, border: depth === 0 ? `1px solid ${GOLD}66` : '1px solid #ffffff10' }}
    >
      <div className="flex items-center gap-2">
        <span className="text-[13px] font-semibold text-white">{title}</span>
        {badge}
      </div>
      {value ? (
        <button
          type="button"
          onClick={() => copy(value)}
          className="mt-1 flex w-full items-center gap-1.5 border-0 bg-transparent p-0 text-left"
          aria-label={`Copy ${title}`}
        >
          <span className="truncate font-mono text-[12px]" style={{ color: GOLD }}>
            {shown ?? value}
          </span>
          {copied === value ? <Check size={12} color="#2ecc71" /> : <Copy size={12} color={MUTED} />}
        </button>
      ) : shown ? (
        <div className="mt-1 text-[12px]" style={{ color: GOLD }}>
          {shown}
        </div>
      ) : null}
      <p className="m-0 mt-1 text-[11px] leading-snug" style={{ color: MUTED }}>
        {what}
      </p>
      {children}
    </div>
  </div>
);

export const IdentityMap = ({ onClose }: { onClose: () => void }) => {
  useBackClose(true, onClose);
  const { apiContext, chromeStorageService } = useServiceContext();
  const account = chromeStorageService.getCurrentAccountObject().account;
  const identityAddress = account?.addresses?.identityAddress ?? '';
  const ordAddress = account?.addresses?.ordAddress ?? '';
  const depositCount = (account?.settings?.maxKeyIndex ?? 4) + 1;
  const names = useAccountNames(identityAddress, account?.name ?? '', '', false);
  const { kyc } = useKyc();
  const { copied, copy } = useCopy();

  const [identityKey, setIdentityKey] = useState('');
  const [chatKeyAddress, setChatKeyAddress] = useState('');
  const [receive, setReceive] = useState('');
  const [paymails, setPaymails] = useState<WalletName[] | null>(null);
  const [session, setSession] = useState(() => loadSession());

  useEffect(() => {
    const on = () => setSession(loadSession());
    window.addEventListener(SESSION_EVENT, on);
    return () => window.removeEventListener(SESSION_EVENT, on);
  }, []);

  useEffect(() => {
    let live = true;
    const w = apiContext?.wallet;
    if (!w) return;
    w.getPublicKey({ identityKey: true })
      .then(({ publicKey }) => {
        if (!live) return;
        setIdentityKey(publicKey);
        return listPaymails((u, i) => fetch(u, i), publicKey).then((n) => live && setPaymails(n));
      })
      .catch(() => live && setPaymails([]));
    w.getPublicKey({ protocolID: MESSAGE_SIGNING_PROTOCOL, keyID: 'identity', forSelf: true })
      .then(({ publicKey }) => live && setChatKeyAddress(PublicKey.fromString(publicKey).toAddress()))
      .catch(() => undefined);
    sendMessageAsync<{ success: boolean; data?: string }>({ action: YoursEventName.GET_RECEIVE_ADDRESS })
      .then((r) => live && r?.success && r.data && setReceive(r.data))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [apiContext]);

  const chatMatches = !!session && !!chatKeyAddress && session.address === chatKeyAddress;
  const verified = !!kyc?.verified;
  const p = { copy, copied };

  return createPortal(
    <div className="fixed inset-0 z-[80] flex flex-col" style={{ background: '#010101' }}>
      <div
        className="flex items-center gap-2 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: '1px solid #ffffff14' }}
      >
        <button onClick={onClose} aria-label="Back" className="p-2">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Identity map</span>
      </div>
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-4 pb-24">
        <p className="m-0 mb-3 text-[12px] leading-snug" style={{ color: MUTED }}>
          One key is you. Everything else is derived from it, and names are labels that point at those keys. This
          account, as it is right now:
        </p>

        <Node
          {...p}
          title="Seed (12 words)"
          shown="Hidden. Never shown here"
          what="The root of everything below. Restoring these words brings every key back."
        />

        <Node
          {...p}
          depth={1}
          title="Identity key"
          value={identityKey}
          shown={shortKey(identityKey)}
          what="Who you are. A public key, not an address. Paymail returns it, calls route by it, contracts are sealed with it."
        />

        <Node
          {...p}
          depth={2}
          title="Receive (deposit) address"
          value={receive}
          shown={receive ? shortKey(receive, 8, 6) : 'Loading…'}
          what={`Payments land here. A fresh one per payment (BRC-42, purpose "payment"); this account has ${depositCount} so far.`}
        />
        <Node
          {...p}
          depth={2}
          title="Ordinals / token address"
          value={ordAddress}
          shown={shortKey(ordAddress, 8, 6)}
          what="Where NFTs, ordinals and BSV-21 tokens are held. Separate from the payment addresses."
        />
        <Node
          {...p}
          depth={2}
          title="Chat sign-in key"
          value={chatKeyAddress}
          shown={chatKeyAddress ? shortKey(chatKeyAddress, 8, 6) : 'Loading…'}
          what="The message-signing key (keyID 'identity'). bChat and bit-sign know you by this one."
        />
        <Node
          {...p}
          depth={2}
          title="Per-friend keys"
          shown="One per person you deal with"
          what="A shared key worked out with each counterparty (ECDH), for private payments and DMs. Nobody else can link them."
        />
        <Node
          {...p}
          depth={2}
          title="Locks, pots and other purposes"
          shown="One key per purpose"
          what="Each feature asks for its own derived key, so one purpose never exposes another."
        />

        <p className="m-0 mb-2 mt-4 text-xs font-semibold uppercase tracking-widest" style={{ color: MUTED }}>
          Labels that point at these keys
        </p>

        <Node
          {...p}
          title="Paymail names"
          shown={paymails === null ? 'Loading…' : paymails.length ? undefined : 'None yet'}
          what="name@bwalletx.com. Each one points at your identity key."
        >
          {paymails?.map((n) => (
            <button
              key={n.paymail}
              type="button"
              onClick={() => copy(n.paymail)}
              className="mt-1 flex w-full items-center gap-1.5 border-0 bg-transparent p-0 text-left"
            >
              <span className="truncate text-[12px]" style={{ color: GOLD }}>
                {n.paymail}
              </span>
              {n.main && (
                <span className="text-[9px] font-bold" style={{ color: GOLD }}>
                  MAIN
                </span>
              )}
              {copied === n.paymail && <Check size={12} color="#2ecc71" />}
            </button>
          ))}
        </Node>

        <Node
          {...p}
          title="bChat handle"
          shown={
            session
              ? `$${session.handle.replace(/^\$/, '')} → ${shortKey(session.address, 8, 6)}`
              : 'Not signed in to chat'
          }
          badge={
            session && chatKeyAddress ? (
              <span
                className="text-[10px] font-bold rounded px-1.5 py-0.5"
                style={{
                  background: chatMatches ? '#2ecc7122' : '#F9706622',
                  color: chatMatches ? '#2ecc71' : '#F97066',
                }}
              >
                {chatMatches ? 'THIS ACCOUNT' : 'OTHER KEY'}
              </span>
            ) : undefined
          }
          what={
            session && chatKeyAddress && !chatMatches
              ? 'This handle is tied to a key that is not this account’s chat sign-in key. Sign out of chat and back in.'
              : 'Points at the chat sign-in key above, not at the identity key.'
          }
        />

        <Node
          {...p}
          title="OpNS name"
          shown={names.handle || 'None'}
          what="An on-chain name you own as an ordinal. It points at your ordinals address."
        />

        <Node
          {...p}
          title="$401 identity"
          shown={verified ? `Level ${kyc?.level ?? 1}` : 'Not verified'}
          badge={
            verified ? (
              <span
                className="text-[10px] font-bold rounded px-1.5 py-0.5"
                style={{ background: '#2ecc7122', color: '#2ecc71' }}
              >
                VERIFIED
              </span>
            ) : undefined
          }
          what="Identity and ID-check strands attached to your identity key. Only the level shows; no ID data is stored here."
        />

        <p className="m-0 mb-2 mt-4 text-xs font-semibold uppercase tracking-widest" style={{ color: MUTED }}>
          Who knows you by which key
        </p>
        <div className="rounded-xl px-3 py-2 text-[12px]" style={{ background: CARD }}>
          {[
            ['Paymail, calls, contracts', 'Identity key'],
            ['bChat, bit-sign, rooms', 'Chat sign-in key'],
            ['People paying you', 'A fresh receive address'],
            ['NFT and token markets', 'Ordinals address'],
            ['Friends (private pay, DMs)', 'A per-friend key'],
          ].map(([who, key]) => (
            <div key={who} className="flex justify-between gap-3 py-1" style={{ borderBottom: '1px solid #ffffff08' }}>
              <span className="text-white">{who}</span>
              <span className="shrink-0 text-right" style={{ color: GOLD }}>
                {key}
              </span>
            </div>
          ))}
        </div>
        <p className="m-0 mt-3 text-[11px]" style={{ color: '#667085' }}>
          Only public keys and addresses are shown. Your seed and private keys never leave the wallet.
        </p>
      </div>
    </div>,
    document.body,
  );
};

import { useEffect, useState } from 'react';
import { Ban, BadgeCheck, Mic, MicOff, Phone, PhoneOff, UserPlus, Volume2 } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useAccountNames } from '../names/MyNameBadge';
import { bareName } from '../names/names';
import {
  accept,
  blockCaller,
  decline,
  dismiss,
  hangUp,
  setCallLabel,
  startCalls,
  stopCalls,
  toggleMute,
  toggleSpeaker,
} from './store';
import { useCalls } from './useCalls';
import { addFriend, isFriend } from './friends';
import { END_TEXT, formatDuration, type CallState } from './machine';

/**
 * App-wide call overlay (mounted next to MiniPlayer by vite.config.mobile.ts): starts the
 * call controller while the wallet is unlocked and shows the incoming / outgoing / in-call /
 * ended screens above every tab.
 *
 * ⚠ RINGING ONLY WORKS WHILE THE APP IS OPEN. The controller polls bit-sign; a closed or
 * suspended app hears nothing. Next step: VoIP push — iOS PushKit + CallKit (APNs VoIP
 * certificate, report the call to CallKit within the push handler), Android FCM high-priority
 * data message + ConnectionService / a full-screen-intent notification — with bit-sign sending
 * the push when it inserts the `wallet_calls` row.
 */
const GOLD = '#F5B800';

const Round = ({
  label,
  onClick,
  bg,
  children,
  on,
}: {
  label: string;
  onClick: () => void;
  bg?: string;
  on?: boolean;
  children: React.ReactNode;
}) => (
  <button onClick={onClick} aria-label={label} aria-pressed={on} className="flex flex-col items-center gap-2">
    <span
      className="w-16 h-16 rounded-full flex items-center justify-center"
      style={{ background: bg ?? (on ? '#F2F2F0' : '#2b2f36') }}
    >
      {children}
    </span>
    <span className="text-xs text-[#c9ccd1]">{label}</span>
  </button>
);

const Timer = ({ since }: { since: number }) => {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="font-mono">{formatDuration(now - since)}</span>;
};

const status = (s: CallState) => {
  switch (s.phase) {
    case 'dialing':
      return 'Calling…';
    case 'ringing-out':
      return 'Ringing…';
    case 'incoming':
      return 'Incoming bWallet call';
    case 'connecting':
      return 'Connecting…';
    case 'active':
      return <Timer since={s.since} />;
    case 'ended':
      return s.message && s.reason !== 'hung-up' ? `${END_TEXT[s.reason]}: ${s.message}` : END_TEXT[s.reason];
    default:
      return '';
  }
};

export const CallScreen = () => {
  const { apiContext, isLocked, chromeStorageService } = useServiceContext();
  const identityAddress = chromeStorageService?.getCurrentAccountObject?.()?.account?.addresses.identityAddress;
  // The label callees verify: our full paymail (unambiguous), else the OpNS name. Shown bare.
  const { paymail, handle } = useAccountNames(identityAddress, '', '', false);
  const myName = paymail || handle;
  const { call } = useCalls();
  const [note, setNote] = useState('');

  useEffect(() => setCallLabel(myName || undefined), [myName]);
  useEffect(() => {
    if (isLocked || !apiContext?.wallet) return stopCalls();
    startCalls(apiContext);
    // Locking the wallet unmounts this (App renders it only when unlocked): stop polling.
    return stopCalls;
  }, [apiContext, isLocked]);

  useEffect(() => setNote(''), [call.phase]);

  if (call.phase === 'idle') return null;
  const peer = call.peer;

  return (
    <div
      className="fixed inset-0 z-[200] flex flex-col items-center justify-between text-white"
      style={{
        background: 'linear-gradient(180deg,#141518 0%,#050506 100%)',
        paddingTop: 'calc(var(--wallet-inset-top, 0px) + 72px)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 48px)',
      }}
      role="dialog"
      aria-label="Call"
    >
      <div className="flex flex-col items-center gap-3 px-6 text-center">
        <div
          className="w-24 h-24 rounded-full flex items-center justify-center text-3xl font-bold"
          style={{ background: '#2a2208', border: `2px solid ${GOLD}`, color: GOLD }}
        >
          {bareName(peer.label).replace(/^\$/, '').slice(0, 1).toUpperCase()}
        </div>
        <div className="flex items-center gap-1.5 max-w-[300px]">
          <span className="text-2xl font-semibold truncate">{bareName(peer.label)}</span>
          {peer.verified && <BadgeCheck size={18} color="#2ecc71" aria-label="Name verified" />}
        </div>
        <div className="text-sm text-[#98A2B3]">{status(call)}</div>
        {note && <div className="text-xs text-[#F5B800]">{note}</div>}
      </div>

      {call.phase === 'incoming' && (
        <div className="flex flex-col items-center gap-8">
          <div className="flex gap-16">
            <Round label="Decline" bg="#e5484d" onClick={() => void decline()}>
              <PhoneOff size={26} color="#fff" />
            </Round>
            <Round label="Accept" bg="#2ecc71" onClick={() => void accept()}>
              <Phone size={26} color="#fff" />
            </Round>
          </div>
          <button
            className="flex items-center gap-1.5 text-xs text-[#98A2B3]"
            onClick={() => void blockCaller(peer.key, peer.label).catch(() => undefined)}
          >
            <Ban size={14} /> Block this caller
          </button>
        </div>
      )}

      {(call.phase === 'dialing' ||
        call.phase === 'ringing-out' ||
        call.phase === 'connecting' ||
        call.phase === 'active') && (
        <div className="flex flex-col items-center gap-10">
          {call.phase === 'active' && (
            <div className="flex gap-12">
              <Round label={call.muted ? 'Unmute' : 'Mute'} on={call.muted} onClick={() => void toggleMute()}>
                {call.muted ? <MicOff size={24} color="#111" /> : <Mic size={24} color="#fff" />}
              </Round>
              <Round label="Speaker" on={call.speaker} onClick={() => void toggleSpeaker()}>
                <Volume2 size={24} color={call.speaker ? '#111' : '#fff'} />
              </Round>
            </div>
          )}
          <Round label="Hang up" bg="#e5484d" onClick={() => void hangUp()}>
            <PhoneOff size={26} color="#fff" />
          </Round>
        </div>
      )}

      {call.phase === 'ended' && (
        <div className="flex flex-col items-center gap-4 w-full px-8">
          {call.duration !== undefined && <div className="text-sm text-[#98A2B3]">{formatDuration(call.duration)}</div>}
          {!isFriend(peer.key) && (
            <button
              className="w-full rounded-xl py-3 flex items-center justify-center gap-2 font-semibold"
              style={{ background: GOLD, color: '#1a1300' }}
              onClick={() =>
                void addFriend({ key: peer.key, name: peer.label })
                  .then(() => setNote('Added to friends'))
                  .catch((e) => setNote(e instanceof Error ? e.message : String(e)))
              }
            >
              <UserPlus size={18} /> Add to friends
            </button>
          )}
          <button className="w-full rounded-xl py-3 font-semibold border border-[#2b2f36]" onClick={dismiss}>
            Close
          </button>
        </div>
      )}
    </div>
  );
};

export default CallScreen;

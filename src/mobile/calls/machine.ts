/**
 * The phone's view of a 1-to-1 call, as a pure reducer (tested in machine.test.ts).
 *
 *   idle ─DIAL─▶ dialing ─PLACED─▶ ringing-out ─REMOTE(active)─▶ active ─HANGUP/REMOTE(ended)─▶ ended
 *   idle ─RING_IN─▶ incoming ─ACCEPT─▶ connecting ─MEDIA_UP─▶ active
 *                        └─DECLINE / REMOTE(cancelled|missed)─▶ ended
 *   ended ─DISMISS─▶ idle
 *
 * The server (bit-sign wallet-call-policy) is the authority on the call itself; this only
 * tracks what the screen should show and refuses events that make no sense in a phase, so a
 * late poll result can never resurrect a call the user already hung up.
 */

export type ServerStatus = 'ringing' | 'active' | 'declined' | 'cancelled' | 'missed' | 'ended';

export interface ServerCall {
  id: string;
  direction: 'outgoing' | 'incoming';
  peer_key: string;
  peer_label: string | null;
  status: ServerStatus;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
}

export interface Peer {
  key: string;
  /** What to show: a verified name, else the label the other side claimed, else a short key. */
  label: string;
  verified: boolean;
}

export type EndReason = 'hung-up' | 'remote-ended' | 'declined' | 'missed' | 'cancelled' | 'failed' | 'unavailable';

export type CallState =
  | { phase: 'idle' }
  | { phase: 'dialing'; peer: Peer }
  | { phase: 'ringing-out'; peer: Peer; callId: string }
  | { phase: 'incoming'; peer: Peer; callId: string }
  | { phase: 'connecting'; peer: Peer; callId: string }
  | { phase: 'active'; peer: Peer; callId: string; since: number; muted: boolean; speaker: boolean }
  | { phase: 'ended'; peer: Peer; callId: string | null; reason: EndReason; message?: string; duration?: number };

export type CallEvent =
  | { type: 'DIAL'; peer: Peer }
  | { type: 'PLACED'; callId: string }
  | { type: 'RING_IN'; call: ServerCall; peer: Peer }
  | { type: 'ACCEPT' }
  | { type: 'DECLINE' }
  | { type: 'MEDIA_UP'; at: number }
  | { type: 'REMOTE'; callId: string; status: ServerStatus; at: number }
  | { type: 'HANGUP'; at: number }
  | { type: 'FAIL'; message: string; reason?: EndReason }
  | { type: 'TOGGLE_MUTE' }
  | { type: 'TOGGLE_SPEAKER' }
  | { type: 'DISMISS' };

export const IDLE: CallState = { phase: 'idle' };

const callIdOf = (s: CallState): string | null => ('callId' in s ? s.callId : null);

const ended = (
  s: Exclude<CallState, { phase: 'idle' }>,
  reason: EndReason,
  at?: number,
  message?: string,
): CallState => ({
  phase: 'ended',
  peer: s.peer,
  callId: callIdOf(s),
  reason,
  message,
  duration: s.phase === 'active' && at !== undefined ? Math.max(0, at - s.since) : undefined,
});

const REMOTE_END: Partial<Record<ServerStatus, EndReason>> = {
  declined: 'declined',
  cancelled: 'cancelled',
  missed: 'missed',
  ended: 'remote-ended',
};

export function reduce(s: CallState, e: CallEvent): CallState {
  switch (e.type) {
    case 'DIAL':
      return s.phase === 'idle' || s.phase === 'ended' ? { phase: 'dialing', peer: e.peer } : s;
    case 'PLACED':
      return s.phase === 'dialing' ? { phase: 'ringing-out', peer: s.peer, callId: e.callId } : s;
    case 'RING_IN':
      // Busy: a second incoming call while on (or placing) one is ignored; the caller hears
      // it ring out to missed. Only a fresh idle/ended screen takes it.
      if (s.phase !== 'idle' && s.phase !== 'ended') return s;
      if (e.call.status !== 'ringing' || e.call.direction !== 'incoming') return s;
      return { phase: 'incoming', peer: e.peer, callId: e.call.id };
    case 'ACCEPT':
      return s.phase === 'incoming' ? { phase: 'connecting', peer: s.peer, callId: s.callId } : s;
    case 'DECLINE':
      return s.phase === 'incoming' ? ended(s, 'declined') : s;
    case 'MEDIA_UP':
      return s.phase === 'connecting'
        ? { phase: 'active', peer: s.peer, callId: s.callId, since: e.at, muted: false, speaker: false }
        : s;
    case 'REMOTE': {
      if (s.phase === 'idle' || s.phase === 'ended' || callIdOf(s) !== e.callId) return s;
      if (e.status === 'active') {
        // The callee picked up: the caller's screen goes live (its media joined while ringing).
        if (s.phase === 'ringing-out')
          return { phase: 'active', peer: s.peer, callId: s.callId, since: e.at, muted: false, speaker: false };
        return s;
      }
      const reason = REMOTE_END[e.status];
      if (!reason) return s;
      // A caller who cancelled while we were deciding: show it as missed on our side.
      if (s.phase === 'incoming' && reason === 'cancelled') return ended(s, 'missed');
      return ended(s, reason, e.at);
    }
    case 'HANGUP':
      return s.phase === 'idle' || s.phase === 'ended' ? s : ended(s, 'hung-up', e.at);
    case 'FAIL':
      return s.phase === 'idle' || s.phase === 'ended' ? s : ended(s, e.reason ?? 'failed', undefined, e.message);
    case 'TOGGLE_MUTE':
      return s.phase === 'active' ? { ...s, muted: !s.muted } : s;
    case 'TOGGLE_SPEAKER':
      return s.phase === 'active' ? { ...s, speaker: !s.speaker } : s;
    case 'DISMISS':
      return s.phase === 'ended' ? IDLE : s;
  }
}

/** Is a call in progress (anything a second call would collide with)? */
export const busy = (s: CallState) => s.phase !== 'idle' && s.phase !== 'ended';

/** mm:ss, or h:mm:ss past the hour. */
export function formatDuration(ms: number): string {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const sec = String(t % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

export const shortKey = (k: string) => `${k.slice(0, 6)}…${k.slice(-4)}`;

export const END_TEXT: Record<EndReason, string> = {
  'hung-up': 'Call ended',
  'remote-ended': 'Call ended',
  declined: 'Declined',
  missed: 'Missed call',
  cancelled: 'Cancelled',
  failed: 'Call failed',
  unavailable: 'Unavailable',
};

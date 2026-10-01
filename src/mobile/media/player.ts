/**
 * Wallet › NFTs (media) audio player. A single module-level <audio> so playback survives
 * tab switches and the screen locking (iOS: UIBackgroundModes audio +
 * AVAudioSession .playback in AppDelegate). Lock-screen / Now Playing
 * controls come from the Media Session API, which WKWebView supports.
 */
export type Track = { id: string; title: string; url: string; artwork?: string };

type State = { queue: Track[]; index: number; playing: boolean; time: number; duration: number };

let audio: HTMLAudioElement | null = null;
let state: State = { queue: [], index: -1, playing: false, time: 0, duration: 0 };
const listeners = new Set<(s: State) => void>();

const emit = (patch: Partial<State>) => {
  state = { ...state, ...patch };
  listeners.forEach((l) => l(state));
};

const el = () => {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'auto';
  audio.addEventListener('play', () => emit({ playing: true }));
  audio.addEventListener('pause', () => emit({ playing: false }));
  audio.addEventListener('timeupdate', () => emit({ time: audio!.currentTime }));
  audio.addEventListener('durationchange', () => emit({ duration: audio!.duration || 0 }));
  audio.addEventListener('ended', () => (state.index < state.queue.length - 1 ? next() : emit({ playing: false })));
  const ms = navigator.mediaSession;
  if (ms) {
    ms.setActionHandler('play', () => void audio!.play());
    ms.setActionHandler('pause', () => audio!.pause());
    ms.setActionHandler('previoustrack', () => previous());
    ms.setActionHandler('nexttrack', () => next());
    try {
      ms.setActionHandler('seekto', (d) => d.seekTime != null && (audio!.currentTime = d.seekTime));
    } catch {
      // seekto unsupported on this WebView
    }
  }
  return audio;
};

const load = (index: number) => {
  const track = state.queue[index];
  if (!track) return;
  const a = el();
  a.src = track.url;
  emit({ index, time: 0, duration: 0 });
  if (navigator.mediaSession && typeof MediaMetadata !== 'undefined') {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: 'bWallet',
      album: 'Inscriptions',
      artwork: track.artwork ? [{ src: track.artwork, sizes: '512x512' }] : [],
    });
  }
  a.play().catch((e) => console.warn('[player] play failed', e));
};

export const playQueue = (queue: Track[], start: number) => {
  emit({ queue });
  load(start);
};
export const toggle = () => {
  const a = el();
  if (a.paused) void a.play();
  else a.pause();
};
export const next = () => state.index < state.queue.length - 1 && load(state.index + 1);
export const previous = () => {
  if (audio && audio.currentTime > 3) audio.currentTime = 0;
  else if (state.index > 0) load(state.index - 1);
};
export const seek = (t: number) => audio && (audio.currentTime = t);
export const stop = () => {
  audio?.pause();
  if (audio) audio.removeAttribute('src');
  emit({ queue: [], index: -1, playing: false, time: 0, duration: 0 });
  if (navigator.mediaSession) navigator.mediaSession.metadata = null;
};
export const pauseAudio = () => audio?.pause();

export const getState = () => state;
export const subscribe = (fn: (s: State) => void) => {
  listeners.add(fn);
  return () => void listeners.delete(fn);
};

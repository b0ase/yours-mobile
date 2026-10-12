import { albumUrl, fetchBytes, initPath, segmentPath, type Manifest } from './api';
import { openSegment } from './crypto';
import type { KeySource } from './keySource';

/**
 * MediaSource playback of 1-second sealed segments: init.mp4 first (plain), then each segment as its key
 * arrives. Keeps at most AHEAD segments buffered past the playhead, so paying runs at one segment per
 * second of listening, and pause stops paying at once (the pump waits while paused).
 */
export const AHEAD = 2;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** How many segments to fetch now: the next one is due when it is within AHEAD of the playhead. */
export const segmentDue = (nextSeg: number, currentTime: number, segmentSeconds: number) =>
  nextSeg <= Math.floor(currentTime / segmentSeconds) + AHEAD;

export type EngineEvents = {
  onTrack?: (index: number) => void;
  onPlaying?: (playing: boolean) => void;
  onError?: (e: unknown) => void;
  onAlbumEnd?: () => void;
};

export class StreamEngine {
  readonly audio: HTMLAudioElement = new Audio();
  index = -1;
  /** Next segment to pay for and append (resume point after an error). */
  seg = 0;
  paused = false;
  private gen = 0;
  private url: string | null = null;

  constructor(
    private m: Manifest,
    private keys: KeySource,
    private ev: EngineEvents = {},
  ) {
    this.audio.addEventListener('play', () => ev.onPlaying?.(true));
    this.audio.addEventListener('pause', () => ev.onPlaying?.(false));
    this.audio.addEventListener('ended', () => {
      if (this.index + 1 < this.m.tracks.length) void this.playTrack(this.index + 1);
      else ev.onAlbumEnd?.();
    });
  }

  async playTrack(index: number, from = 0) {
    const gen = ++this.gen;
    this.index = index;
    this.seg = from;
    this.paused = false;
    this.ev.onTrack?.(index);
    const t = this.m.tracks[index];
    const ms = new MediaSource();
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = URL.createObjectURL(ms);
    this.audio.src = this.url;
    await new Promise<void>((r) => ms.addEventListener('sourceopen', () => r(), { once: true }));
    if (gen !== this.gen) return;
    const sb = ms.addSourceBuffer(this.m.mime);
    const append = (b: Uint8Array) =>
      new Promise<void>((resolve, reject) => {
        sb.addEventListener('updateend', () => resolve(), { once: true });
        sb.addEventListener('error', () => reject(new Error('Could not play this segment')), { once: true });
        sb.appendBuffer(b as BufferSource);
      });
    try {
      await append(await fetchBytes(albumUrl(initPath(this.m, t.trackId))));
      for (let n = from; n < t.segments; ) {
        if (gen !== this.gen) return;
        this.seg = n;
        if (this.paused || !segmentDue(n, this.audio.currentTime, this.m.segmentSeconds)) {
          await wait(150);
          continue;
        }
        const sealed = await fetchBytes(albumUrl(segmentPath(this.m, t.trackId, n)));
        const key = await this.keys.segmentKey(t.trackId, n);
        const plain = await openSegment(key, sealed);
        key.fill(0);
        if (gen !== this.gen) return;
        await append(plain);
        if (n === from) {
          if (from > 0) this.audio.currentTime = from * this.m.segmentSeconds;
          if (!this.paused) await this.audio.play().catch(() => {});
        }
        n++;
        this.seg = n;
      }
      if (gen === this.gen && ms.readyState === 'open') ms.endOfStream();
    } catch (e) {
      if (gen !== this.gen) return;
      this.audio.pause();
      this.ev.onError?.(e);
    }
  }

  pause() {
    this.paused = true;
    this.audio.pause();
  }

  resume() {
    this.paused = false;
    void this.audio.play().catch(() => {});
  }

  stop() {
    this.gen++;
    this.paused = true;
    this.audio.pause();
    this.audio.removeAttribute('src');
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }
}

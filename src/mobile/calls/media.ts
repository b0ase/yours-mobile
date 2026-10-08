import {
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
  type TrackPublication,
} from 'livekit-client';
import { isNative, YoursNative } from '../native';
import type { Facing } from './machine';

export interface MediaCallbacks {
  onDisconnected: () => void;
  /** The peer's camera started or stopped showing. */
  onRemoteVideo?: (on: boolean) => void;
  /** A JSON message from the peer over the call's data channel (bPhone payment receipts). */
  onData?: (msg: unknown) => void;
}

const DATA_TOPIC = 'bphone';

/**
 * LiveKit media for one 1-to-1 call. Microphone always; camera only when the user turns it on
 * (bit-sign's call token grants microphone + camera; a grant is not a default). Remote audio
 * goes to hidden <audio> elements; remote and local video are attached to <video> elements the
 * CallScreen hands in via `bindVideo`. Speaker routing is native (AVAudioSession /
 * AudioManager); a WebView cannot pick the earpiece vs loudspeaker itself.
 */
export class CallMedia {
  private room: Room | null = null;
  private els: HTMLMediaElement[] = [];
  private remoteVideo: RemoteTrack | null = null;
  private remoteEl: HTMLVideoElement | null = null;
  private localEl: HTMLVideoElement | null = null;
  private cb: MediaCallbacks | null = null;

  async connect(
    url: string,
    token: string,
    cb: MediaCallbacks,
    opts: { camera?: boolean; facing?: Facing } = {},
  ): Promise<{ cameraFailed: boolean }> {
    const room = new Room({ adaptiveStream: false, dynacast: false });
    this.room = room;
    this.cb = cb;
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) {
        const el = track.attach();
        el.style.display = 'none';
        document.body.appendChild(el);
        this.els.push(el);
      } else if (track.kind === Track.Kind.Video) {
        this.remoteVideo = track;
        if (this.remoteEl) track.attach(this.remoteEl);
        this.emitRemote();
      }
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => {
        if (el !== this.remoteEl) el.remove();
      });
      if (track === this.remoteVideo) {
        this.remoteVideo = null;
        this.emitRemote();
      }
    });
    // A peer turning the camera off mutes the publication rather than unpublishing it.
    const onMute = (pub: TrackPublication) => {
      if (pub.kind === Track.Kind.Video && (pub as RemoteTrackPublication).track === this.remoteVideo)
        this.emitRemote();
    };
    room.on(RoomEvent.TrackMuted, onMute);
    room.on(RoomEvent.TrackUnmuted, onMute);
    room.on(RoomEvent.Disconnected, cb.onDisconnected);
    room.on(RoomEvent.DataReceived, (payload: Uint8Array, _p, _k, topic?: string) => {
      if (topic !== DATA_TOPIC || !this.cb?.onData || payload.byteLength > 4096) return;
      try {
        this.cb.onData(JSON.parse(new TextDecoder().decode(payload)));
      } catch {
        /* not ours */
      }
    });
    await room.connect(url, token, { autoSubscribe: true });
    await room.localParticipant.setMicrophoneEnabled(true);
    await room.startAudio().catch(() => undefined);
    // A refused or missing camera must not cost the call: report it and stay on voice.
    if (!opts.camera) return { cameraFailed: false };
    try {
      await this.setCamera(true, opts.facing ?? 'user');
      return { cameraFailed: false };
    } catch {
      return { cameraFailed: true };
    }
  }

  private emitRemote() {
    const t = this.remoteVideo;
    this.cb?.onRemoteVideo?.(!!t && !t.isMuted);
  }

  private localVideo(): LocalVideoTrack | null {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Camera);
    return (pub?.track as LocalVideoTrack | undefined) ?? null;
  }

  /** Point the screen's <video> elements at the call (null to unbind). */
  bindVideo(local: HTMLVideoElement | null, remote: HTMLVideoElement | null) {
    if (this.remoteEl && this.remoteEl !== remote) this.remoteVideo?.detach(this.remoteEl);
    if (this.localEl && this.localEl !== local) this.localVideo()?.detach(this.localEl);
    this.remoteEl = remote;
    this.localEl = local;
    if (remote && this.remoteVideo) this.remoteVideo.attach(remote);
    if (local) this.localVideo()?.attach(local);
  }

  /** Turn our camera on (publishing it) or off (muting it; the peer sees the avatar again). */
  async setCamera(on: boolean, facing: Facing) {
    const room = this.room;
    if (!room) return;
    await room.localParticipant.setCameraEnabled(on, on ? { facingMode: facing } : undefined);
    if (on && this.localEl) this.localVideo()?.attach(this.localEl);
  }

  /** Switch between the front and back camera without unpublishing. */
  async flipCamera(facing: Facing) {
    const t = this.localVideo();
    if (!t) return;
    await t.restartTrack({ facingMode: facing });
    if (this.localEl) t.attach(this.localEl);
  }

  /** Send a small JSON message to the peer (reliable; dropped silently when the room is gone). */
  async sendData(msg: unknown) {
    const room = this.room;
    if (!room) return;
    await room.localParticipant
      .publishData(new TextEncoder().encode(JSON.stringify(msg)), { reliable: true, topic: DATA_TOPIC })
      .catch(() => undefined);
  }

  async setMuted(muted: boolean) {
    await this.room?.localParticipant.setMicrophoneEnabled(!muted);
  }

  async setSpeaker(on: boolean) {
    if (isNative) await YoursNative.audioSetSpeaker({ on }).catch(() => undefined);
  }

  async close() {
    const room = this.room;
    this.room = null;
    this.cb = null;
    this.els.forEach((el) => el.remove());
    this.els = [];
    if (this.remoteEl) this.remoteVideo?.detach(this.remoteEl);
    this.remoteVideo = null;
    this.remoteEl = null;
    this.localEl = null;
    if (isNative) await YoursNative.audioSetSpeaker({ on: false }).catch(() => undefined);
    // Disconnecting stops local tracks, which releases the camera (and its indicator light).
    await room?.disconnect().catch(() => undefined);
  }
}

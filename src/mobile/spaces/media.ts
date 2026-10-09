import {
  LocalVideoTrack,
  Room,
  RoomEvent,
  Track,
  type Participant as LkParticipant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication,
  type VideoTrack,
} from 'livekit-client';
import { isNative, YoursNative } from '../native';
import { ensureMediaAccess, setAudioSession } from '../permissions/ensureMediaAccess';

export type Facing = 'user' | 'environment';

export interface SpaceMediaCallbacks {
  /** Handles whose camera is live (LiveKit identity is the bChat handle, set by bit-sign). */
  onVideos: (handles: string[]) => void;
  /** Handles currently speaking (LiveKit active-speaker detection). */
  onSpeakers: (handles: string[]) => void;
  /** The SFU changed what I may publish (host brought me up or sent me back). */
  onCanPublish: (can: boolean) => void;
  onDisconnected: () => void;
  /**
   * Who is sharing a screen right now (owner handle), or null. A laptop shares as the
   * `handle.screen` identity (bit-sign `device: 'screen'`), so the phone keeps the voice.
   */
  onScreen?: (owner: string | null) => void;
}

/** bit-sign's screen-device identity suffix: `alice.screen` is alice's laptop. */
const SCREEN_SUFFIX = '.screen';
export const ownerOfIdentity = (id: string) => (id.endsWith(SCREEN_SUFFIX) ? id.slice(0, -SCREEN_SUFFIX.length) : id);

/**
 * LiveKit media for one bSpace (many people, one SFU room). bit-sign mints the token from the
 * participant row: listeners may only subscribe; host and speakers may publish mic and camera.
 * Joining never opens a device: the mic opens when you are on stage and say so, the camera only
 * when you turn it on. Same rule as bit-sign's space-sfu.ts, so web and wallet behave alike.
 *
 * Unlike the 1:1 CallMedia, adaptive stream and dynacast are ON: with many viewers each one only
 * receives the layers its tiles need, and a publisher stops sending layers nobody watches.
 */
export class SpaceMedia {
  private room: Room | null = null;
  private audio = new Map<string, HTMLMediaElement>();
  private videos = new Map<string, VideoTrack>();
  private bound = new Map<string, HTMLVideoElement>();
  /** Shared screens by publishing identity; the newest is shown. */
  private screens = new Map<string, VideoTrack>();
  private screenEl: HTMLVideoElement | null = null;
  private cb: SpaceMediaCallbacks | null = null;
  /** "Mute the room" for me: every incoming voice silenced locally (my mic is separate). */
  private deaf = false;
  me = '';

  get deafened() {
    return this.deaf;
  }

  /** Silence (or restore) all incoming audio on this phone only, including voices that join later. */
  setDeafened(on: boolean) {
    this.deaf = on;
    this.audio.forEach((el) => {
      el.muted = on;
    });
  }

  async connect(url: string, token: string, cb: SpaceMediaCallbacks): Promise<void> {
    const room = new Room({
      adaptiveStream: true,
      dynacast: true,
      audioCaptureDefaults: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      publishDefaults: { stopMicTrackOnMute: true, simulcast: true },
    });
    this.room = room;
    this.cb = cb;
    room
      .on(RoomEvent.TrackSubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, who: RemoteParticipant) => {
        if (track.kind === Track.Kind.Audio) {
          const el = track.attach();
          el.style.display = 'none';
          el.muted = this.deaf;
          document.body.appendChild(el);
          this.audio.set(`${who.identity}:${pub.trackSid}`, el);
        } else if (track.kind === Track.Kind.Video && pub.source === Track.Source.ScreenShare) {
          this.screens.delete(who.identity);
          this.screens.set(who.identity, track as VideoTrack);
          this.emitScreen();
        } else if (track.kind === Track.Kind.Video && pub.source === Track.Source.Camera) {
          this.videos.set(who.identity, track as VideoTrack);
          this.reattach(who.identity);
          this.emitVideos();
        }
      })
      .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack, pub: RemoteTrackPublication, who: RemoteParticipant) => {
        if (track.kind === Track.Kind.Video && this.screens.get(who.identity) === track) {
          track.detach();
          this.screens.delete(who.identity);
          this.emitScreen();
          return;
        }
        if (track.kind === Track.Kind.Video) {
          track.detach();
          if (this.videos.get(who.identity) === track) this.videos.delete(who.identity);
          this.emitVideos();
          return;
        }
        track.detach().forEach((el) => el.remove());
        this.audio.delete(`${who.identity}:${pub.trackSid}`);
      })
      .on(RoomEvent.TrackMuted, () => this.emitVideos())
      .on(RoomEvent.TrackUnmuted, () => this.emitVideos())
      .on(RoomEvent.LocalTrackPublished, () => this.emitVideos())
      .on(RoomEvent.LocalTrackUnpublished, () => this.emitVideos())
      .on(RoomEvent.ParticipantDisconnected, (who: RemoteParticipant) => {
        if (this.videos.delete(who.identity)) this.emitVideos();
        if (this.screens.delete(who.identity)) this.emitScreen();
      })
      .on(RoomEvent.ActiveSpeakersChanged, (speakers: LkParticipant[]) =>
        this.cb?.onSpeakers(speakers.map((p) => p.identity)),
      )
      .on(RoomEvent.ParticipantPermissionsChanged, () => {
        const can = !!room.localParticipant.permissions?.canPublish;
        // Sent back to the audience: the SFU already stopped forwarding us; release the devices too.
        if (!can) void this.releaseDevices();
        this.cb?.onCanPublish(can);
      })
      .on(RoomEvent.Disconnected, () => this.cb?.onDisconnected());
    await room.connect(url, token, { autoSubscribe: true });
    this.me = room.localParticipant.identity;
    await room.startAudio().catch(() => undefined);
    if (isNative) await YoursNative.audioSetSpeaker({ on: true }).catch(() => undefined);
  }

  private localVideo(): LocalVideoTrack | null {
    const pub = this.room?.localParticipant.getTrackPublication(Track.Source.Camera);
    const t = (pub?.track as LocalVideoTrack | undefined) ?? null;
    return t && !pub?.isMuted ? t : null;
  }

  private emitVideos() {
    const live = [...this.videos.entries()].filter(([, t]) => !t.isMuted).map(([h]) => h);
    if (this.localVideo()) live.unshift(this.me);
    this.cb?.onVideos(live);
    for (const h of live) this.reattach(h);
  }

  private currentScreen(): [string, VideoTrack] | null {
    const all = [...this.screens.entries()];
    return all.length ? all[all.length - 1] : null;
  }

  private emitScreen() {
    const cur = this.currentScreen();
    this.cb?.onScreen?.(cur ? ownerOfIdentity(cur[0]) : null);
    if (cur && this.screenEl && !cur[1].attachedElements.includes(this.screenEl)) cur[1].attach(this.screenEl);
  }

  /** The big screen tile hands in its <video> (or null when it unmounts). */
  bindScreen(el: HTMLVideoElement | null) {
    const cur = this.currentScreen();
    if (this.screenEl && this.screenEl !== el) cur?.[1].detach(this.screenEl);
    this.screenEl = el;
    if (el && cur && !cur[1].attachedElements.includes(el)) cur[1].attach(el);
  }

  private trackOf(handle: string): VideoTrack | null {
    return handle === this.me ? this.localVideo() : (this.videos.get(handle) ?? null);
  }

  private reattach(handle: string) {
    const el = this.bound.get(handle);
    const t = this.trackOf(handle);
    if (el && t && !t.attachedElements.includes(el)) t.attach(el);
  }

  /** A stage tile hands in its <video> (or null when it unmounts). */
  bindVideo(handle: string, el: HTMLVideoElement | null) {
    const old = this.bound.get(handle);
    if (old && old !== el) this.trackOf(handle)?.detach(old);
    if (el) this.bound.set(handle, el);
    else this.bound.delete(handle);
    this.reattach(handle);
  }

  /** Audio level 0..1 for a handle (LiveKit's smoothed participant level), read by the stage tiles' meters. */
  levelOf(handle: string): number {
    const room = this.room;
    if (!room) return 0;
    const who = handle === this.me ? room.localParticipant : room.getParticipantByIdentity(handle);
    return who?.audioLevel ?? 0;
  }

  get canPublish() {
    return !!this.room?.localParticipant.permissions?.canPublish;
  }

  get micOn() {
    return !!this.room?.localParticipant.isMicrophoneEnabled;
  }

  get cameraOn() {
    return !!this.localVideo();
  }

  /** Opens the mic (the OS asks for permission the first time). Throws if refused or not granted. */
  async setMic(on: boolean) {
    if (on) await ensureMediaAccess('mic');
    await this.room?.localParticipant.setMicrophoneEnabled(on);
  }

  async setCamera(on: boolean, facing: Facing = 'user') {
    if (on) await ensureMediaAccess('camera');
    await this.room?.localParticipant.setCameraEnabled(on, on ? { facingMode: facing } : undefined);
    this.emitVideos();
  }

  async flipCamera(facing: Facing) {
    await this.localVideo()?.restartTrack({ facingMode: facing });
    this.reattach(this.me);
  }

  private async releaseDevices() {
    const lp = this.room?.localParticipant;
    if (!lp) return;
    await lp.setMicrophoneEnabled(false).catch(() => undefined);
    await lp.setCameraEnabled(false).catch(() => undefined);
    this.emitVideos();
  }

  async close() {
    const room = this.room;
    this.room = null;
    this.cb = null;
    this.audio.forEach((el) => el.remove());
    this.audio.clear();
    this.videos.clear();
    this.bound.clear();
    this.screens.clear();
    this.screenEl = null;
    if (isNative) await YoursNative.audioSetSpeaker({ on: false }).catch(() => undefined);
    // Disconnecting stops local tracks, which releases the mic and camera (and their indicators).
    await room?.disconnect().catch(() => undefined);
    setAudioSession('auto');
  }
}

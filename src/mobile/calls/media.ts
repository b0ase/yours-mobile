import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { isNative, YoursNative } from '../native';

/**
 * LiveKit audio for one call. Microphone only; remote audio is attached to hidden <audio>
 * elements. Speaker routing is native (AVAudioSession / AudioManager); a WebView cannot pick
 * the earpiece vs loudspeaker itself.
 */
export class CallMedia {
  private room: Room | null = null;
  private els: HTMLMediaElement[] = [];

  async connect(url: string, token: string, onDisconnected: () => void): Promise<void> {
    const room = new Room({ adaptiveStream: false, dynacast: false });
    this.room = room;
    room.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind !== Track.Kind.Audio) return;
      const el = track.attach();
      el.style.display = 'none';
      document.body.appendChild(el);
      this.els.push(el);
    });
    room.on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      track.detach().forEach((el) => el.remove());
    });
    room.on(RoomEvent.Disconnected, onDisconnected);
    await room.connect(url, token, { autoSubscribe: true });
    await room.localParticipant.setMicrophoneEnabled(true);
    await room.startAudio().catch(() => undefined);
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
    this.els.forEach((el) => el.remove());
    this.els = [];
    if (isNative) await YoursNative.audioSetSpeaker({ on: false }).catch(() => undefined);
    await room?.disconnect().catch(() => undefined);
  }
}

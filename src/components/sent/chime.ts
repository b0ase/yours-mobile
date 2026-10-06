/**
 * Coin chime for the Sent! screen, synthesized with Web Audio (no sample files, nothing copyrighted):
 * two quick bell tones, "cha-ching", about 0.7 s.
 *
 * iOS: the audio session is set to "ambient" where WebKit supports it, so the ringer/silent switch
 * mutes the chime. WebViews need the context unlocked by a tap, so `primeChime` runs on the first
 * pointerdown of the session (SentHost); the chime itself plays after the broadcast returns.
 */
type Ctx = AudioContext;
let ctx: Ctx | null = null;

const audioCtx = (): Ctx | null => {
  if (ctx) return ctx;
  try {
    const nav = navigator as Navigator & { audioSession?: { type: string } };
    if (nav.audioSession) nav.audioSession.type = 'ambient';
  } catch {
    // not supported
  }
  const AC =
    typeof window !== 'undefined'
      ? window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      : undefined;
  if (!AC) return null;
  try {
    ctx = new AC();
  } catch {
    ctx = null;
  }
  return ctx;
};

/** Create/resume the context inside a user gesture so a later chime is allowed to play. */
export const primeChime = () => {
  const c = audioCtx();
  if (c && c.state === 'suspended') void c.resume().catch(() => undefined);
};

const bell = (c: Ctx, at: number, freq: number, level: number) => {
  // Fundamental plus an inharmonic partial gives the metallic "coin" ring.
  for (const [mult, gainMul] of [
    [1, 1],
    [2.76, 0.35],
    [5.4, 0.12],
  ] as const) {
    const osc = c.createOscillator();
    const g = c.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq * mult, at);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(level * gainMul, at + 0.006);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.55);
    osc.connect(g).connect(c.destination);
    osc.start(at);
    osc.stop(at + 0.6);
  }
};

export const playChime = () => {
  const c = audioCtx();
  if (!c) return;
  const go = () => {
    const t = c.currentTime + 0.02;
    bell(c, t, 1318.5, 0.18); // E6
    bell(c, t + 0.11, 1975.5, 0.22); // B6
  };
  if (c.state === 'suspended') void c.resume().then(go, () => undefined);
  else go();
};

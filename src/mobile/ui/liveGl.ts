/**
 * WebGL contexts the app has open right now (ui/obsidianPool.ts registers its own). An account switch drops them all
 * before its reload (account/accountSwitch.ts releaseGraphics), so WebKit isn't tearing down a running GPU context
 * while loading the next page (owner, 13 Nov 2026: black screens after switching from Ask b).
 */
export const liveGl = new Set<WebGLRenderingContext>();

/** Lose every registered context. Best effort: one that is already lost is skipped. */
export const loseAllGl = (set: Set<WebGLRenderingContext> = liveGl) => {
  for (const gl of [...set]) {
    try {
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      /* already lost */
    }
    set.delete(gl);
  }
};

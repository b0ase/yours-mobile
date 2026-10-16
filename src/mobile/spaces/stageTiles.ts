/**
 * Which video tiles a Space shows. Pure: no React, no LiveKit.
 *
 * Every subscribed video gets a tile, keyed by kind + LiveKit identity, so two people sharing
 * screens (or a camera whose owner is not in the stage list yet) never hide each other. Mirrors
 * bit-sign's stageTiles() (#281): the lead tile first, the others in a grid labelled by handle.
 */

/** bit-sign's screen-device identity suffix: `alice.screen` is alice's laptop. */
export const SCREEN_SUFFIX = '.screen';

/** LiveKit identity → the handle form the stage list uses (no $, lower case). */
export const normIdentity = (id: string) => id.trim().replace(/^\$/, '').toLowerCase();

export const ownerOfIdentity = (id: string) => {
  const n = normIdentity(id);
  return n.endsWith(SCREEN_SUFFIX) ? n.slice(0, -SCREEN_SUFFIX.length) : n;
};

export interface ScreenFeed {
  /** Stable React key and SpaceMedia.bindScreen key: `screen:<identity>`. */
  key: string;
  /** Publishing identity (normalised). */
  id: string;
  /** Owner handle (`alice` for `alice.screen`). */
  owner: string;
  /** My own broadcast. */
  mine: boolean;
  /** Tile caption: `$alice · screen`. */
  label: string;
}

export const screenKey = (id: string) => `screen:${normIdentity(id)}`;

/**
 * Order the live screen shares: my own broadcast leads (the host sees what the room sees), then
 * the newest share, then the rest newest first. `ids` is in arrival order.
 */
export const screenFeeds = (ids: readonly string[], me: string, mineLive: boolean): ScreenFeed[] => {
  const meN = normIdentity(me);
  const seen = new Set<string>();
  const order = [...(mineLive ? [meN] : []), ...[...ids].map(normIdentity).reverse()];
  const out: ScreenFeed[] = [];
  for (const id of order) {
    if (seen.has(id)) continue;
    seen.add(id);
    const owner = ownerOfIdentity(id);
    out.push({ key: screenKey(id), id, owner, mine: mineLive && id === meN, label: `$${owner} · screen` });
  }
  return out;
};

/** Live cameras whose owner has no stage tile (stage list lagging, or a second device). */
export const offStageCameras = (videos: readonly string[], stage: readonly string[]): string[] => {
  const on = new Set(stage.map(normIdentity));
  return [...new Set(videos.map(normIdentity))].filter((h) => !on.has(h));
};

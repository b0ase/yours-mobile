import type { BchatClient } from '../chat/api';
import { blockLocal, mergeBlocks, unblockLocal } from './ugc';

/** Pull the server's block list into the local one (blocks made on another device). Best effort. */
export const syncBlocks = async (client: BchatClient) => {
  try {
    mergeBlocks(await client.blocks());
  } catch {
    /* older server or offline: local blocks still apply */
  }
};

/** Block / unblock $handle: hidden here at once, and the server stops DMs both ways. */
export const setBlocked = async (client: BchatClient | null, handle: string, block: boolean) => {
  if (block) blockLocal(handle);
  else unblockLocal(handle);
  if (!client) return;
  try {
    if (block) await client.block(handle);
    else await client.unblock(handle);
  } catch {
    /* kept locally; the server copy is re-sent next time they block/unblock */
  }
};

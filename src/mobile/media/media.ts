import type { WalletOutput } from '@bsv/sdk';
import { getTagValue } from '../../utils/format';

export type MediaKind = 'music' | 'video' | 'images' | 'other';

/** Fungible token inscriptions and wallet tags are not media (they live in Wallet). */
export const isMediaOutput = (o: WalletOutput) => {
  const type = getTagValue(o.tags, 'type');
  return type !== 'application/bsv-20' && type !== 'panda/tag' && type !== 'yours/tag';
};

export const kindOf = (contentType: string | undefined): MediaKind => {
  const t = (contentType ?? '').toLowerCase();
  if (t.startsWith('audio/')) return 'music';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('image/')) return 'images';
  return 'other';
};

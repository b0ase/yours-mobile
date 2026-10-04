import { useEffect, useState } from 'react';
import { parseRoom, roomMeta } from '../market/indexer';
import { thumbUrl } from '../market/thumbs';

/**
 * Image URL for a token's icon as 1Sat stores it: a full URL or data: URI as is; an inscription
 * outpoint (txid_vout / txid.vout) as a resized thumbnail; "_n" meaning output n of the token's own
 * deploy transaction.
 */
export const tokenIconUrl = (tokenId: string, icon: string | null | undefined, px = 96): string | null => {
  if (!icon) return null;
  if (/^(data:|https?:)/.test(icon)) return icon;
  const outpoint = icon.startsWith('_') ? `${tokenId.split(/[._]/)[0]}${icon}` : icon;
  return thumbUrl(outpoint, px);
};

/** The icon for a room key ("bsv21:<id>" or "coll:<id>"), from the room's token or collection. */
export const useRoomIcon = (key: string | null | undefined): string | null => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    setUrl(null);
    if (!key) return;
    const i = key.indexOf(':');
    const ref = i > 0 ? parseRoom(key.slice(0, i), key.slice(i + 1)) : null;
    if (!ref) return;
    let alive = true;
    roomMeta(ref.kind, ref.id)
      .then((m) => alive && setUrl(tokenIconUrl(ref.id, m?.icon)))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [key]);
  return url;
};

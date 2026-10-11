import { useMemo, useState } from 'react';
import { defaultPictures } from '../chat/roomArt';

/** A person's picture on Desktop: their photo, else their gold bAvatar (gold by default, never a letter). */
export const PersonPic = ({ handle, className }: { handle: string; className: string }) => {
  const candidates = useMemo(() => defaultPictures(handle, handle), [handle]);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const src = candidates.find((u) => !failed.has(u)) ?? candidates[candidates.length - 1];
  return (
    <img
      className={className}
      src={src}
      alt=""
      referrerPolicy="no-referrer"
      style={{ objectFit: 'cover' }}
      onError={() => setFailed((cur) => (cur.has(src) ? cur : new Set(cur).add(src)))}
    />
  );
};

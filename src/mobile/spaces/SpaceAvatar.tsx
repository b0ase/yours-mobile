import { useMemo, useState } from 'react';
import { Radio } from 'lucide-react';
import type { ChatRoom } from '../chat/messages';
import { defaultPictures } from '../chat/roomArt';

/** A room's own picture (metadata.icon, https only), else the issuer's photo or gold bAvatar (roomArt.ts). */
const picturesFor = (room: ChatRoom, title: string): string[] => {
  const icon = (room.metadata as { icon?: unknown } | null | undefined)?.icon;
  const own = typeof icon === 'string' && /^https:\/\//.test(icon) ? [icon] : [];
  return [...own, ...defaultPictures(title, room.created_by_handle)];
};

/** Each Spaces row's picture (owner, 11 Oct 2026). A live Space gets a red ring and a small live badge. */
export const SpaceAvatar = ({ room, title, live = false }: { room: ChatRoom; title: string; live?: boolean }) => {
  const candidates = useMemo(() => picturesFor(room, title), [room, title]);
  const [failed, setFailed] = useState<Set<string>>(() => new Set());
  const src = candidates.find((u) => !failed.has(u)) ?? candidates[candidates.length - 1];
  return (
    <span className="relative shrink-0" style={{ width: 44, height: 44 }}>
      <img
        src={src}
        alt=""
        onError={() => setFailed((cur) => (cur.has(src) ? cur : new Set(cur).add(src)))}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className="h-11 w-11 rounded-full object-cover"
        style={{ background: '#16181c', boxShadow: live ? '0 0 0 2px #D92D20' : undefined }}
      />
      {live && (
        <span
          className="absolute -bottom-0.5 -right-0.5 h-5 w-5 rounded-full flex items-center justify-center"
          style={{ background: '#D92D20', border: '2px solid #010101' }}
        >
          <Radio size={10} color="#fff" />
        </span>
      )}
    </span>
  );
};

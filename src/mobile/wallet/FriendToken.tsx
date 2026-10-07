import { useEffect, useState } from 'react';
import type { Bsv21Balance } from '@1sat/actions';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { isNative } from '../native';
import { BchatClient, defaultHttp, loadSession } from '../chat/api';
import { requestChatRoom, requestMarketToken } from '../chat/nav';
import { MARKET_ENABLED } from '../storeBuild';
import { tokenKey } from '../chat/tokenRooms';
import { normId, personalKey, personalTicker } from '../names/personalToken';
import type { Contact } from '../chat/contacts';
import { verifyIssuer } from '../issuer/issuerVerify';

/** name → their personal token id (bit-sign's link: the one real $NAME, not a copycat ticker). */
const lookups = new Map<string, Promise<string | null>>();
const personalTokenOf = (name: string): Promise<string | null> => {
  let p = lookups.get(name);
  if (!p) {
    const client = new BchatClient(defaultHttp(isNative), loadSession());
    p = client
      .personalToken(name)
      .then((r) => normId(r.tokenId))
      .catch(() => null);
    lookups.set(name, p);
  }
  return p;
};

/** The names a contact may have minted under: b0asex.x@bwalletx.com → b0asex.x, then b0asex. */
const namesFor = (c: Contact) => {
  const raw = c.paymail?.split('@')[0] || c.handle || '';
  const k = personalKey(raw);
  return k ? [...new Set([k, k.replace(/\.(x|gmail)$/, '')])] : [];
};

/**
 * Wallet › Friends: a friend's personal token, if they have one. Shows how many you hold and opens
 * its room (Chat) or, if you hold none, its Market page (Buy).
 */
export const FriendToken = ({ c, held }: { c: Contact; held: Bsv21Balance[] }) => {
  const { handleSelect } = useBottomMenu();
  const [tokenId, setTokenId] = useState<string | null>(null);
  const names = namesFor(c);
  useEffect(() => {
    let live = true;
    (async () => {
      // bChat's link (needs a bChat session) …
      if (loadSession())
        for (const n of names) {
          const id = await personalTokenOf(n);
          if (id) return live && setTokenId(id);
        }
      // … else a held token with their ticker whose signed issuer statement is theirs.
      const alias = (c.paymail?.split('@')[0] || '').toLowerCase();
      const tick = personalTicker(names[0] ?? '');
      for (const t of held.filter((h) => tick && (h.sym || '').toUpperCase() === tick)) {
        const i = await verifyIssuer(t.id).catch(() => null);
        const theirs = i?.status === 'verified' && i.paymail?.split('@')[0].toLowerCase() === alias;
        if (alias && theirs) return live && setTokenId(normId(t.id));
      }
    })();
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [names.join('|'), held.length]);
  if (!tokenId) return null;
  const mine = held.find((t) => normId(t.id) === tokenId);
  const ticker = mine?.sym || personalTicker(names[0] ?? '') || 'TOKEN';
  const amount = mine ? Number(mine.all.confirmed) / 10 ** (mine.dec || 0) : 0;
  const btn = 'text-[11px] font-semibold rounded-md px-2 py-0.5 border-0 cursor-pointer';
  return (
    <div className="flex items-center gap-2 mt-1.5 text-[11px]">
      <span className="font-bold" style={{ color: '#F5B800' }}>
        ${ticker}
      </span>
      <span style={{ color: '#98A2B3' }}>{mine ? `you hold ${amount.toLocaleString()}` : "you don't hold any"}</span>
      {mine ? (
        <button
          type="button"
          className={btn}
          style={{ background: '#F5B80022', color: '#F5B800' }}
          onClick={() => {
            const key = tokenKey('bsv21', tokenId);
            if (key) requestChatRoom(key);
            handleSelect(asMenuItem('chat'));
          }}
        >
          Room
        </button>
      ) : !MARKET_ENABLED ? null : (
        <button
          type="button"
          className={btn}
          style={{ background: '#F5B80022', color: '#F5B800' }}
          onClick={() => {
            requestMarketToken({ kind: 'bsv21', id: tokenId });
            handleSelect(asMenuItem('market'));
          }}
        >
          Buy
        </button>
      )}
    </div>
  );
};

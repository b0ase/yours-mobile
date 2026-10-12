import { useMemo } from 'react';
import { useWalletMedia } from '../media/useWalletMedia';
import { thumbUrl } from '../market/thumbs';
import { isCardNftType } from './cardFrontArt';

/**
 * Card designer › My NFTs (owner, 12 Oct 2026): the account's picture NFTs, from the same list as Wallet › NFTs
 * (useWalletMedia / listOrdinals), shown as resized thumbnails and paged with "Load more". Only raster images; NFTs
 * the Market filter would block are left out here. Tapping one hands its ORDFS content URL to the designer.
 */
export function CardNftGrid({
  selected,
  busy,
  onPick,
}: {
  selected: string | null;
  busy: string | null;
  onPick: (outpoint: string, url: string) => void;
}) {
  const { items, hasMore, loading, error, loadMore } = useWalletMedia();
  const pics = useMemo(() => items.filter((i) => i.kind === 'images' && isCardNftType(i.type) && !i.flagged), [items]);
  return (
    <div className="bw-cdes-nfts">
      {pics.length > 0 && (
        <div className="bw-cdes-lib" aria-label="My NFTs">
          {pics.map((i) => {
            const op = i.output.outpoint;
            return (
              <div key={op} className={`bw-cdes-libitem${selected === op ? ' is-on' : ''}`}>
                <button
                  type="button"
                  className="bw-cdes-libpic"
                  aria-label={`Put ${i.name} on the card`}
                  aria-pressed={selected === op}
                  aria-busy={busy === op}
                  disabled={!!busy}
                  onClick={() => onPick(op, i.url)}
                >
                  <img
                    src={thumbUrl(op) ?? i.url}
                    alt=""
                    loading="lazy"
                    draggable={false}
                    onError={(e) => {
                      if (e.currentTarget.src !== i.url) e.currentTarget.src = i.url;
                    }}
                  />
                  {busy === op && <span className="bw-cdes-libbusy" aria-hidden="true" />}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {error && (
        <p className="bw-cdes-imgerr" role="alert">
          {error}
        </p>
      )}
      {!loading && !error && !pics.length && !hasMore && (
        <p className="bw-cdes-empty">No picture NFTs in this wallet yet.</p>
      )}
      {loading && <p className="bw-cdes-empty">Loading your NFTs…</p>}
      {hasMore && !loading && (
        <button type="button" className="bw-cdes-artback" onClick={() => void loadMore()}>
          Load more
        </button>
      )}
    </div>
  );
}

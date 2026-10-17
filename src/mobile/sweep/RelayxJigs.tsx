import { useEffect, useState } from 'react';
import { Transaction } from '@bsv/sdk';
import { identifyJig, loadNpgMaps, NPG_CUTOUT_INDEX, type IdentifiedJig } from '../../sweep/runIdentify';
import { mapLimit } from './speed';

/**
 * RelayX NFT Collection Importer, phase a (owner, 17 Oct 2026): the Run NFTs found at the swept wallet's
 * addresses, read-only. Each jig is walked back to its mint (sweep/runIdentify.ts) and named from the NPG maps
 * ("NPG #0417" with her cut-out) or its class. Nothing is moved: bringing them into bWalletX waits on the
 * owner's choice of scheme.
 */
type Held = { outpoint: string; address: string };
type BBox = Record<string, [number, number, number, number]>;

const THUMB = 56;
const PANEL = 'rgb(255 255 255 / 0.04)';

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** The girl only: crop the 961x1441 cut-out to her bounding box, centred in a square thumbnail. */
function Cutout({ url, box }: { url: string; box?: [number, number, number, number] }) {
  const [x0, y0, x1, y1] = box ?? [0, 0, 961, 1441];
  const scale = THUMB / Math.max(x1 - x0, y1 - y0);
  const dx = (THUMB - (x1 - x0) * scale) / 2;
  const dy = (THUMB - (y1 - y0) * scale) / 2;
  return (
    <div
      aria-hidden="true"
      className="shrink-0 rounded-xl"
      style={{
        width: THUMB,
        height: THUMB,
        background: `#12060D url("${url}") no-repeat`,
        backgroundSize: `${961 * scale}px ${1441 * scale}px`,
        backgroundPosition: `${dx - x0 * scale}px ${dy - y0 * scale}px`,
      }}
    />
  );
}

export function RelayxJigs({ held, getHex }: { held: Held[]; getHex: (txid: string) => Promise<string> }) {
  const [found, setFound] = useState<(IdentifiedJig & { address: string })[] | null>(null);
  const [bbox, setBbox] = useState<BBox>({});
  const [done, setDone] = useState(0);
  const key = held.map((h) => h.outpoint).join();

  useEffect(() => {
    let live = true;
    const txs = new Map<string, Promise<Transaction>>();
    const getTx = (txid: string) => {
      if (!txs.has(txid))
        txs.set(
          txid,
          getHex(txid).then((h) => Transaction.fromHex(h)),
        );
      return txs.get(txid)!;
    };
    void (async () => {
      const [maps, index] = await Promise.all([
        loadNpgMaps(),
        fetch(NPG_CUTOUT_INDEX)
          .then((r) => (r.ok ? r.json() : null))
          .catch(() => null),
      ]);
      if (live && index?.bbox) setBbox(index.bbox as BBox);
      const out = await mapLimit(held, 3, async (h) => {
        const j = await identifyJig(h.outpoint, getTx, maps);
        if (live) setDone((d) => d + 1);
        return { ...j, address: h.address };
      });
      if (live) setFound(out.sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9) || a.title.localeCompare(b.title)));
    })();
    return () => {
      live = false;
    };
    // held is identified once per scan result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  if (!held.length) return null;
  return (
    <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: 'rgb(37 99 235 / 0.14)' }}>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-bold text-white">RelayX NFT Collection Importer</span>
        <span className="text-[11px]" style={{ color: '#B6C8F5' }}>
          {found
            ? `${found.length} NFT${found.length === 1 ? '' : 's'} found. Read-only: nothing is moved.`
            : `Reading your RelayX NFTs: ${done} of ${held.length}`}
        </span>
      </div>
      {found?.map((j) => (
        <div
          key={j.location}
          className="flex items-center gap-3 rounded-xl p-2"
          style={{ background: PANEL }}
          title={j.origin ? `Minted at ${j.origin}` : undefined}
        >
          {j.art ? (
            <Cutout url={j.art} box={j.n !== undefined ? bbox[String(j.n).padStart(4, '0')] : undefined} />
          ) : (
            <div
              aria-hidden="true"
              className="shrink-0 rounded-xl flex items-center justify-center text-[10px] font-bold"
              style={{ width: THUMB, height: THUMB, background: '#12060D', color: '#FF2E93' }}
            >
              NPG
            </div>
          )}
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-semibold text-white truncate">{j.title}</span>
            <span className="text-[11px] truncate" style={{ color: '#B6C8F5' }}>
              {j.collection}
            </span>
            <span className="text-[11px]" style={{ color: '#8A94A6' }}>
              Held at {short(j.address)}
            </span>
          </div>
        </div>
      ))}
      {found && (
        <p className="m-0 text-[11px]" style={{ color: '#B6C8F5' }}>
          Bring into bWalletX: coming soon. They stay safe where they are until then.
        </p>
      )}
    </div>
  );
}

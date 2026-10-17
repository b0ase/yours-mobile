import { useEffect, useState } from 'react';
import { Transaction } from '@bsv/sdk';
import { identifyJig, loadNpgMaps, NPG_CUTOUT_INDEX, type IdentifiedJig } from '../../sweep/runIdentify';
import { mapLimit } from './speed';
import { NpgMelt } from './NpgMelt';

/**
 * RelayX NFT Collection Importer, phase a (owner, 17 Oct 2026): the Run NFTs found at the swept wallet's
 * addresses, read-only. Each jig is walked back to its mint (sweep/runIdentify.ts) and named from the NPG maps
 * ("NPG #0417" with her cut-out) or its class. Nothing is moved: bringing them into bWalletX waits on the
 * owner's choice of scheme.
 */
/** wif: the RelayX key holding it, kept in memory for this sweep session only (melt signs with it, NpgMelt). */
type Held = { outpoint: string; address: string; wif?: string };
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

/** WhatsOnChain rate-limits long scans; its 429 replies carry no CORS header, so iPhone reports "Load failed"
 *  (a TypeError). Retry those and 429/5xx-shaped failures with backoff: 1.5 s, 3 s, 6 s … up to 6 tries. */
async function withRetry<T>(fn: () => Promise<T>, tries = 6): Promise<T> {
  for (let a = 0; ; a++) {
    try {
      return await fn();
    } catch (e) {
      const transient = e instanceof TypeError || /429|Too Many|5\d\d|rate/i.test(String((e as Error)?.message ?? e));
      if (!transient || a >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500 * 2 ** a));
    }
  }
}

export function RelayxJigs({ held, getHex }: { held: Held[]; getHex: (txid: string) => Promise<string> }) {
  const [found, setFound] = useState<(IdentifiedJig & { address: string; wif?: string })[] | null>(null);
  const [bbox, setBbox] = useState<BBox>({});
  const [done, setDone] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const key = held.map((h) => h.outpoint).join();

  useEffect(() => {
    let live = true;
    const txs = new Map<string, Promise<Transaction>>();
    const getTx = (txid: string) => {
      if (!txs.has(txid))
        txs.set(
          txid,
          withRetry(() => getHex(txid)).then((h) => Transaction.fromHex(h)),
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
      // One unreadable NFT must not stop the rest (owner 17 Oct 2026: a single failed lookup showed a bare
      // "Load failed" and the importer gave up). It shows as unread with a Retry instead.
      const out = await mapLimit(held, 3, async (h) => {
        try {
          const j = await identifyJig(h.outpoint, getTx, maps);
          return { ...j, address: h.address, wif: h.wif };
        } catch {
          return {
            location: h.outpoint,
            title: "Couldn't read this one",
            unread: true,
            address: h.address,
            wif: h.wif,
          } as unknown as IdentifiedJig & { address: string; wif?: string };
        } finally {
          if (live) setDone((d) => d + 1);
        }
      });
      if (live) setFound(out.sort((a, b) => (a.n ?? 1e9) - (b.n ?? 1e9) || a.title.localeCompare(b.title)));
    })();
    return () => {
      live = false;
    };
    // held is identified once per scan result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, attempt]);

  if (!held.length) return null;
  return (
    <div className="rounded-2xl p-4 flex flex-col gap-3" style={{ background: 'rgb(37 99 235 / 0.14)' }}>
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-bold text-white">RelayX NFT Collection Importer</span>
        <span className="text-[11px]" style={{ color: '#B6C8F5' }}>
          {found
            ? `${found.length} NFT${found.length === 1 ? '' : 's'} found. Nothing moves unless you melt one.`
            : `Reading your RelayX NFTs: ${done} of ${held.length}`}
        </span>
        {found?.some((j) => (j as { unread?: boolean }).unread) && (
          <button
            type="button"
            onClick={() => {
              setFound(null);
              setDone(0);
              setAttempt((a) => a + 1);
            }}
            className="self-start mt-1 rounded-lg border-0 px-3 py-1.5 text-xs font-semibold cursor-pointer"
            style={{ background: '#2E6BFF', color: '#fff' }}
          >
            Retry the {found.filter((j) => (j as { unread?: boolean }).unread).length} unread
          </button>
        )}
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
          {/* Melt only what the NPG maps identify (owner 17 Oct 2026); everything else stays read-only. */}
          {j.n !== undefined && j.wif && (
            <span className="ml-auto">
              <NpgMelt jig={j} wif={j.wif} art={j.art} />
            </span>
          )}
        </div>
      ))}
      {found && (
        <p className="m-0 text-[11px]" style={{ color: '#B6C8F5' }}>
          NPGs can be melted into element cards for the NPG games. Bringing other NFTs into bWalletX: coming soon. They
          stay safe where they are until then.
        </p>
      )}
    </div>
  );
}

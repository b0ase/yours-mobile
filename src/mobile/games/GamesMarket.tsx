import { useMemo } from 'react';
import { Gamepad2 } from 'lucide-react';
import { openDappBrowser } from '../dappBrowser';
import { useRegistry } from '../exchange/registry/useRegistry';
import type { HotRoom } from '../market/indexer';
import { OUR_GAMES } from './games';

const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';
const ticker = (t: string) => t.replace(/^\$/, '').toLowerCase();

/**
 * Exchange › Games (owner, 17 Oct 2026): our games as cards that open in the in-app browser (games.ts), then the
 * game tokens, i.e. every token on the board the Exchange registry files under the 'games' category.
 */
export const GamesMarket = ({ tokens, onOpenToken }: { tokens: HotRoom[]; onOpenToken: (r: HotRoom) => void }) => {
  const registry = useRegistry();
  const gameTokens = useMemo(
    () =>
      registry
        ? tokens.filter((r) => !registry.hidden.has(r.ref.id) && registry.labels(r.ref.id).category === 'games')
        : [],
    [tokens, registry],
  );
  const byTicker = useMemo(() => {
    const m = new Map<string, HotRoom>();
    for (const r of tokens) if (!m.has(ticker(r.title))) m.set(ticker(r.title), r);
    return m;
  }, [tokens]);

  return (
    <section className="flex flex-col gap-3">
      {OUR_GAMES.length > 0 && (
        <div className="grid grid-cols-2 gap-2">
          {OUR_GAMES.map((g) => {
            const tok = g.token ? byTicker.get(ticker(g.token)) : undefined;
            return (
              <div key={g.url} className="flex flex-col gap-1.5 rounded-xl bg-[var(--bw-surface)] p-3">
                <button
                  type="button"
                  onClick={() => void openDappBrowser(g.url)}
                  className="flex flex-col gap-1 border-0 bg-transparent p-0 text-left"
                >
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-[var(--bw-text)]">
                    <Gamepad2 size={14} style={{ color: 'var(--bw-accent)' }} className="shrink-0" />
                    <span className={ELLIPSIS}>{g.title}</span>
                  </span>
                  <span className="text-[10px] uppercase tracking-wide text-[var(--bw-muted)]">{g.kind}</span>
                  <span className="text-[11px] leading-snug text-[var(--bw-muted)]">{g.blurb}</span>
                </button>
                {g.token && (
                  <button
                    type="button"
                    disabled={!tok}
                    onClick={() => tok && onOpenToken(tok)}
                    className="self-start rounded-full border-0 px-2 py-0.5 text-[11px] font-semibold"
                    style={{
                      background: 'rgba(var(--bw-accent-rgb), 0.15)',
                      color: 'var(--bw-accent)',
                      opacity: tok ? 1 : 0.6,
                    }}
                  >
                    {g.token}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
      <h2 className="m-0 text-xs font-semibold uppercase tracking-wide text-[var(--bw-muted)]">Game tokens</h2>
      {!registry ? (
        <p className="py-6 text-center text-xs text-[var(--bw-muted)]">Loading game tokens…</p>
      ) : gameTokens.length === 0 ? (
        <p className="py-6 text-center text-xs text-[var(--bw-muted)]">No game tokens on the board yet.</p>
      ) : (
        gameTokens.map((r) => (
          <button
            key={r.ref.key}
            type="button"
            onClick={() => onOpenToken(r)}
            className="flex items-center gap-3 rounded-xl border-0 bg-[var(--bw-surface)] px-3 py-3 text-left"
          >
            <div className="min-w-0 flex-1">
              <div className={`text-sm font-semibold text-[var(--bw-text)] ${ELLIPSIS}`}>{r.title}</div>
              <div className={`text-[11px] text-[var(--bw-muted)] ${ELLIPSIS}`}>{r.subtitle || 'Game token'}</div>
            </div>
            <div className="shrink-0 text-right">
              <div className="text-[10px] text-[var(--bw-muted)]">Floor</div>
              <div className="text-xs font-semibold" style={{ color: 'var(--bw-accent)' }}>
                {r.floorLabel ?? '—'}
              </div>
            </div>
          </button>
        ))
      )}
    </section>
  );
};

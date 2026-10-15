/**
 * Token detail "who is this": the full token id (short, with copy), deploy date, deployer, holders,
 * links to 1sat.market and the deploy tx on WhatsOnChain, and, when other tokens use the same ticker,
 * an "N tokens use $X" warning with a picker keyed on id. Owner, 15 Oct 2026: users couldn't tell the
 * real $SCAM from a copycat with the same ticker.
 */
import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, TriangleAlert } from 'lucide-react';
import { openDappBrowser } from '../dappBrowser';
import {
  collisionLabel,
  deployDateLabel,
  isHttpsUrl,
  shortAddress,
  shortTokenId,
  tokenFacts,
  tokenOutsideLinks,
  tokensWithTicker,
  type TokenFacts,
} from './tokenIdentity';

const MUTED = '#98A2B3';
const AMBER = '#e0a030';

const openOutside = (url: string) => {
  if (isHttpsUrl(url)) void openDappBrowser(url);
};

export const TokenIdentity = ({
  tokenId,
  ticker,
  onPick,
}: {
  tokenId: string;
  ticker: string | null | undefined;
  /** Open another token (by id) from the collision picker. */
  onPick: (id: string) => void;
}) => {
  const [facts, setFacts] = useState<TokenFacts | null>(null);
  const [same, setSame] = useState<TokenFacts[] | null>(null);
  const [copied, setCopied] = useState(false);
  const [picker, setPicker] = useState(false);
  useEffect(() => {
    let live = true;
    setFacts(null);
    setSame(null);
    setPicker(false);
    void tokenFacts(tokenId).then((f) => live && setFacts(f));
    if (ticker)
      void tokensWithTicker(ticker, tokenId)
        .then((s) => live && setSame(s))
        .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [tokenId, ticker]);

  const links = tokenOutsideLinks(tokenId);
  const copy = () => {
    void navigator.clipboard?.writeText(tokenId).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const date = deployDateLabel(facts?.deployedAt);
  const warn = ticker && same ? collisionLabel(ticker, same.length) : null;

  return (
    <div className="flex flex-col gap-1.5" data-testid="token-identity">
      {warn && (
        <div className="rounded-xl px-3 py-2 border" style={{ background: '#1d1606', borderColor: '#3a2f0c' }}>
          <button
            type="button"
            onClick={() => setPicker((v) => !v)}
            aria-expanded={picker}
            className="flex w-full items-center gap-1.5 text-left text-xs font-semibold bg-transparent border-0 p-0 cursor-pointer"
            style={{ color: AMBER }}
          >
            <TriangleAlert size={13} aria-hidden />
            <span className="flex-1">{warn}. Check the token ID before you buy.</span>
            <span className="text-[11px]">{picker ? 'Hide' : 'Compare'}</span>
          </button>
          {picker && (
            <ul className="mt-2 flex flex-col gap-1 list-none p-0 m-0" aria-label="Tokens with this ticker">
              {same!.map((t) => {
                const here = t.id === tokenId.toLowerCase().replace('.', '_');
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      disabled={here}
                      onClick={() => onPick(t.id)}
                      className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[11px] border cursor-pointer disabled:cursor-default"
                      style={{ background: here ? '#2a2208' : '#0F1013', borderColor: here ? '#3a2f0c' : '#2b2f36' }}
                    >
                      <span className="font-mono text-white flex-1 min-w-0 truncate">{shortTokenId(t.id)}</span>
                      <span style={{ color: MUTED }}>
                        {t.holders === null ? '? holders' : `${t.holders.toLocaleString('en-US')} holders`}
                      </span>
                      <span style={{ color: MUTED }}>{deployDateLabel(t.deployedAt) ?? '—'}</span>
                      {here && <span style={{ color: 'var(--bw-accent-hi)' }}>this one</span>}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 text-[11px]" style={{ color: MUTED }}>
        <span>Token ID</span>
        <span className="font-mono text-white" title={tokenId}>
          {shortTokenId(tokenId)}
        </span>
        <button
          type="button"
          onClick={copy}
          aria-label="Copy token ID"
          className="grid place-items-center w-6 h-6 rounded-md bg-transparent border-0 cursor-pointer"
          style={{ color: copied ? '#A1FF8B' : MUTED }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      {(date || facts?.deployer || facts?.contract || facts?.holders != null) && (
        <div className="text-[11px] break-all" style={{ color: MUTED }}>
          {[
            date && `Deployed ${date}`,
            facts?.deployer
              ? `by ${shortAddress(facts.deployer)}`
              : facts?.contract
                ? `as a ${facts.contract} contract`
                : null,
            facts?.holders != null && `${facts.holders.toLocaleString('en-US')} holders`,
          ]
            .filter(Boolean)
            .join(' · ')}
        </div>
      )}
      {links && (
        <div className="flex flex-wrap gap-1.5">
          {[
            ['1sat.market', links.market],
            ['Deploy tx', links.deployTx],
          ].map(([label, url]) => (
            <button
              key={label}
              type="button"
              onClick={() => openOutside(url)}
              title={url}
              className="flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-semibold cursor-pointer"
              style={{ background: '#0F1013', color: '#D0D5DD', border: '1px solid #2b2f36' }}
            >
              <ExternalLink size={11} aria-hidden /> {label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

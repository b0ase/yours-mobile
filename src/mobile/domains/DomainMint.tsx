import { useMemo, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useBottomMenu } from '../../hooks/useBottomMenu';
import { asMenuItem } from '../tabs/tabs';
import { CopyButton } from '../btrust/CopyButton';
import { ErrorActions } from '../errors/ErrorActions';
import { TokenMint } from '../tokens/TokenMint';
import { wocTxUrl } from '../mint/mint';
import {
  domainTokenDescription,
  domainMapScript,
  loadPending,
  lookupTxt,
  normaliseDomain,
  prefillDomain,
  registerDomain,
  removePending,
  savePending,
  startDomain,
  suggestDomainTicker,
  txtMatches,
  walletDomainSigner,
  type PendingListing,
  type StartResult,
} from './dnsdex';

/**
 * MINT → "A domain" (dnsdex.ts): get the dns-dex TXT record, add it at the registrar, check it, mint the token with
 * the normal token form (pre-filled), then list it on dns-dex.com. A failed listing never undoes the mint: it is kept
 * as pending (survives a reload) with Try again.
 */
const GOLD = 'var(--bw-accent-hi)';
const BORDER = '#3a2f0c';

type View =
  | { at: 'enter' }
  | { at: 'record'; rec: StartResult }
  | { at: 'mint'; rec: StartResult }
  | { at: 'list'; listing: PendingListing; url?: string };

export const DomainMint = ({
  exchangeRate,
  onBack,
  onClose,
  initialDomain,
}: {
  exchangeRate: number;
  onBack: () => void;
  onClose: () => void;
  /** From the /m/mint/domain?d= deep link: fills the field; the user still presses Get my DNS record. */
  initialDomain?: string;
}) => {
  const { apiContext } = useServiceContext();
  const { handleSelect } = useBottomMenu();
  const signer = useMemo(() => walletDomainSigner(apiContext), [apiContext]);
  const [prefill] = useState(() => prefillDomain(initialDomain));
  const [view, setView] = useState<View>({ at: 'enter' });
  const [domainInput, setDomainInput] = useState(prefill.value);
  const [pending, setPending] = useState<PendingListing[]>(() => loadPending());
  const [busy, setBusy] = useState('');
  const [error, setError] = useState(prefill.error);
  const [notYet, setNotYet] = useState(false);

  const input = 'w-full rounded-xl px-3 py-2 text-sm outline-none border bg-transparent';
  const inputStyle = { borderColor: BORDER, color: '#fff' };
  const primary = { background: `linear-gradient(135deg, #FFE27A, #E0A800)`, color: '#1a1400' };
  const secondary = { borderColor: BORDER, color: GOLD };

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Something went wrong. Try again.');
    } finally {
      setBusy('');
    }
  };

  const start = () => {
    const n = normaliseDomain(domainInput);
    if (!n.ok) return setError(n.error);
    void run('Getting your DNS record…', async () => {
      const rec = await startDomain(signer, n.domain);
      setNotYet(false);
      setView({ at: 'record', rec });
    });
  };

  const check = (rec: StartResult) =>
    run('Checking DNS…', async () => {
      const records = await lookupTxt(rec.txtHost);
      if (txtMatches(records, rec.txtValue)) {
        setNotYet(false);
        setView({ at: 'mint', rec });
      } else setNotYet(true);
    });

  const list = (listing: PendingListing) =>
    run('Listing on dns-dex.com…', async () => {
      const res = await registerDomain(signer, listing.domain, listing.tokenId);
      removePending(listing.domain);
      setPending(loadPending());
      setView({ at: 'list', listing, url: res.url });
    });

  const minted = (domain: string, tokenId: string) => {
    const listing = { domain, tokenId };
    savePending(listing);
    setPending(loadPending());
    setView({ at: 'list', listing });
    void list(listing);
  };

  const err = error ? (
    <div className="flex flex-col gap-1.5">
      <p className="m-0" style={{ color: '#ff6b6b' }}>
        {error}
      </p>
      <ErrorActions message={error} />
    </div>
  ) : null;
  const busyLine = busy ? (
    <p className="text-xs text-center m-0" style={{ color: GOLD }}>
      {busy}
    </p>
  ) : null;

  if (view.at === 'mint') {
    const { domain } = view.rec;
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-xs m-0" style={{ color: '#9ccc65' }}>
          ✓ {domain} is verified. Now set up its token.
        </p>
        <TokenMint
          exchangeRate={exchangeRate}
          onBack={() => setView({ at: 'record', rec: view.rec })}
          onClose={onClose}
          initial={{ name: domain, ticker: suggestDomainTicker(domain), description: domainTokenDescription(domain) }}
          map={{ script: domainMapScript(domain), description: 'bWallet domain token (MAP)' }}
          onMinted={(t) => minted(domain, t.tokenId)}
        />
      </div>
    );
  }

  if (view.at === 'list') {
    const { listing, url } = view;
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">The token for {listing.domain} is minted and in your wallet.</p>
        <a
          href={wocTxUrl(listing.tokenId.split('_')[0])}
          target="_blank"
          rel="noreferrer"
          className="flex items-center gap-1 break-all text-xs"
          style={{ color: GOLD }}
        >
          {listing.tokenId} <ExternalLink size={12} />
        </a>
        {url ? (
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 font-bold"
            style={{ color: '#9ccc65' }}
          >
            ✓ Listed on dns-dex.com <ExternalLink size={14} />
          </a>
        ) : busy ? null : (
          <>
            <p className="text-xs m-0" style={{ color: '#bbb' }}>
              It isn't listed on dns-dex.com yet. Your token is safe either way; listing just tells dns-dex about it.
            </p>
            <button
              type="button"
              onClick={() => void list(listing)}
              className="h-11 rounded-xl font-bold border-0 cursor-pointer"
              style={primary}
            >
              Try again
            </button>
          </>
        )}
        {err}
        {busyLine}
        <button
          type="button"
          onClick={() => {
            handleSelect(asMenuItem('bsv'));
            onClose();
          }}
          className="h-11 rounded-xl font-bold border cursor-pointer bg-transparent"
          style={secondary}
        >
          View in wallet
        </button>
      </div>
    );
  }

  if (view.at === 'record') {
    const { rec } = view;
    const host = rec.txtHost.slice(0, -(rec.domain.length + 1)) || rec.txtHost;
    return (
      <div className="flex flex-col gap-3 text-sm">
        <p className="m-0">
          Add this TXT record at your domain registrar or Cloudflare. It can take a few minutes to show up.
        </p>
        {rec.resumed && (
          <p className="text-xs m-0" style={{ color: '#bbb' }}>
            You started {rec.domain} before; this is the same record.
          </p>
        )}
        {[
          { label: 'Type', value: 'TXT', copy: false },
          { label: `Name / Host (some sites want just "${host}")`, value: rec.txtHost, copy: true },
          { label: 'Value', value: rec.txtValue, copy: true },
        ].map((row) => (
          <div key={row.label} className="flex flex-col gap-1">
            <span className="text-xs" style={{ color: '#999' }}>
              {row.label}
            </span>
            <div className="flex items-center gap-2">
              <code
                className="flex-1 min-w-0 break-all rounded-xl px-3 py-2 text-xs border"
                style={{ borderColor: BORDER, color: '#fff' }}
              >
                {row.value}
              </code>
              {row.copy && <CopyButton text={row.value} />}
            </div>
          </div>
        ))}
        {notYet && (
          <p className="text-xs m-0" style={{ color: GOLD }}>
            Not visible yet. DNS changes can take a few minutes, sometimes longer. Check again shortly.
          </p>
        )}
        {err}
        {busyLine}
        <button
          type="button"
          onClick={() => void check(rec)}
          disabled={!!busy}
          className="h-11 rounded-xl font-bold border-0 cursor-pointer"
          style={primary}
        >
          Check
        </button>
        <button
          type="button"
          onClick={() => setView({ at: 'enter' })}
          className="text-sm bg-transparent border-0 cursor-pointer"
          style={{ color: GOLD }}
        >
          Back
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3 text-sm">
      <p className="text-xs m-0" style={{ color: '#bbb' }}>
        Prove you own a domain, then mint its token in your wallet. dns-dex.com checks a DNS record you add and lists
        the token.
      </p>
      {pending.map((p) => (
        <div
          key={p.domain}
          className="flex items-center gap-2 rounded-xl border px-3 py-2"
          style={{ borderColor: BORDER }}
        >
          <span className="flex-1 text-xs">Finish listing {p.domain} on dns-dex.com</span>
          <button
            type="button"
            onClick={() => {
              setView({ at: 'list', listing: p });
              void list(p);
            }}
            disabled={!!busy}
            className="rounded-xl px-3 py-1.5 text-xs font-bold border cursor-pointer bg-transparent"
            style={secondary}
          >
            Try again
          </button>
        </div>
      ))}
      <label className="text-xs" style={{ color: '#999' }} htmlFor="domain-mint-input">
        Your domain
      </label>
      <input
        id="domain-mint-input"
        className={input}
        style={inputStyle}
        placeholder="example.com"
        value={domainInput}
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        inputMode="url"
        onChange={(e) => setDomainInput(e.target.value)}
        onKeyDown={(e) => e.key === 'Enter' && !busy && start()}
      />
      {err}
      {busyLine}
      <button
        type="button"
        onClick={start}
        disabled={!!busy}
        className="h-11 rounded-xl font-bold border-0 cursor-pointer"
        style={primary}
      >
        Get my DNS record
      </button>
      <button
        type="button"
        onClick={onBack}
        className="text-sm bg-transparent border-0 cursor-pointer"
        style={{ color: GOLD }}
      >
        Back
      </button>
    </div>
  );
};

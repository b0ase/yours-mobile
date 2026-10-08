import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { FileCode2, Loader2, Plus, X } from 'lucide-react';
import { useServiceContext } from '../../hooks/useServiceContext';
import { useSnackbar } from '../../hooks/useSnackbar';
import { fetchExchangeRate } from '../../utils/wallet';
import { marketFeeSats } from '../market/fee';
import {
  buyContract,
  claimContract,
  contractPriceSats,
  listContracts,
  ownedContractOutpoints,
  publishContract,
  type ContractListing,
} from './market';
import { CONTRACT_DISCLAIMER, contractEnvelope, contractSaleProblems, parseDescriptor } from './contractNft';

const GOLD = '#F5B800';
const MUTED = '#98A2B3';
const CARD = '#17191E';
const LINE = '#2b2f36';
const usd = (n: number) => (n === 0 ? 'Free' : `$${n.toFixed(n < 10 ? 2 : 0)}`);

const NetBadge = ({ net }: { net: string }) => (
  <span
    className="text-[9px] font-bold rounded px-1.5 py-0.5 shrink-0"
    style={{
      background: net === 'testnet' ? '#7A5AF822' : '#12B76A22',
      color: net === 'testnet' ? '#BDB4FE' : '#6CE9A6',
      letterSpacing: '0.05em',
    }}
  >
    {net.toUpperCase()}
  </span>
);

const Row = ({ k, v }: { k: string; v: string }) => (
  <div className="flex gap-2 text-xs">
    <span className="w-28 shrink-0" style={{ color: MUTED }}>
      {k}
    </span>
    <span className="break-all text-white">{v}</span>
  </div>
);

export type ContractsTab = 'all' | 'bonds';
const TABS: [ContractsTab, string][] = [
  ['all', 'All'],
  ['bonds', 'Bonds'],
];

/** Exchange › Contracts, with sub-tabs All / Bonds (Bonds was its own Exchange filter until 7 Oct 2026). bWalletX only. */
export const ContractsMarket = ({ tab = 'all', onTab }: { tab?: ContractsTab; onTab?: (t: ContractsTab) => void }) => {
  const filter = tab === 'bonds' ? 'bond' : undefined;
  const { apiContext, chromeStorageService } = useServiceContext();
  const { addSnackbar } = useSnackbar();
  const [items, setItems] = useState<ContractListing[] | null>(null);
  const [error, setError] = useState('');
  const [rate, setRate] = useState(0);
  const [open, setOpen] = useState<ContractListing | null>(null);
  const [owned, setOwned] = useState<string[]>([]);
  const [mine, setMine] = useState<Record<string, string>>({}); // copy outpoint → contract origin
  const [busy, setBusy] = useState('');
  const [publishing, setPublishing] = useState(false);

  const refresh = () => {
    listContracts().then(setItems, (e) => setError(e instanceof Error ? e.message : String(e)));
    if (apiContext) void ownedContractOutpoints(apiContext).then(setOwned, () => {});
  };
  useEffect(() => {
    refresh();
    fetchExchangeRate('main').then(setRate, () => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Which contract each held copy belongs to (the catalogue checks it on chain).
  useEffect(() => {
    if (!apiContext) return;
    for (const op of owned)
      if (!mine[op])
        void claimContract(apiContext, op).then(
          (r) => setMine((m) => ({ ...m, [op]: r.contract })),
          () => {},
        );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [owned.join()]);
  const ownedOrigins = new Set(Object.values(mine));

  const buy = async (c: ContractListing) => {
    if (!apiContext) return;
    setBusy(c.envelope.sale.priceUsd > 0 ? 'Buying…' : 'Getting…');
    try {
      await buyContract(apiContext, c.origin, rate);
      addSnackbar(`${c.envelope.contract.name} is in your wallet.`, 'success');
      refresh();
    } catch (e) {
      addSnackbar(e instanceof Error ? e.message : 'Purchase failed', 'error');
    } finally {
      setBusy('');
    }
  };

  const shown = (items ?? []).filter((c) => !filter || c.envelope.contract.name.toLowerCase().includes(filter));
  return (
    <section className="flex flex-col gap-3">
      <div className="flex gap-1 rounded-xl p-1" style={{ background: CARD }} role="tablist" aria-label="Contract kind">
        {TABS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={tab === id}
            onClick={() => onTab?.(id)}
            className="flex-1 rounded-lg py-1.5 text-xs font-semibold border-0"
            style={{ background: tab === id ? GOLD : 'transparent', color: tab === id ? '#010101' : MUTED }}
          >
            {label}
          </button>
        ))}
      </div>
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        {CONTRACT_DISCLAIMER}
      </p>
      {items === null && !error && (
        <p className="text-xs text-center py-8 m-0" style={{ color: MUTED }}>
          Loading contracts…
        </p>
      )}
      {error && (
        <p className="text-xs m-0" style={{ color: '#F97066' }}>
          {error}
        </p>
      )}
      {items !== null && shown.length === 0 && (
        <p className="text-xs text-center py-8 m-0" style={{ color: MUTED }}>
          {filter === 'bond'
            ? 'No bonds or notes listed yet. PNEEs, penny stablecoins backed by locked BSV, are being built and will appear here.'
            : 'No contracts published yet.'}
        </p>
      )}
      {shown.map((c) => {
        const e = c.envelope;
        const left = e.sale.copies - c.sold;
        return (
          <button
            key={c.origin}
            type="button"
            onClick={() => setOpen(c)}
            className="flex flex-col gap-1 rounded-xl px-3 py-3 text-left border-0"
            style={{ background: CARD }}
          >
            <div className="flex items-center gap-2">
              <FileCode2 size={15} color={GOLD} />
              <span className="flex-1 text-sm font-semibold text-white truncate">
                {e.contract.name} <span style={{ color: MUTED }}>v{e.contract.version}</span>
              </span>
              <NetBadge net={e.contract.network} />
              <span className="text-sm font-bold" style={{ color: '#A1FF8B' }}>
                {usd(e.sale.priceUsd)}
              </span>
            </div>
            <div className="text-[11px] line-clamp-2" style={{ color: MUTED }}>
              {e.contract.summary}
            </div>
            <div className="text-[11px]" style={{ color: MUTED }}>
              by {e.author.name || e.author.address.slice(0, 8)} · {left > 0 ? `${left} left` : 'sold out'}
              {ownedOrigins.has(c.origin) ? ' · you own this' : ''}
            </div>
          </button>
        );
      })}
      <button
        type="button"
        onClick={() => setPublishing(true)}
        className="flex items-center justify-center gap-2 rounded-xl py-2.5 text-sm font-bold border-0"
        style={{ background: '#F5B80022', color: GOLD }}
      >
        <Plus size={15} /> Publish a contract
      </button>

      {(open || publishing) &&
        createPortal(
          <div
            className="fixed inset-0 z-[300] flex items-end"
            style={{ background: 'rgba(0,0,0,0.6)' }}
            onClick={() => (setOpen(null), setPublishing(false))}
          >
            <div
              className="w-full max-h-[88vh] overflow-y-auto rounded-t-2xl p-4 flex flex-col gap-3"
              style={{ background: '#101114', paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-2">
                <span className="flex-1 text-base font-bold text-white">
                  {publishing ? 'Publish a contract' : open!.envelope.contract.name}
                </span>
                {open && !publishing && <NetBadge net={open.envelope.contract.network} />}
                <button
                  type="button"
                  aria-label="Close"
                  onClick={() => (setOpen(null), setPublishing(false))}
                  className="p-1 border-0 bg-transparent"
                >
                  <X size={18} color={MUTED} />
                </button>
              </div>
              {publishing ? (
                <PublishContract
                  onDone={() => (setPublishing(false), refresh())}
                  publish={async (env) => {
                    if (!apiContext) throw new Error('Wallet is locked');
                    return publishContract(apiContext, env);
                  }}
                  author={{
                    name: chromeStorageService.getCurrentAccountObject().account?.name ?? '',
                    address: chromeStorageService.getCurrentAccountObject().account?.addresses.bsvAddress ?? '',
                  }}
                />
              ) : (
                open && (
                  <>
                    <p className="text-sm m-0" style={{ color: '#D0D5DD' }}>
                      {open.envelope.contract.summary}
                    </p>
                    {open.envelope.description && (
                      <p className="text-xs m-0 whitespace-pre-wrap" style={{ color: MUTED }}>
                        {open.envelope.description}
                      </p>
                    )}
                    {open.envelope.contract.spendPaths && (
                      <div className="rounded-lg p-3 flex flex-col gap-1.5" style={{ background: CARD }}>
                        <div className="text-xs font-bold text-white">What it allows</div>
                        {open.envelope.contract.spendPaths.map((p) => (
                          <div key={p.name} className="text-xs" style={{ color: '#D0D5DD' }}>
                            <b className="text-white">{p.name}</b> · {p.who}:{' '}
                            <span style={{ color: MUTED }}>{p.requires}</span>
                          </div>
                        ))}
                      </div>
                    )}
                    <div className="rounded-lg p-3 flex flex-col gap-1.5" style={{ background: CARD }}>
                      {Object.entries(open.envelope.contract.params ?? {}).map(([k, v]) => (
                        <Row key={k} k={k} v={String(v)} />
                      ))}
                      {open.envelope.contract.oracle && (
                        <Row
                          k="Price feed"
                          v={`${open.envelope.contract.oracle.quorum} of ${open.envelope.contract.oracle.signers.length} signers`}
                        />
                      )}
                      {open.envelope.contract.codeHash && <Row k="Code hash" v={open.envelope.contract.codeHash} />}
                      {open.envelope.contract.source && <Row k="Source" v={open.envelope.contract.source} />}
                      <Row k="Author" v={open.envelope.author.name || open.envelope.author.address} />
                      <Row k="Copies" v={`${open.sold} of ${open.envelope.sale.copies} taken`} />
                    </div>
                    <p className="text-[11px] m-0" style={{ color: MUTED }}>
                      {CONTRACT_DISCLAIMER}
                    </p>
                    {ownedOrigins.has(open.origin) ? (
                      <div className="rounded-lg p-3 text-xs" style={{ background: '#12B76A22', color: '#6CE9A6' }}>
                        You own this contract.{' '}
                        {open.envelope.contract.network === 'testnet'
                          ? 'Using it from the wallet comes next; for now see its source for the testnet commands.'
                          : ''}
                      </div>
                    ) : (
                      (() => {
                        const sats = rate > 0 ? contractPriceSats(open.envelope, rate) : 0;
                        const fee = marketFeeSats(sats);
                        const soldOut = open.sold >= open.envelope.sale.copies;
                        const paid = open.envelope.sale.priceUsd > 0;
                        return (
                          <button
                            type="button"
                            disabled={!!busy || soldOut || (paid && !rate) || !apiContext}
                            onClick={() => void buy(open)}
                            className="flex items-center justify-center gap-2 rounded-full py-3 font-bold border-0"
                            style={{ background: GOLD, color: '#000', opacity: busy || soldOut ? 0.6 : 1 }}
                          >
                            {busy && <Loader2 size={15} className="animate-spin" />}
                            {busy ||
                              (soldOut
                                ? 'Sold out'
                                : paid
                                  ? `Buy for ${usd(open.envelope.sale.priceUsd)}${fee && rate ? ` + ${usd((fee / 1e8) * rate)} fee` : ''}`
                                  : 'Get it (free, small network fee)')}
                          </button>
                        );
                      })()
                    )}
                  </>
                )
              )}
            </div>
          </div>,
          document.body,
        )}
    </section>
  );
};

const PublishContract = ({
  publish,
  author,
  onDone,
}: {
  publish: (env: ReturnType<typeof contractEnvelope>) => Promise<string>;
  author: { name: string; address: string };
  onDone: () => void;
}) => {
  const [json, setJson] = useState('');
  const [description, setDescription] = useState('');
  const [price, setPrice] = useState('0');
  const [copies, setCopies] = useState('1000');
  const [problems, setProblems] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const input = 'rounded-lg px-3 py-2 text-sm text-white outline-none border w-full';
  const style = { background: '#010101', borderColor: LINE };

  const go = async () => {
    const d = parseDescriptor(json);
    if (!d.ok) return setProblems(d.errors);
    const env = contractEnvelope(d.contract, {
      description,
      author,
      sale: { priceUsd: Number(price), copies: Number(copies), payTo: author.address },
    });
    const p = contractSaleProblems(env);
    setProblems(p);
    if (p.length) return;
    setBusy(true);
    try {
      await publish(env);
      onDone();
    } catch (e) {
      setProblems([e instanceof Error ? e.message : String(e)]);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="text-xs" style={{ color: MUTED }}>
        Paste the contract&apos;s descriptor (<span className="font-mono">contract.json</span>, format
        bwalletx.contract/1). It&apos;s published as a public NFT: anyone can read it. Sales pay this account.
      </div>
      <textarea
        value={json}
        onChange={(e) => setJson(e.target.value)}
        rows={8}
        spellCheck={false}
        placeholder="contract.json"
        className={`${input} font-mono text-xs`}
        style={style}
      />
      <textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        rows={3}
        placeholder="Description for buyers"
        className={input}
        style={style}
      />
      <div className="flex gap-2">
        <label className="text-xs flex flex-col gap-1 flex-1" style={{ color: MUTED }}>
          Price (USD, 0 = free)
          <input
            value={price}
            inputMode="decimal"
            onChange={(e) => setPrice(e.target.value.replace(/[^0-9.]/g, ''))}
            className={input}
            style={style}
          />
        </label>
        <label className="text-xs flex flex-col gap-1 flex-1" style={{ color: MUTED }}>
          Copies
          <input
            value={copies}
            inputMode="numeric"
            onChange={(e) => setCopies(e.target.value.replace(/\D/g, ''))}
            className={input}
            style={style}
          />
        </label>
      </div>
      {problems.length > 0 && (
        <ul className="m-0 pl-4 text-xs" style={{ color: '#FDA29B' }}>
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      <button
        type="button"
        disabled={busy || !json.trim()}
        onClick={() => void go()}
        className="flex items-center justify-center gap-2 rounded-lg px-3 py-2.5 text-sm font-bold border-0"
        style={{ background: GOLD, color: '#000' }}
      >
        {busy && <Loader2 size={14} className="animate-spin" />} {busy ? 'Publishing…' : 'Publish'}
      </button>
    </div>
  );
};

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Loader2, X } from 'lucide-react';
import { PrivateKey } from '@bsv/sdk';
import { prepareSweepInputs, sweepBsv, sweepBsv21, sweepOrdinals } from '@1sat/actions';
import type { IndexedOutput } from '@1sat/types';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import { scanAddress, type ScannedAssets, type TokenBalance } from '../../sweep/scanner';
import { moneyNow } from '../money/money';
import {
  FALLBACK_PATHS,
  PRESETS,
  accountKey,
  normalizePath,
  normalizePhrase,
  phraseProblem,
  scanAccount,
  type HdAddress,
} from './hd';

const GOLD = '#FFD24D';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const RED = '#F97066';

/** Has this address ever been used? WhatsOnChain address history (404 or an empty list = never). */
const woCUsed = async (address: string): Promise<boolean> => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`https://api.whatsonchain.com/v1/bsv/main/address/${address}/history`);
    if (r.status === 429) {
      await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
      continue;
    }
    // Stay under the free API's ~3 requests a second.
    await new Promise((ok) => setTimeout(ok, 350));
    // WhatsOnChain answers 404 "Not Found" for an address it has never seen.
    if (r.status === 404) return false;
    if (!r.ok) throw new Error(`Address lookup failed (${r.status})`);
    const list = (await r.json()) as unknown[];
    return Array.isArray(list) && list.length > 0;
  }
  throw new Error('Address lookup is busy. Try again in a minute.');
};

type Found = {
  path: string;
  addresses: HdAddress[];
  assets: ScannedAssets;
  /** outpoint → private key of the address holding it */
  keyFor: Map<string, string>;
};
type Result = { label: string; txid?: string; error?: string };

const emptyAssets = (): ScannedAssets => ({
  funding: [],
  ordinals: [],
  opnsNames: [],
  bsv21Tokens: [],
  bsv20Tokens: [],
  locked: [],
  totalBsv: 0,
});

/** Join per-address token balances by token id. */
const mergeTokens = (all: TokenBalance[]): TokenBalance[] => {
  const by = new Map<string, TokenBalance>();
  for (const t of all) {
    const prev = by.get(t.tokenId);
    by.set(
      t.tokenId,
      prev
        ? { ...prev, totalAmount: prev.totalAmount + t.totalAmount, outputs: [...prev.outputs, ...t.outputs] }
        : { ...t, outputs: [...t.outputs] },
    );
  }
  return [...by.values()];
};

/**
 * Settings › Sweep from another wallet: move everything from an HD wallet (SimplyCash, other BIP44
 * wallets) into the current bWallet account. Phrase → scan the receive and change chains → review →
 * one sweep per asset kind, each input signed by the key of the address it sits at.
 *
 * The phrase and passphrase live only in this screen's state; they are cleared on leaving.
 */
export const HdSweepScreen = ({ onBack }: { onBack: () => void }) => {
  const { apiContext } = useServiceContext();
  const [phrase, setPhrase] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [presetId, setPresetId] = useState(PRESETS[0].id);
  const [customPath, setCustomPath] = useState('');
  const [step, setStep] = useState<'enter' | 'scanning' | 'review' | 'sweeping' | 'done'>('enter');
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const [found, setFound] = useState<Found | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const cancelled = useRef(false);
  const busy = step === 'scanning' || step === 'sweeping';

  const leave = () => {
    if (busy) return;
    setPhrase('');
    setPassphrase('');
    onBack();
  };
  useBackClose(true, leave);
  useEffect(
    () => () => {
      cancelled.current = true;
    },
    [],
  );

  const preset = PRESETS.find((p) => p.id === presetId)!;
  const chosenPath = preset.id === 'custom' ? normalizePath(customPath) : preset.path;

  const scan = async () => {
    const problem = phraseProblem(phrase);
    if (problem) return setError(problem);
    if (!chosenPath) return setError("That path doesn't look right. Example: m/44'/145'/0'");
    if (!apiContext.services) return setError('Wallet services are not ready yet. Try again in a moment.');
    setError('');
    setStep('scanning');
    try {
      // The chosen path first; if it was never used, the common alternatives.
      const paths = [chosenPath, ...FALLBACK_PATHS.filter((p) => p !== chosenPath)];
      for (const path of paths) {
        if (cancelled.current) return;
        const account = accountKey(phrase, passphrase, path);
        const used = await scanAccount(account, path, woCUsed, (checked, n) =>
          setProgress(`${path}: checked ${checked} addresses, ${n} used`),
        );
        if (!used.length) continue;
        const assets = emptyAssets();
        const keyFor = new Map<string, string>();
        const tokens: TokenBalance[] = [];
        for (const [i, a] of used.entries()) {
          if (cancelled.current) return;
          setProgress(`Looking for coins and tokens: address ${i + 1} of ${used.length}`);
          const r = await scanAddress(apiContext.services, a.address);
          const own = (o: IndexedOutput) => keyFor.set(o.outpoint, a.wif);
          [...r.funding, ...r.ordinals, ...r.opnsNames, ...r.bsv20Tokens, ...r.locked].forEach(own);
          r.bsv21Tokens.forEach((t) => t.outputs.forEach(own));
          assets.funding.push(...r.funding);
          assets.ordinals.push(...r.ordinals);
          assets.opnsNames.push(...r.opnsNames);
          assets.bsv20Tokens.push(...r.bsv20Tokens);
          assets.locked.push(...r.locked);
          assets.totalBsv += r.totalBsv;
          tokens.push(...r.bsv21Tokens);
        }
        assets.bsv21Tokens = mergeTokens(tokens);
        setFound({ path, addresses: used, assets, keyFor });
        setStep('review');
        return;
      }
      setError(
        'No used addresses on any of the usual paths. Check the phrase and passphrase, or try a custom path.',
      );
      setStep('enter');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'The scan failed. Try again.');
      setStep('enter');
    }
  };

  const sweep = async () => {
    if (!found) return;
    setStep('sweeping');
    const { assets, keyFor } = found;
    const out: Result[] = [];
    const toInputs = (os: IndexedOutput[]) => os.map((o) => ({ outpoint: o.outpoint, satoshis: o.satoshis ?? 0, score: 0 }));
    const keysFor = (inputs: { outpoint: string }[]) => inputs.map((i) => PrivateKey.fromWif(keyFor.get(i.outpoint)!));

    if (assets.funding.length) {
      setProgress('Sweeping BSV…');
      try {
        const inputs = await prepareSweepInputs(apiContext, toInputs(assets.funding));
        const r = await sweepBsv.execute(apiContext, { inputs, keys: keysFor(inputs) });
        out.push({ label: `BSV (${moneyNow(assets.totalBsv)})`, txid: r.txid, error: r.error });
      } catch (e) {
        out.push({ label: 'BSV', error: String(e) });
      }
    }
    if (assets.ordinals.length) {
      setProgress('Sweeping ordinals…');
      try {
        const inputs = await prepareSweepInputs(apiContext, toInputs(assets.ordinals));
        const r = await sweepOrdinals.execute(apiContext, { inputs, keys: keysFor(inputs) });
        out.push({ label: `Ordinals (${assets.ordinals.length})`, txid: r.txid, error: r.error });
      } catch (e) {
        out.push({ label: 'Ordinals', error: String(e) });
      }
    }
    for (const t of assets.bsv21Tokens) {
      const label = t.symbol || t.tokenId.slice(0, 8);
      setProgress(`Sweeping ${label}…`);
      try {
        const inputs = await prepareSweepInputs(apiContext, toInputs(t.outputs));
        const r = await sweepBsv21.execute(apiContext, {
          inputs: inputs.map((i) => ({ ...i, tokenId: t.tokenId, amount: t.totalAmount.toString() })),
          keys: keysFor(inputs),
        });
        out.push({ label: `${label} (${t.totalAmount})`, txid: r.txid, error: r.error });
      } catch (e) {
        out.push({ label, error: String(e) });
      }
    }
    setPhrase('');
    setPassphrase('');
    setResults(out);
    setStep('done');
  };

  const a = found?.assets;
  const nothing =
    !!a && !a.funding.length && !a.ordinals.length && !a.bsv21Tokens.length;
  const skipped = a ? a.opnsNames.length + a.bsv20Tokens.length + a.locked.length : 0;

  return createPortal(
    <div className="fixed inset-0 z-[150] flex flex-col" style={{ background: '#010101' }}>
      <div
        className="flex items-center gap-2 px-2 pb-2"
        style={{ paddingTop: 'max(env(safe-area-inset-top), 12px)', borderBottom: `1px solid ${LINE}` }}
      >
        <button onClick={leave} disabled={busy} aria-label="Back" className="p-2 disabled:opacity-40">
          <ArrowLeft size={20} color="white" />
        </button>
        <span className="text-[16px] font-bold text-white">Sweep from another wallet</span>
      </div>
      <div className="flex-1 overflow-y-auto p-4 pb-24 flex flex-col gap-4">
        {step === 'enter' && (
          <>
            <p className="text-xs" style={{ color: MUTED }}>
              Move everything from an old wallet (SimplyCash and other 12 or 24-word wallets) into this bWallet
              account. The phrase stays on this phone and is forgotten when you leave this screen.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-white">Recovery phrase</span>
              <textarea
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                onBlur={() => setPhrase((p) => normalizePhrase(p))}
                rows={3}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                placeholder="12 or 24 words"
                className="rounded-xl px-3 py-2 text-sm text-white outline-none"
                style={{ background: PANEL, border: `1px solid ${LINE}` }}
              />
            </label>
            <div className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-white">Wallet it came from</span>
              <div className="flex flex-col gap-1.5">
                {PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setPresetId(p.id)}
                    className="flex items-center justify-between rounded-xl px-3 py-2 text-left"
                    style={{ background: PANEL, border: `1px solid ${presetId === p.id ? GOLD : LINE}` }}
                  >
                    <span className="text-sm text-white">{p.label}</span>
                    <span className="text-[11px]" style={{ color: MUTED }}>
                      {p.path || p.note}
                    </span>
                  </button>
                ))}
              </div>
              {presetId === 'custom' && (
                <input
                  value={customPath}
                  onChange={(e) => setCustomPath(e.target.value)}
                  placeholder="m/44'/145'/0'"
                  autoCapitalize="off"
                  autoCorrect="off"
                  className="rounded-xl px-3 py-2 text-sm text-white outline-none"
                  style={{ background: PANEL, border: `1px solid ${LINE}` }}
                />
              )}
            </div>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-white">Passphrase (only if the old wallet had one)</span>
              <input
                type="password"
                value={passphrase}
                onChange={(e) => setPassphrase(e.target.value)}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                className="rounded-xl px-3 py-2 text-sm text-white outline-none"
                style={{ background: PANEL, border: `1px solid ${LINE}` }}
              />
            </label>
            {error && <p className="text-xs" style={{ color: RED }}>{error}</p>}
            <button
              onClick={() => void scan()}
              disabled={!phrase.trim()}
              className="rounded-xl py-3 text-sm font-bold disabled:opacity-40"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              Find my coins
            </button>
            <p className="text-[11px]" style={{ color: MUTED }}>
              Never type this phrase into a website, and never give it to anyone offering to recover funds.
            </p>
          </>
        )}

        {busy && (
          <div className="flex flex-col items-center gap-3 pt-16 text-center">
            <Loader2 size={28} color={GOLD} className="animate-spin" />
            <p className="text-sm text-white">{step === 'scanning' ? 'Scanning the old wallet' : 'Sweeping'}</p>
            <p className="text-xs" style={{ color: MUTED }}>
              {progress}
            </p>
          </div>
        )}

        {step === 'review' && found && a && (
          <>
            <div className="rounded-2xl p-4 flex flex-col gap-2" style={{ background: PANEL }}>
              <p className="text-xs" style={{ color: MUTED }}>
                Found on {found.path}: {found.addresses.length} used address{found.addresses.length === 1 ? '' : 'es'}
              </p>
              <p className="text-2xl font-bold text-white">{moneyNow(a.totalBsv)}</p>
              <p className="text-xs" style={{ color: MUTED }}>
                {a.totalBsv.toLocaleString()} sats in {a.funding.length} coin{a.funding.length === 1 ? '' : 's'}
              </p>
              {!!a.ordinals.length && <p className="text-sm text-white">{a.ordinals.length} ordinals</p>}
              {a.bsv21Tokens.map((t) => (
                <p key={t.tokenId} className="text-sm text-white">
                  {t.symbol || t.tokenId.slice(0, 8)}: {t.totalAmount.toString()}
                </p>
              ))}
              {!!skipped && (
                <p className="text-[11px]" style={{ color: MUTED }}>
                  Not swept here: {skipped} other item{skipped === 1 ? '' : 's'} (names, BSV-20 tokens or locked coins).
                </p>
              )}
            </div>
            {nothing ? (
              <p className="text-sm text-white">
                This wallet was used, but there is nothing left in it to sweep.
              </p>
            ) : (
              <button
                onClick={() => void sweep()}
                className="rounded-xl py-3 text-sm font-bold"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                Sweep into this account
              </button>
            )}
            <button onClick={() => setStep('enter')} className="text-xs underline" style={{ color: MUTED }}>
              Try a different path
            </button>
          </>
        )}

        {step === 'done' && (
          <>
            {results.map((r) => (
              <div key={r.label} className="flex items-start gap-2 rounded-xl p-3" style={{ background: PANEL }}>
                {r.error ? <X size={16} color={RED} /> : <Check size={16} color="#2ecc71" />}
                <div className="flex flex-col min-w-0">
                  <span className="text-sm text-white">{r.label}</span>
                  <span className="text-[11px] break-all" style={{ color: r.error ? RED : MUTED }}>
                    {r.error ?? r.txid}
                  </span>
                </div>
              </div>
            ))}
            <button
              onClick={leave}
              className="rounded-xl py-3 text-sm font-bold"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              Done
            </button>
          </>
        )}
      </div>
    </div>,
    document.body,
  );
};

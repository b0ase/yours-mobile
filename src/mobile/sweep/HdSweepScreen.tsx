import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, ChevronDown, ChevronRight, Loader2, X } from 'lucide-react';
import { HD, Mnemonic, PrivateKey } from '@bsv/sdk';
import { prepareSweepInputs, sweepBsv, sweepBsv21, sweepOrdinals } from '@1sat/actions';
import type { IndexedOutput } from '@1sat/types';
import { useBackClose } from '../backStack';
import { useServiceContext } from '../../hooks/useServiceContext';
import { scanAddress, type ScannedAssets, type TokenBalance } from '../../sweep/scanner';
import { moneyNow } from '../money/money';
import {
  HD_ACCOUNTS,
  accountKey,
  accountKeyNonCompliant,
  addressAt,
  detectInput,
  fixedKeys,
  normalizePath,
  scanAccount,
  tokenAmount,
  wifKey,
  type SingleKey,
} from './hd';
import { MONEYBUTTON_PATH, addressHash, sfpOutputsFor, splitSpendable, type SfpOutput } from './moneybutton';

const GOLD = '#FFD24D';
const PANEL = '#17191E';
const LINE = '#2b2f36';
const MUTED = '#98A2B3';
const RED = '#F97066';

const WOC = 'https://api.whatsonchain.com/v1/bsv/main';

/** GET from WhatsOnChain with 429 retries; null on 404. */
const wocGet = async (path: string): Promise<Response | null> => {
  for (let attempt = 0; attempt < 4; attempt++) {
    const r = await fetch(`${WOC}${path}`);
    if (r.status === 429) {
      await new Promise((ok) => setTimeout(ok, 1000 * (attempt + 1)));
      continue;
    }
    // Stay under the free API's ~3 requests a second.
    await new Promise((ok) => setTimeout(ok, 350));
    // WhatsOnChain answers 404 "Not Found" for an address or tx it has never seen.
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`Lookup failed (${r.status})`);
    return r;
  }
  throw new Error('Address lookup is busy. Try again in a minute.');
};

/** The txids in an address's history (WhatsOnChain), empty when it was never used. */
const wocHistory = async (address: string): Promise<string[]> => {
  const r = await wocGet(`/address/${address}/history`);
  const list = r ? ((await r.json()) as { tx_hash?: string }[]) : [];
  return Array.isArray(list) ? list.map((h) => h.tx_hash ?? '').filter(Boolean) : [];
};

/** Has this address ever been used? */
const woCUsed = async (address: string): Promise<boolean> => (await wocHistory(address)).length > 0;

/** How many history transactions to read per address when looking for Money Button tokens. */
const SFP_TX_LIMIT = 200;

type Found = {
  /** Which wallet types / paths had history, e.g. "Yours / bWalletX payment (m/44'/236'/0'/1/0)". */
  matches: string[];
  addresses: number;
  assets: ScannedAssets;
  /** outpoint → private key of the address holding it */
  keyFor: Map<string, string>;
  /** Money Button (SFP) token outputs still held; never swept, listed only. */
  sfp: SfpOutput[];
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
 * Newer Yours (5.x, BRC-100) and bWalletX keep change and incoming payments (paymail, BRC-29) at keys
 * derived per payment from the identity key with a random prefix/suffix that only the wallet's own
 * database records (see initWallet.ts: the wallet-toolbox wallet is rooted at identityWif, and
 * names/paymail.ts internalizes payments by derivationPrefix/Suffix). A phrase scan can't enumerate
 * those, so we say so instead of implying the sweep found everything (6 Oct 2026).
 */
const SFP_NOTE =
  'Money Button tokens (Simple Fabriik Protocol) can only move with a signature from Money Button’s token server, which shut down in 2022. They stay where they are, untouched: the sweep leaves them and the small amount of BSV inside each one alone.';

const BRC100_NOTE =
  'Coins received through newer wallet features (Yours 5 / bWalletX change and paymail payments) sit at one-off keys that can’t be found from the phrase alone. To move those, restore the phrase as an account here (Add account › Restore) and send from it.';

/**
 * Settings › Sweep from another wallet: move everything from another wallet into the current bWallet
 * account. One box takes a recovery phrase, a WIF private key or an xprv; every known wallet layout is
 * tried (Yours / bWalletX / RelayX / Twetch single keys, SimplyCash and BIP44 HD walks), so nobody has
 * to know which wallet their phrase came from (owner, 6 Oct 2026). Money Button phrases match
 * the m/44'/0'/0' walk; their SFP tokens are listed and kept out of the BSV sweep (moneybutton.ts). Review in dollars, then one sweep
 * per asset kind, each input signed by the key of the address it sits at.
 *
 * The phrase, key and passphrase live only in this screen's state; they are cleared on leaving.
 */
export const HdSweepScreen = ({ onBack }: { onBack: () => void }) => {
  const { apiContext } = useServiceContext();
  const [phrase, setPhrase] = useState('');
  const [passphrase, setPassphrase] = useState('');
  const [advanced, setAdvanced] = useState(false);
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

  const detected = detectInput(phrase);
  const kindLabel = {
    phrase: 'Recovery phrase',
    wif: 'Private key (WIF)',
    xprv: 'Extended private key (xprv)',
    unknown: '',
  }[detected.kind];

  const scan = async () => {
    const input = detectInput(phrase);
    if (input.kind === 'unknown') return setError(input.problem);
    const custom = customPath.trim() ? normalizePath(customPath) : null;
    if (customPath.trim() && !custom) return setError("That path doesn't look right. Example: m/44'/145'/0'");
    if (!apiContext.services) return setError('Wallet services are not ready yet. Try again in a moment.');
    setError('');
    setStep('scanning');
    try {
      // 1. What to try. A SimplyCash recovery string carries its own path and passphrase.
      const rec = input.kind === 'phrase' ? input.recovery : null;
      const pass = rec?.passphrase ?? passphrase;
      let singles: SingleKey[] = [];
      let accounts: { label: string; path: string; key: HD }[] = [];
      if (input.kind === 'wif') singles = [wifKey(input.wif)];
      if (input.kind === 'xprv') accounts = [{ label: 'xprv', path: 'xprv', key: HD.fromString(input.xprv) }];
      if (rec) {
        singles = fixedKeys(rec.phrase, pass);
        if (custom) {
          // A full key path is checked as a single key, and also walked as an account.
          const k = HD.fromSeed(Mnemonic.fromString(rec.phrase).toSeed(pass)).derive(custom).privKey;
          singles.push({ wallet: 'Custom', label: 'key', path: custom, address: k.toAddress(), wif: k.toWif() });
        }
        const paths = [
          ...(rec.path ? [{ wallet: 'SimplyCash', path: rec.path }] : []),
          ...(custom ? [{ wallet: 'Custom', path: custom }] : []),
          ...HD_ACCOUNTS.filter((a) => a.path !== rec.path && a.path !== custom),
        ];
        // Each HD path is also tried with the old (non-compliant) derivation early SimplyCash wallets
        // used, when that gives different keys.
        accounts = paths.flatMap(({ wallet, path }) => {
          const key = accountKey(rec.phrase, pass, path);
          const old = accountKeyNonCompliant(rec.phrase, pass, path);
          const differs = old && addressAt(old, path, 0, 0).address !== addressAt(key, path, 0, 0).address;
          return [
            { label: `${wallet} (${path})`, path, key },
            ...(differs ? [{ label: `older SimplyCash (${path})`, path, key: old! }] : []),
          ];
        });
      }

      // 2. Which of those addresses were ever used, across every layout (one wallet can match several).
      const used = new Map<string, string>(); // address → wif
      const matches: string[] = [];
      const mbAddresses = new Set<string>(); // used addresses on Money Button's path (or a pasted key)
      for (const [i, k] of singles.entries()) {
        if (cancelled.current) return;
        setProgress(`Checking ${k.wallet} ${k.label} key (${i + 1} of ${singles.length})`);
        if (input.kind === 'wif' || (await woCUsed(k.address))) {
          if (!used.has(k.address)) used.set(k.address, k.wif);
          if (input.kind === 'wif') mbAddresses.add(k.address);
          matches.push(input.kind === 'wif' ? `Private key (${k.address})` : `${k.wallet} ${k.label} (${k.path})`);
        }
      }
      for (const { label, path, key } of accounts) {
        if (cancelled.current) return;
        const hits = await scanAccount(key, path, woCUsed, (checked, n) =>
          setProgress(`${label}: checked ${checked} addresses, ${n} used`),
        );
        if (!hits.length) continue;
        matches.push(`${label}: ${hits.length} address${hits.length === 1 ? '' : 'es'}`);
        for (const h of hits) if (!used.has(h.address)) used.set(h.address, h.wif);
        if (path === MONEYBUTTON_PATH || input.kind === 'xprv') hits.forEach((h) => mbAddresses.add(h.address));
      }
      if (!used.size) {
        setError(
          'Nothing found on any known wallet layout. Check the phrase and passphrase, or try a custom path under Advanced.',
        );
        setStep('enter');
        return;
      }

      // 3. What each used address holds now.
      const assets = emptyAssets();
      const keyFor = new Map<string, string>();
      const tokens: TokenBalance[] = [];
      for (const [i, [address, wif]] of [...used.entries()].entries()) {
        if (cancelled.current) return;
        setProgress(`Looking for coins and tokens: address ${i + 1} of ${used.size}`);
        const r = await scanAddress(apiContext.services, address);
        const own = (o: IndexedOutput) => keyFor.set(o.outpoint, wif);
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

      // 4. Money Button tokens (SFP). Their scripts aren't P2PKH, so indexers don't list them under the
      // address; read the address's own history and look for SFP outputs that name it.
      const sfp: SfpOutput[] = [];
      if (mbAddresses.size) {
        const hashes = new Set([...mbAddresses].map(addressHash));
        const seen = new Set<string>();
        for (const [i, address] of [...mbAddresses].entries()) {
          const txids = (await wocHistory(address)).slice(0, SFP_TX_LIMIT);
          for (const [j, txid] of txids.entries()) {
            if (cancelled.current) return;
            if (seen.has(txid)) continue;
            seen.add(txid);
            setProgress(`Looking for Money Button tokens: address ${i + 1} of ${mbAddresses.size}, tx ${j + 1}`);
            const r = await wocGet(`/tx/${txid}/hex`);
            if (r) sfp.push(...sfpOutputsFor((await r.text()).trim(), txid, hashes));
          }
        }
        if (sfp.length) {
          const spends = await apiContext.services.txo.getSpends(sfp.map((o) => o.outpoint)).catch(() => []);
          const held = sfp.filter((_, i) => !spends[i]);
          sfp.splice(0, sfp.length, ...held);
        }
      }
      setFound({ matches, addresses: used.size, assets, keyFor, sfp });
      setStep('review');
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
    const toInputs = (os: IndexedOutput[]) =>
      os.map((o) => ({ outpoint: o.outpoint, satoshis: o.satoshis ?? 0, score: 0 }));
    const keysFor = (inputs: { outpoint: string }[]) => inputs.map((i) => PrivateKey.fromWif(keyFor.get(i.outpoint)!));

    if (assets.funding.length) {
      setProgress('Sweeping BSV…');
      try {
        // Only plain P2PKH coins are swept as BSV. Token outputs (Money Button SFP, anything with a
        // script we don't recognise) are kept back so they are never spent as plain BSV.
        const prepared = await prepareSweepInputs(apiContext, toInputs(assets.funding));
        const { spendable: inputs, kept } = splitSpendable(prepared, new Set(found.sfp.map((o) => o.outpoint)));
        if (inputs.length) {
          const sats = inputs.reduce((n, i) => n + i.satoshis, 0);
          const r = await sweepBsv.execute(apiContext, { inputs, keys: keysFor(inputs) });
          out.push({ label: `BSV (${moneyNow(sats)})`, txid: r.txid, error: r.error });
        }
        if (kept.length)
          out.push({
            label: `Left untouched: ${kept.length} coin${kept.length === 1 ? '' : 's'} that aren’t plain BSV`,
            txid: kept.map((k) => k.outpoint).join(', '),
          });
      } catch (e) {
        out.push({ label: 'BSV', error: String(e) });
      }
    }
    if (assets.ordinals.length) {
      setProgress('Sweeping NFTs…');
      try {
        const inputs = await prepareSweepInputs(apiContext, toInputs(assets.ordinals));
        const r = await sweepOrdinals.execute(apiContext, { inputs, keys: keysFor(inputs) });
        out.push({ label: `NFTs (${assets.ordinals.length})`, txid: r.txid, error: r.error });
      } catch (e) {
        out.push({ label: 'NFTs', error: String(e) });
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
        out.push({ label: `${label} (${tokenAmount(t.totalAmount, t.decimals)})`, txid: r.txid, error: r.error });
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
  const nothing = !!a && !a.funding.length && !a.ordinals.length && !a.bsv21Tokens.length;
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
              Move everything from another wallet (bWalletX, Yours, Money Button, RelayX, Twetch, SimplyCash and other
              12 or 24-word wallets) into this account. We try every known wallet layout for you. What you paste stays
              on this phone and is forgotten when you leave this screen.
            </p>
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold text-white">Recovery phrase, private key or xprv</span>
              <textarea
                value={phrase}
                onChange={(e) => setPhrase(e.target.value)}
                rows={3}
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                placeholder="12 or 24 words, a WIF private key (starts with K, L or 5), or an xprv"
                className="rounded-xl px-3 py-2 text-sm text-white outline-none"
                style={{ background: PANEL, border: `1px solid ${LINE}` }}
              />
              {kindLabel && (
                <span className="text-[11px]" style={{ color: GOLD }}>
                  {kindLabel}
                </span>
              )}
            </label>
            <button
              onClick={() => setAdvanced((v) => !v)}
              className="flex items-center gap-1 text-xs"
              style={{ color: MUTED }}
            >
              {advanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              Advanced: passphrase, custom path
            </button>
            {advanced && (
              <>
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
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold text-white">
                    Custom path (tried as well as the usual ones)
                  </span>
                  <input
                    value={customPath}
                    onChange={(e) => setCustomPath(e.target.value)}
                    placeholder="m/44'/145'/0'"
                    autoCapitalize="off"
                    autoCorrect="off"
                    className="rounded-xl px-3 py-2 text-sm text-white outline-none"
                    style={{ background: PANEL, border: `1px solid ${LINE}` }}
                  />
                </label>
              </>
            )}
            {error && (
              <p className="text-xs" style={{ color: RED }}>
                {error}
              </p>
            )}
            <button
              onClick={() => void scan()}
              disabled={!phrase.trim()}
              className="rounded-xl py-3 text-sm font-bold disabled:opacity-40"
              style={{ background: GOLD, color: '#1a1300' }}
            >
              Find my coins
            </button>
            <p className="text-[11px]" style={{ color: MUTED }}>
              Never type a phrase or key into a website, and never give it to anyone offering to recover funds.
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
              <p className="text-2xl font-bold text-white">{moneyNow(a.totalBsv)}</p>
              <p className="text-xs" style={{ color: MUTED }}>
                {a.totalBsv.toLocaleString()} sats in {a.funding.length} coin{a.funding.length === 1 ? '' : 's'}, from{' '}
                {found.addresses} address{found.addresses === 1 ? '' : 'es'}
              </p>
              <p className="text-sm text-white">
                {a.ordinals.length} NFT{a.ordinals.length === 1 ? '' : 's'}
              </p>
              {a.bsv21Tokens.map((t) => (
                <p key={t.tokenId} className="text-sm text-white">
                  {t.symbol || t.tokenId.slice(0, 8)}: {tokenAmount(t.totalAmount, t.decimals)}
                </p>
              ))}
              {!!skipped && (
                <p className="text-[11px]" style={{ color: MUTED }}>
                  Not swept here: {skipped} other item{skipped === 1 ? '' : 's'} (names, BSV-20 tokens or locked coins).
                </p>
              )}
            </div>
            {!!found.sfp.length && (
              <div className="rounded-2xl p-4 flex flex-col gap-1" style={{ background: PANEL }}>
                <p className="text-xs font-semibold text-white">Money Button tokens (kept, not swept)</p>
                {found.sfp.map((t) => (
                  <p key={t.outpoint} className="text-[11px] break-all text-white">
                    {t.amount.toLocaleString('en-US')} × {t.asset}
                  </p>
                ))}
                <p className="text-[11px]" style={{ color: MUTED }}>
                  {SFP_NOTE}
                </p>
              </div>
            )}
            <div className="rounded-2xl p-4 flex flex-col gap-1" style={{ background: PANEL }}>
              <p className="text-xs font-semibold text-white">Matched</p>
              {found.matches.map((m) => (
                <p key={m} className="text-[11px] break-all" style={{ color: MUTED }}>
                  {m}
                </p>
              ))}
            </div>
            {nothing ? (
              <p className="text-sm text-white">This wallet was used, but there is nothing left in it to sweep.</p>
            ) : (
              <button
                onClick={() => void sweep()}
                className="rounded-xl py-3 text-sm font-bold"
                style={{ background: GOLD, color: '#1a1300' }}
              >
                Sweep all to this account
              </button>
            )}
            <p className="text-[11px]" style={{ color: MUTED }}>
              {BRC100_NOTE}
            </p>
            <button onClick={() => setStep('enter')} className="text-xs underline" style={{ color: MUTED }}>
              Back
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

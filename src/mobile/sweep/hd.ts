import { BigNumber, Hash, HD, Mnemonic, PrivateKey } from '@bsv/sdk';

/**
 * Sweep from another wallet: the HD (BIP39 + BIP32/44) side. Turns a 12/24-word phrase (plus optional
 * passphrase) and an account path into addresses, and walks each chain until GAP addresses in a row
 * were never used. Pure apart from the `isUsed` callback, so it is unit-tested with fake histories.
 *
 * The phrase is never stored: callers hold it in memory only for the scan and the sweep.
 */
export const GAP = 20;
const MAX_PER_CHAIN = 2000;

export type Preset = { id: string; label: string; path: string; note: string };

/** Account-level paths (receive = /0/i, change = /1/i). */
export const PRESETS: Preset[] = [
  { id: 'simplycash', label: 'SimplyCash', path: "m/44'/145'/0'", note: "BIP44, coin type 145'" },
  { id: 'bsv', label: 'BIP44 (BSV)', path: "m/44'/236'/0'", note: "coin type 236'" },
  { id: 'btc', label: 'BIP44 (Bitcoin legacy)', path: "m/44'/0'/0'", note: "coin type 0'" },
  { id: 'custom', label: 'Custom path', path: '', note: 'Type the account path' },
];

/** Paths tried after the chosen one comes back empty. */
export const FALLBACK_PATHS = PRESETS.filter((p) => p.path).map((p) => p.path);

export type HdAddress = { path: string; address: string; wif: string };

export const normalizePhrase = (s: string) => s.trim().toLowerCase().split(/\s+/).filter(Boolean).join(' ');

/** Null when the phrase is fine, else what's wrong (word count / checksum). */
export function phraseProblem(phrase: string): string | null {
  const words = normalizePhrase(phrase).split(' ').filter(Boolean);
  if (![12, 15, 18, 21, 24].includes(words.length)) return 'A recovery phrase is 12 or 24 words.';
  try {
    Mnemonic.fromString(words.join(' ')).check();
    return null;
  } catch {
    return 'That phrase doesn’t check out. Look for a mistyped word.';
  }
}

/** `m/44'/145'/0'`, also accepting h for hardened and a missing leading m/. */
export function normalizePath(path: string): string | null {
  const p = path.trim().replace(/[hH]/g, "'").replace(/^m?\/?/, 'm/').replace(/\/+$/, '');
  return /^m(\/\d+'?)+$/.test(p) ? p : null;
}

export const accountKey = (phrase: string, passphrase: string, path: string): HD =>
  HD.fromSeed(Mnemonic.fromString(normalizePhrase(phrase)).toSeed(passphrase)).derive(path);

/**
 * What someone pasted: a plain phrase, SimplyCash's recovery string `words:path:passphrase`
 * (the path and passphrase it saved with the wallet), or an account xprv.
 */
export type Recovery = { phrase: string; path?: string; passphrase?: string; xprv?: string };
export function parseRecovery(input: string): Recovery {
  const v = input.trim();
  if (/^xprv[0-9a-zA-Z]+$/.test(v)) return { phrase: '', xprv: v };
  const [words, path, ...rest] = v.split(':');
  return {
    phrase: normalizePhrase(words),
    path: path ? (normalizePath(path) ?? undefined) : undefined,
    passphrase: rest.length ? rest.join(':') : undefined,
  };
}

const N = new BigNumber('FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141', 16);
const ser32 = (i: number) => [(i >>> 24) & 255, (i >>> 16) & 255, (i >>> 8) & 255, i & 255];

/**
 * One hardened BIP32 step. `pad: false` reproduces the old bitcore bug ("non-compliant"
 * derivation, used by early SimplyCash wallets): the parent private key goes into the HMAC without
 * its leading zero bytes, so about 1 key in 256 derives a different child.
 */
export function hardenedChild(parent: HD, index: number, pad: boolean): HD {
  const i = index + 0x80000000;
  const k = pad ? parent.privKey.toArray('be', 32) : parent.privKey.toArray('be');
  const I = Hash.sha512hmac(parent.chainCode, [0, ...k, ...ser32(i)]);
  const child = new BigNumber(I.slice(0, 32)).add(parent.privKey).umod(N);
  const priv = new PrivateKey(child.toArray('be', 32));
  const fingerprint = Hash.hash160(parent.privKey.toPublicKey().encode(true) as number[]).slice(0, 4);
  return new HD(parent.versionBytesNum, parent.depth + 1, fingerprint, i, I.slice(32), priv, priv.toPublicKey());
}

/** Account key the old (non-compliant) way: every level must be hardened, as SimplyCash's paths are. */
export function accountKeyNonCompliant(phrase: string, passphrase: string, path: string): HD | null {
  let hd = HD.fromSeed(Mnemonic.fromString(normalizePhrase(phrase)).toSeed(passphrase));
  for (const part of path.split('/').slice(1)) {
    if (!part.endsWith("'")) return null;
    hd = hardenedChild(hd, Number(part.slice(0, -1)), false);
  }
  return hd;
}

export function addressAt(account: HD, accountPath: string, chain: 0 | 1, index: number): HdAddress {
  const child = account.deriveChild(chain).deriveChild(index);
  return {
    path: `${accountPath}/${chain}/${index}`,
    address: child.privKey.toAddress(),
    wif: child.privKey.toWif(),
  };
}

/**
 * Every used address on the account's receive and change chains. A chain ends after GAP unused
 * addresses in a row (the BIP44 gap limit).
 */
export async function scanAccount(
  account: HD,
  accountPath: string,
  isUsed: (address: string) => Promise<boolean>,
  onProgress?: (checked: number, found: number) => void,
): Promise<HdAddress[]> {
  const used: HdAddress[] = [];
  let checked = 0;
  for (const chain of [0, 1] as const) {
    let misses = 0;
    for (let i = 0; i < MAX_PER_CHAIN && misses < GAP; i++) {
      const a = addressAt(account, accountPath, chain, i);
      if (await isUsed(a.address)) {
        used.push(a);
        misses = 0;
      } else misses++;
      onProgress?.(++checked, used.length);
    }
  }
  return used;
}

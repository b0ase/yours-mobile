import { setAgentVoice } from '../agent/handoff';
import { hidePhrases } from './phraseGuard';
import { APP_NAME } from '../storeBuild';

/**
 * Every error the wallet shows gets "Copy" and "Ask b" (owner, 10 Oct 2026). Ask b opens the b agent
 * (/m/ask-b) with the error already typed in, plus where it happened, the app version and the edition.
 *
 * ⚠ What leaves through either action is redacted first: an error can echo user input, and the person
 * may have pasted recovery words, a private key or a password into the field that failed. Never sent:
 * recovery words, WIF / extended private keys, 64-hex secrets, anything labelled password, passphrase,
 * seed, mnemonic, private key or WIF, and balances.
 */

// Not over a phrase already hidden ("seed: [recovery words hidden]" stays whole).
const SECRET_LABEL =
  /\b(password|passphrase|pass|pin|seed|mnemonic|recovery words?|private key|priv(?:ate)?key|wif|secret)\s*[:=]\s*(?!\[recovery words hidden\])\S+/gi;
// Base58 / hex lookarounds, not \b: "_" is a word character, so \b missed a key written as key_<wif>_ (audit 25 Oct 2026).
const WIF = /(?<![1-9A-HJ-NP-Za-km-z])[5KL][1-9A-HJ-NP-Za-km-z]{50,51}(?![1-9A-HJ-NP-Za-km-z])/g;
const XPRV = /(?<![1-9A-HJ-NP-Za-km-z])[xt]prv[1-9A-HJ-NP-Za-km-z]{100,112}(?![1-9A-HJ-NP-Za-km-z])/g;
const HEX64 = /(?:0x)?(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const BALANCE =
  /\b(balance|total|you have|available)\b([^.\n]{0,40}?)\d[\d,]*(?:\.\d+)?\s*(bsv|sats?|satoshis|usd|\$)?/gi;
const MONEY = /(?:\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:bsv|sats?|satoshis)\b)/gi;

/** What leaves: at most this many characters of redacted text. */
const REDACTED_MAX = 1200;
/** Text is redacted from its first SCAN_FROM characters, more only when redaction shrinks the text a lot. */
const SCAN_FROM = 20_000;
/**
 * A phrase or key cut in two where the scan stops may not be found. The last SCAN_TAIL characters scanned must
 * therefore land past what is kept, or the scan widens.
 */
const SCAN_TAIL = 4_000;

/**
 * Everything redacted in one piece of text, and how many characters the replacements removed in all. Recovery words are
 * hidden first: "balance", "total", "seed", "pass" and "secret" are BIP39 words, and the label and balance rules ate the
 * numbering or the words after them, so the phrase guard no longer saw a phrase (review of b-Aware row 353).
 */
const redactPiece = (text: string): { out: string; removed: number } => {
  let removed = 0;
  const sub = (t: string, re: RegExp, to: (m: string, ...g: string[]) => string) =>
    t.replace(re, (m: string, ...g: string[]) => {
      const r = to(m, ...g);
      removed += Math.max(0, m.length - r.length);
      return r;
    });
  const hidden = hidePhrases(text);
  // A mask is shorter than the 12+ words it hides, so this is the sum of what each one removed.
  removed += text.length - hidden.length;
  let out = sub(hidden, SECRET_LABEL, (_m, label) => `${label}: [hidden]`);
  out = sub(out, XPRV, () => '[private key hidden]');
  out = sub(out, WIF, () => '[private key hidden]');
  out = sub(out, HEX64, () => '[key hidden]');
  out = sub(out, BALANCE, (_m, word) => `${word} [amount hidden]`);
  out = sub(out, MONEY, () => '[amount]');
  return { out, removed };
};

/**
 * What leaves through Copy, Ask b and Report. Only the start of a long text is redacted: the phrase guard runs on the
 * main thread, and an error can echo a very long input (review of b-Aware row 353). A character scanned lands earlier
 * by at most all the replacements removed (one that adds characters only moves it later), so one from the last
 * SCAN_TAIL lands at scan - SCAN_TAIL - removed or later; when that is past what is kept, nothing kept was cut.
 */
export const redactSecrets = (text: string): string => {
  const src = String(text ?? '');
  for (let scan = SCAN_FROM; ; scan *= 4) {
    if (src.length <= scan) return redactPiece(src).out.slice(0, REDACTED_MAX);
    const { out, removed } = redactPiece(src.slice(0, scan));
    if (scan - SCAN_TAIL - removed >= REDACTED_MAX) return out.slice(0, REDACTED_MAX);
  }
};

export type ErrorContext = { screen?: string; version?: string; edition?: string; channel?: string; time?: string };

export const errorContext = (): ErrorContext => {
  let version = 'dev';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) version = chrome.runtime.getManifest().version;
  } catch {
    /* not the extension */
  }
  try {
    if (version === 'dev' && typeof __BUILD_COMMIT__ === 'string' && __BUILD_COMMIT__)
      version = `dev ${__BUILD_COMMIT__}`;
  } catch {
    /* not stamped (tests) */
  }
  let channel = '';
  try {
    channel = import.meta.env?.VITE_CHANNEL ?? '';
  } catch {
    /* no env */
  }
  const g = globalThis as { Capacitor?: { getPlatform?: () => string } };
  const native = g.Capacitor?.getPlatform?.();
  if (!channel) channel = native && native !== 'web' ? native : version.startsWith('dev') ? 'web' : 'extension';
  let edition = `${APP_NAME}`;
  try {
    if (/bwallet\b/i.test(document.title) && !/bwalletx/i.test(document.title)) edition = 'bWallet';
  } catch {
    /* no document */
  }
  let screen = '';
  try {
    screen = currentScreen();
  } catch {
    /* unknown */
  }
  return { screen, version, edition, channel, time: new Date().toISOString() };
};

const contextLine = (ctx: ErrorContext): string =>
  [
    ctx.screen && `Screen: ${ctx.screen}`,
    ctx.version && `Version: ${ctx.version}`,
    ctx.edition && `Edition: ${ctx.edition}`,
    ctx.channel && `Channel: ${ctx.channel}`,
    ctx.time && `Time: ${ctx.time}`,
  ]
    .filter(Boolean)
    .map((part) => redactSecrets(part as string))
    .join(' · ');

/** The text Copy puts on the clipboard: the error plus where it happened, redacted. */
export const errorReportText = (error: string, ctx: ErrorContext = errorContext()): string => {
  const where = contextLine(ctx);
  return `${redactSecrets(error)}${where ? `\n${where}` : ''}`;
};

/**
 * b's first message: a bug report. It starts with "Bug report:" so b logs it with the platform
 * (bit-sign lib/b-feedback.ts, the b bug loop) as well as explaining the error and how to fix it.
 */
export const askBMessage = (error: string, ctx: ErrorContext = errorContext()): string =>
  `Bug report: I got this error in bWalletX.\nError: "${redactSecrets(error)}"\n${contextLine(ctx)}\nPlease log this as a bug report, then tell me what it means and how to fix it.`;

// ── Navigation to b: the snackbar lives outside the router, so a bridge inside it registers navigate. ──
let navigateTo: ((path: string) => void) | null = null;
let screenOf: (() => string) | null = null;
export const registerErrorNavigator = (nav: (path: string) => void, screen: () => string) => {
  navigateTo = nav;
  screenOf = screen;
  return () => {
    if (navigateTo === nav) {
      navigateTo = null;
      screenOf = null;
    }
  };
};
const currentScreen = () => (screenOf ? screenOf() : '');

export const AGENT_PATH = '/m/ask-b';

/**
 * Open b with the bug report attached and sent: the same path as hold-to-talk (setAgentVoice), so b's page
 * sends it through its normal send(), which still shows the consent sheet / price confirm when needed.
 */
export const askB = (error: string) => {
  setAgentVoice(askBMessage(error));
  navigateTo?.(AGENT_PATH);
};

export const copyError = async (error: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(errorReportText(error));
    return true;
  } catch {
    return false;
  }
};

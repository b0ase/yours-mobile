import * as bip39 from 'bip39';
import { AGENT_HANDOFF_EVENT, setAgentDraft } from '../agent/handoff';

/**
 * Every error the wallet shows gets "Copy" and "Ask b" (owner, 10 Oct 2026). Ask b opens the b agent
 * (/m/agent) with the error already typed in, plus where it happened, the app version and the edition.
 *
 * ⚠ What leaves through either action is redacted first: an error can echo user input, and the person
 * may have pasted recovery words, a private key or a password into the field that failed. Never sent:
 * recovery words, WIF / extended private keys, 64-hex secrets, anything labelled password, passphrase,
 * seed, mnemonic, private key or WIF, and balances.
 */

const WORDS = new Set(bip39.wordlists.english);
const SECRET_LABEL =
  /\b(password|passphrase|pass|pin|seed|mnemonic|recovery words?|private key|priv(?:ate)?key|wif|secret)\s*[:=]\s*\S+/gi;
const WIF = /\b[5KL][1-9A-HJ-NP-Za-km-z]{50,51}\b/g;
const XPRV = /\b[xt]prv[1-9A-HJ-NP-Za-km-z]{100,112}\b/g;
const HEX64 = /\b(?:0x)?[0-9a-fA-F]{64}\b/g;
const BALANCE =
  /\b(balance|total|you have|available)\b([^.\n]{0,40}?)\d[\d,]*(?:\.\d+)?\s*(bsv|sats?|satoshis|usd|\$)?/gi;
const MONEY = /(?:\$\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s*(?:bsv|sats?|satoshis)\b)/gi;

/** Runs of 11+ consecutive BIP39 words look like a recovery phrase (12/24 words, maybe one mistyped). */
const hideWordRuns = (text: string): string => {
  const tokens = text.split(/(\s+)/);
  const isWord = (t: string) => WORDS.has(t.toLowerCase().replace(/^[^a-z]+|[^a-z]+$/gi, ''));
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (!/\s/.test(tokens[i]) && isWord(tokens[i])) {
      let j = i;
      let count = 0;
      let end = i;
      while (j < tokens.length && (/\s/.test(tokens[j]) || isWord(tokens[j]))) {
        if (!/\s/.test(tokens[j])) {
          count++;
          end = j;
        }
        j++;
      }
      if (count >= 11) {
        out.push('[recovery words hidden]');
        i = end + 1;
        continue;
      }
    }
    out.push(tokens[i]);
    i++;
  }
  return out.join('');
};

export const redactSecrets = (text: string): string =>
  hideWordRuns(
    String(text ?? '')
      .replace(SECRET_LABEL, (_m, label: string) => `${label}: [hidden]`)
      .replace(XPRV, '[private key hidden]')
      .replace(WIF, '[private key hidden]')
      .replace(HEX64, '[key hidden]')
      .replace(BALANCE, (_m, word: string) => `${word} [amount hidden]`)
      .replace(MONEY, '[amount]'),
  ).slice(0, 1200);

export type ErrorContext = { screen?: string; version?: string; edition?: string };

export const errorContext = (): ErrorContext => {
  let version = 'dev';
  try {
    if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest) version = chrome.runtime.getManifest().version;
  } catch {
    /* not the extension */
  }
  let edition = 'bWalletX';
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
  return { screen, version, edition };
};

/** The text Copy puts on the clipboard: the error plus where it happened, redacted. */
export const errorReportText = (error: string, ctx: ErrorContext = errorContext()): string => {
  const where = [
    ctx.screen && `Screen: ${ctx.screen}`,
    ctx.version && `Version: ${ctx.version}`,
    ctx.edition && `Edition: ${ctx.edition}`,
  ]
    .filter(Boolean)
    .join(' · ');
  return `${redactSecrets(error)}${where ? `\n${where}` : ''}`;
};

/** b's first message: what went wrong, where, and the question. */
export const askBMessage = (error: string, ctx: ErrorContext = errorContext()): string =>
  `I got this error in bWalletX:\n"${redactSecrets(error)}"\n${[
    ctx.screen && `Screen: ${ctx.screen}`,
    ctx.version && `Version: ${ctx.version}`,
    ctx.edition && `Edition: ${ctx.edition}`,
  ]
    .filter(Boolean)
    .join(' · ')}\nWhat does it mean and how do I fix it?`;

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

export const AGENT_PATH = '/m/agent';

/** Open b with the error typed in (the person still presses send). */
export const askB = (error: string) => {
  setAgentDraft(askBMessage(error));
  queueMicrotask(() => window.dispatchEvent(new Event(AGENT_HANDOFF_EVENT)));
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

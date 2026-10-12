/**
 * Who sent an airdrop (owner, 12 Oct 2026: NFTs from $vexvoid showed a short outpoint, not "from $vexvoid").
 *
 * A transfer in has no counterparty in History (we funded nothing, txHistory.ts classify), so the sender is read
 * from the spend itself: the P2PKH unlocking script reveals the sender's public key. That key gives the sending
 * address and is looked up as an identity key on the paymail server (lookupPaymail). Accounts on this device and
 * contacts are matched by address or key too. Pure helpers here; the hook lives in AirdropsInbox.tsx.
 */
import { PublicKey } from '@bsv/sdk';
import type { RawTx } from '../wallet/txHistory';
import type { AirdropItem } from './inbox';

const HEX = /^[0-9a-f]*$/i;

/** The public key pushed last by a P2PKH-style unlocking script (`<sig> <pubkey>`), or null. */
export const pubkeyFromScriptSig = (hex: string | undefined | null): string | null => {
  if (!hex || !HEX.test(hex) || hex.length % 2) return null;
  let i = 0;
  let last = '';
  while (i < hex.length) {
    const op = parseInt(hex.slice(i, i + 2), 16);
    i += 2;
    let len: number;
    if (op >= 1 && op <= 75) len = op;
    else if (op === 0x4c) {
      len = parseInt(hex.slice(i, i + 2), 16);
      i += 2;
    } else if (op === 0x4d) {
      len = parseInt(hex.slice(i + 2, i + 4) + hex.slice(i, i + 2), 16);
      i += 4;
    } else if (op === 0) {
      last = '';
      continue;
    } else return null; // not a plain push-only script
    if (Number.isNaN(len) || i + len * 2 > hex.length) return null;
    last = hex.slice(i, i + len * 2);
    i += len * 2;
  }
  const k = last.toLowerCase();
  return (k.length === 66 && /^0[23]/.test(k)) || (k.length === 130 && k.startsWith('04')) ? k : null;
};

/** P2PKH address of a public key, or '' when it isn't one. */
export const addressOfKey = (pubkey: string): string => {
  try {
    return PublicKey.fromString(pubkey).toAddress();
  } catch {
    return '';
  }
};

const norm = (o: string) => (o || '').toLowerCase().replace('.', '_');

/**
 * Adds what the transaction says about an airdrop: the NFT's outpoint at our address, the sender's key, and (when
 * History had none) the sender's address, which also becomes the issuer so "Trust this sender" means the sender.
 */
export const withSender = (item: AirdropItem, tx: RawTx | undefined, own: Set<string>): AirdropItem => {
  if (!tx) return item;
  const next: AirdropItem = { ...item };
  if (item.asset.kind === 'nft' && !item.outpoint) {
    const o = tx.vout.find((v) => v.sats === 1 && v.addresses.some((a) => own.has(a)));
    if (o) next.outpoint = `${tx.txid}_${o.n}`;
  }
  const keyed = tx.vin.filter((v) => v.pubkey);
  const src = keyed.find((v) => `${v.txid}_${v.vout}` === norm(item.asset.id)) ?? keyed[0];
  if (src?.pubkey && !item.senderKey) next.senderKey = src.pubkey;
  if (!next.from && next.senderKey) {
    const addr = addressOfKey(next.senderKey);
    if (addr && !own.has(addr)) {
      next.from = addr;
      if (item.asset.kind === 'nft' && item.issuer === item.asset.id) next.issuer = addr;
    }
  }
  return next;
};

/** An account on this device, as the sender matcher needs it. */
export type DeviceAccount = { identityAddress: string; addresses: string[]; pubKeys: string[] };

/** The identity address of the device account that sent `item` (by address or key), or null. */
export const deviceSender = (item: Pick<AirdropItem, 'from' | 'senderKey'>, accounts: DeviceAccount[]) => {
  const key = item.senderKey?.toLowerCase();
  const hit = accounts.find(
    (a) =>
      (!!item.from && a.addresses.includes(item.from)) || (!!key && a.pubKeys.some((k) => k.toLowerCase() === key)),
  );
  return hit?.identityAddress ?? null;
};

const shortAddr = (s: string) => (s.length > 16 ? `${s.slice(0, 6)}…${s.slice(-6)}` : s);

/** "$vexvoid" from a paymail / handle, else the short address (never the NFT's own outpoint when we know better). */
export const senderLabel = (name: string | null | undefined, item: Pick<AirdropItem, 'from' | 'issuer'>): string => {
  const n = (name ?? '').split('@')[0].replace(/^\$/, '').trim();
  return n ? `$${n}` : shortAddr(item.from || item.issuer);
};

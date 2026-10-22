/**
 * bDNSx domain link record (v1): the one DNS proof the ecosystem uses (bDNSx.com, dns-dex.com, bWalletX).
 * TXT at `_bdnsx.<domain>` = `bdnsx1 key=<identityKey> sig=<base64 DER>`, where sig is the wallet's
 * createSignature(protocol [2,'bdnsx link'], keyID '1', counterparty 'anyone') over linkMessage(). Anyone can
 * check it without asking a server; removing the record revokes the link.
 */
import { ProtoWallet, Utils } from '@bsv/sdk';

export const LINK_PROTOCOL: [2, string] = [2, 'bdnsx link'];
export const LINK_KEY_ID = '1';

export const linkTxtHost = (domain: string) => `_bdnsx.${domain}`;

/** Exactly the bytes the wallet signs; `domain` must already be normalised. */
export const linkMessage = (domain: string, identityKey: string) =>
  `bdnsx-link|v1|domain=${domain}|identityKey=${identityKey}`;

export const formatLinkValue = (identityKey: string, signatureBase64: string) =>
  `bdnsx1 key=${identityKey} sig=${signatureBase64}`;

const VALUE = /^bdnsx1 key=(0[23][0-9a-f]{64}) sig=([A-Za-z0-9+/]+={0,2})$/;

/** One record's text (already joined from its quoted chunks) → its key and signature, or null if malformed. */
export function parseLinkValue(text: string): { identityKey: string; signature: string } | null {
  const m = VALUE.exec(text);
  return m ? { identityKey: m[1], signature: m[2] } : null;
}

const verifier = new ProtoWallet('anyone');

/** Does `signature` (base64 DER) prove `identityKey` links `domain`? Never throws. */
export async function verifyLink(domain: string, identityKey: string, signature: string): Promise<boolean> {
  try {
    const { valid } = await verifier.verifySignature({
      data: Utils.toArray(linkMessage(domain, identityKey), 'utf8'),
      signature: Utils.toArray(signature, 'base64'),
      protocolID: LINK_PROTOCOL,
      keyID: LINK_KEY_ID,
      counterparty: identityKey,
    });
    return valid;
  } catch {
    return false;
  }
}

/** Is any of `records` (record texts, chunks joined) a valid link of `domain` to `identityKey`? */
export async function recordsLinkTo(records: string[], domain: string, identityKey: string): Promise<boolean> {
  for (const text of records) {
    const p = parseLinkValue(text);
    if (p && p.identityKey === identityKey && (await verifyLink(domain, identityKey, p.signature))) return true;
  }
  return false;
}

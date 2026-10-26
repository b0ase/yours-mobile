import { deriveDepositAddresses, type OneSatContext } from '@1sat/actions';
import { Random, Utils, type WalletInterface } from '@bsv/sdk';
import { KYC_CERT_TYPE } from './config';

/**
 * b-Aware payout proof (policy v4): a reward of 1 BSV or more is paid only to an address the
 * KYC-certified identity key has signed for. This file makes the one JSON file the reporter sends:
 *   { certificate: <public BRC-52 cert>, proof: { address, date, signature, scheme } }
 * Checked byte for byte by bwalletx-admin server/kyc.js (verifyCert + verifyAddressProof).
 *
 * Safety:
 *  - Only the fixed message `bwalletx b-aware payout address <address> <date>` is ever signed.
 *    There is no parameter for free text: the address must be a P2PKH address and the date YYYY-MM-DD.
 *  - The certificate is exported as its public part only (no keyring, no field-reveal keys).
 *  - Signing goes through the BRC-100 wallet (createSignature), so no private key is touched here.
 */

export const PAYOUT_PROOF_SCHEME = 'bwx-payout' as const;

/**
 * Wallet-only protocol (reserved in reservedProtocolList.ts), so no outside app can get a payout proof signed.
 * BRC-77 "message signing" stays open to apps. Layout is BRC-77's (version, signer, 0, keyID, sig), signed to anyone.
 */
export const PAYOUT_PROOF_PROTOCOL: [2, string] = [2, 'bwalletx payout proof'];
const PROOF_VERSION = [0x42, 0x42, 0x33, 0x01];

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** True for a mainnet P2PKH address (base58check, version 0x00, 20-byte hash). */
export const isP2pkhAddress = (address: string): boolean => {
  if (!/^1[1-9A-HJ-NP-Za-km-z]{24,33}$/.test(address)) return false;
  try {
    const { prefix, data } = Utils.fromBase58Check(address);
    return Array.isArray(prefix) && prefix.length === 1 && prefix[0] === 0 && data.length === 20;
  } catch {
    return false;
  }
};

/** Today's date (UTC) as YYYY-MM-DD. */
export const proofDate = (nowMs = Date.now()) => new Date(nowMs).toISOString().slice(0, 10);

/**
 * The exact text that is signed. Same as kyc.js addressProofMessage. Throws on anything that is
 * not a P2PKH address + a real date, so no other text can reach the signer through this function.
 */
export const payoutAddressMessage = (address: string, date: string): string => {
  if (!isP2pkhAddress(address)) throw new Error('That is not a valid BSV address.');
  if (!DATE_RE.test(date) || Number.isNaN(Date.parse(date))) throw new Error('Bad date.');
  return `bwalletx b-aware payout address ${address} ${date}`;
};

/** The public part of a BRC-52 certificate: exactly what kyc.js verifyCert reads. */
export interface PublicCertificate {
  type: string;
  serialNumber: string;
  subject: string;
  certifier: string;
  revocationOutpoint: string;
  signature: string;
  fields: Record<string, string>;
}

/** Copies only the public fields. keyring, keyringForSubject, verifier etc. never get through. */
export const publicCertificate = (c: PublicCertificate & Record<string, unknown>): PublicCertificate => ({
  type: String(c.type),
  serialNumber: String(c.serialNumber),
  subject: String(c.subject),
  certifier: String(c.certifier),
  revocationOutpoint: String(c.revocationOutpoint),
  signature: String(c.signature),
  fields: Object.fromEntries(Object.entries(c.fields ?? {}).map(([k, v]) => [String(k), String(v)])),
});

export interface PayoutProof {
  address: string;
  date: string;
  signature: string;
  scheme: typeof PAYOUT_PROOF_SCHEME;
}

export interface PayoutProofFile {
  certificate: PublicCertificate;
  proof: PayoutProof;
}

/**
 * Sign the fixed payout-address message with the wallet's identity key under PAYOUT_PROOF_PROTOCOL, to anyone,
 * in BRC-77 byte layout (hex). kyc.js verifies it with the same protocol.
 */
export const signPayoutAddress = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  address: string,
  date: string,
): Promise<PayoutProof> => {
  const message = payoutAddressMessage(address, date);
  const { publicKey } = await wallet.getPublicKey({ identityKey: true });
  const keyID = Random(32);
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(message, 'utf8'),
    protocolID: PAYOUT_PROOF_PROTOCOL,
    keyID: Utils.toBase64(keyID),
    counterparty: 'anyone',
  });
  const bytes = [...PROOF_VERSION, ...Utils.toArray(publicKey, 'hex'), 0, ...keyID, ...signature];
  return { address, date, signature: Utils.toHex(bytes), scheme: PAYOUT_PROOF_SCHEME };
};

/** The wallet's stored bit-sign KYC certificate (public part), the one with this serial if given. */
export const storedKycCertificate = async (
  wallet: Pick<WalletInterface, 'listCertificates'>,
  certifiers: string[],
  serialNumber?: string,
): Promise<PublicCertificate | null> => {
  if (!certifiers.length) return null;
  const { certificates } = await wallet.listCertificates({ certifiers, types: [KYC_CERT_TYPE], limit: 20 });
  const c = certificates.find((x) => !serialNumber || x.serialNumber === serialNumber);
  return c ? publicCertificate(c as unknown as PublicCertificate & Record<string, unknown>) : null;
};

/** This wallet's receive address (deposit address 0, the one address sync always watches). */
export const walletReceiveAddress = async (ctx: OneSatContext): Promise<string> => {
  const { derivations } = await deriveDepositAddresses.execute(ctx, { startIndex: 0, count: 1 });
  const a = derivations[0]?.address;
  if (!a) throw new Error("Couldn't get a receive address from this wallet.");
  return a;
};

/** True when the address is one of this wallet's first `count` deposit addresses. */
export const isOwnAddress = async (ctx: OneSatContext, address: string, count = 20): Promise<boolean> => {
  const { derivations } = await deriveDepositAddresses.execute(ctx, { startIndex: 0, count });
  return derivations.some((d) => d.address === address);
};

export const payoutProofFile = (certificate: PublicCertificate, proof: PayoutProof): PayoutProofFile => ({
  certificate: publicCertificate(certificate as PublicCertificate & Record<string, unknown>),
  proof: { address: proof.address, date: proof.date, signature: proof.signature, scheme: proof.scheme },
});

export const payoutProofFileName = (date: string) => `b-aware-payout-proof-${date}.json`;

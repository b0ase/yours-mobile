/**
 * Exchange › Contracts (SMART-WALLET-SPEC.md §8): a contract is sold as a PUBLIC 1Sat NFT (content type
 * CONTRACT_CONTENT_TYPE) so buyers can read and audit it before paying. The envelope carries the contract's
 * descriptor (`bwalletx.contract/1`: what it does, its network, parameters, spend paths, oracle, code hash and
 * source) plus sale terms. A buyer's copy is the same envelope inscribed again in the transaction that pays the
 * author; the catalogue (site/api/contracts.js) counts paid copies against the edition size.
 */
import { APP_NAME } from '../storeBuild';

export const CONTRACT_CONTENT_TYPE = 'application/vnd.bwalletx.contract+json';
export const CONTRACT_ENVELOPE_FORMAT = 'bwalletx.contract-nft/1';
export const CONTRACT_DISCLAIMER = `Contracts are programs. Read what each one does before you use it; ${APP_NAME} doesn’t review, rate or recommend them.`;

export type ContractDescriptor = {
  format: 'bwalletx.contract/1';
  name: string;
  version: string;
  network: 'testnet' | 'mainnet';
  summary: string;
  params?: Record<string, string | number>;
  spendPaths?: { name: string; who: string; requires: string }[];
  oracle?: { quorum: number; signers: string[] };
  source?: string;
  codeHash?: string;
};

export type ContractEnvelope = {
  format: typeof CONTRACT_ENVELOPE_FORMAT;
  contract: ContractDescriptor;
  description: string;
  author: { name: string; address: string };
  sale: { priceUsd: number; copies: number; payTo: string };
};

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** Validate a contract descriptor (contract.json). Errors are listed, never defaulted. */
export const parseDescriptor = (
  input: unknown,
): { ok: true; contract: ContractDescriptor } | { ok: false; errors: string[] } => {
  let o: Record<string, unknown>;
  try {
    o = (typeof input === 'string' ? JSON.parse(input) : input) as Record<string, unknown>;
  } catch {
    return { ok: false, errors: ['Not valid JSON'] };
  }
  const errors: string[] = [];
  if (o?.format !== 'bwalletx.contract/1') errors.push('format must be "bwalletx.contract/1"');
  const name = str(o?.name, 60);
  const version = str(o?.version, 20);
  const summary = str(o?.summary, 1000);
  if (!name) errors.push('name is required');
  if (!version) errors.push('version is required');
  if (!summary) errors.push('summary is required');
  if (o?.network !== 'testnet' && o?.network !== 'mainnet') errors.push('network must be "testnet" or "mainnet"');
  if (errors.length) return { ok: false, errors };
  const paths = Array.isArray(o.spendPaths)
    ? (o.spendPaths as Record<string, unknown>[])
        .slice(0, 20)
        .map((p) => ({ name: str(p?.name, 40), who: str(p?.who, 80), requires: str(p?.requires, 300) }))
    : undefined;
  const params =
    o.params && typeof o.params === 'object'
      ? Object.fromEntries(
          Object.entries(o.params as Record<string, unknown>)
            .slice(0, 30)
            .filter(([, v]) => typeof v === 'string' || typeof v === 'number')
            .map(([k, v]) => [k.slice(0, 40), typeof v === 'string' ? v.slice(0, 120) : v]),
        )
      : undefined;
  const or = o.oracle as { quorum?: unknown; signers?: unknown } | undefined;
  const oracle =
    or && Number.isInteger(or.quorum) && Array.isArray(or.signers)
      ? {
          quorum: or.quorum as number,
          signers: (or.signers as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 20),
        }
      : undefined;
  return {
    ok: true,
    contract: {
      format: 'bwalletx.contract/1',
      name,
      version,
      network: o.network as ContractDescriptor['network'],
      summary,
      ...(params && { params: params as Record<string, string | number> }),
      ...(paths?.length && { spendPaths: paths }),
      ...(oracle && { oracle }),
      ...(str(o.source, 300) && { source: str(o.source, 300) }),
      ...(/^[0-9a-f]{64}$/.test(str(o.codeHash, 64)) && { codeHash: str(o.codeHash, 64) }),
    },
  };
};

export const contractEnvelope = (
  contract: ContractDescriptor,
  meta: { description: string; author: { name: string; address: string }; sale: ContractEnvelope['sale'] },
): ContractEnvelope => ({
  format: CONTRACT_ENVELOPE_FORMAT,
  contract,
  description: meta.description.trim().slice(0, 1000),
  author: { name: meta.author.name.slice(0, 40), address: meta.author.address },
  sale: meta.sale,
});

export const contractSaleProblems = (env: ContractEnvelope): string[] => {
  const out: string[] = [];
  if (!env.description.trim()) out.push('Add a description');
  if (!(env.sale.priceUsd >= 0 && env.sale.priceUsd <= 10_000)) out.push('Price must be between $0 and $10,000');
  if (!(Number.isInteger(env.sale.copies) && env.sale.copies >= 1 && env.sale.copies <= 100_000))
    out.push('Copies must be 1–100,000');
  if (!/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(env.sale.payTo)) out.push('No payout address');
  return out;
};

import { Utils } from '@bsv/sdk';

/**
 * Settings › Linked wallets (bChatX #533, "link a wallet on another chain"). Identity only: the user signs a plain
 * text message with MetaMask / Phantom / TronLink to prove the address is theirs. No transaction, no approval, no
 * allowance; nothing is moved or held, and the wallet spends no sats. The link is private to the user and bChatX.
 *
 * Routes (bit-sign src/app/api/bitsign/identity/connect/wallet, authenticated by the bChatX session bearer that
 * resolveUserHandle accepts):
 *   POST /challenge {chain, address} → {message}
 *   POST /verify {chain, address, message, signature}
 *   GET  /        → {links: [{id, chain, address, verified_at}]}
 *   DELETE /?id=  → unlink
 * Signatures (bit-sign lib/chain-wallet-link.ts): eth/bnb EIP-191 personal_sign hex; trx signMessageV2 hex;
 * sol ed25519 base58.
 */
export type LinkChain = 'eth' | 'bnb' | 'sol' | 'trx';
export const LINK_CHAINS: readonly LinkChain[] = ['eth', 'bnb', 'sol', 'trx'];
export const CHAIN_LABEL: Record<LinkChain, string> = {
  eth: 'Ethereum',
  bnb: 'BNB Chain',
  sol: 'Solana',
  trx: 'TRON',
};
export type LinkedWallet = { id: string; chain: LinkChain; address: string; verifiedAt: string };

export const LINK_PATH = '/api/bitsign/identity/connect/wallet';
/** Where the Link card lives on bChatX, for builds that can't reach a browser wallet (extension popup, phone). */
export const BCHATX_ACCOUNT_URL = 'https://www.bchatx.com/user/account';
export const KINTSUGI_URL = 'https://www.bchatx.com/user/kintsugi';
export const PRIVATE_NOTE = 'Private: only you and bChatX can see this link.';

/** The bChatX JSON call (BchatClient.request). */
export type Requester = (
  method: 'GET' | 'POST' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
) => Promise<unknown>;

const isChain = (v: unknown): v is LinkChain => typeof v === 'string' && (LINK_CHAINS as readonly string[]).includes(v);

export const parseLinks = (data: unknown): LinkedWallet[] => {
  const links = (data as { links?: unknown } | null)?.links;
  if (!Array.isArray(links)) return [];
  return links.flatMap((l) => {
    const r = l as Record<string, unknown>;
    if (typeof r?.id !== 'string' || !isChain(r.chain) || typeof r.address !== 'string') return [];
    return [{ id: r.id, chain: r.chain, address: r.address, verifiedAt: String(r.verified_at ?? '') }];
  });
};

export const listLinks = async (req: Requester) => parseLinks(await req('GET', LINK_PATH));

export const unlink = async (req: Requester, id: string) => {
  await req('DELETE', `${LINK_PATH}?id=${encodeURIComponent(id)}`);
};

export const shortAddress = (a: string) => (a.length > 14 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a);

export const linkDate = (iso: string, locale = 'en-GB') => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleDateString(locale, { day: 'numeric', month: 'short', year: 'numeric' });
};

// ── Browser wallets (no EVM/Solana libraries: the injected providers only) ──────────────────────────────────

type Eip1193 = { request(a: { method: string; params?: unknown[] }): Promise<unknown> };
type Phantom = {
  solana?: {
    connect(): Promise<{ publicKey: { toString(): string } }>;
    signMessage(m: Uint8Array, enc?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
  };
};
type TronWeb = {
  defaultAddress?: { base58?: string | false };
  trx: { signMessageV2(m: string): Promise<string> };
};
export type Providers = { ethereum?: Eip1193; phantom?: Phantom; tronWeb?: TronWeb; tronLink?: Eip1193 };

export const providersOf = (w: unknown): Providers => {
  const g = (w ?? {}) as Record<string, unknown>;
  return {
    ethereum: g.ethereum as Eip1193 | undefined,
    phantom: g.phantom as Phantom | undefined,
    tronWeb: g.tronWeb as TronWeb | undefined,
    tronLink: g.tronLink as Eip1193 | undefined,
  };
};

/** Chains this page can sign for in place. Empty in the extension popup and the phone app: they open bChatX. */
export const inPlaceChains = (p: Providers): LinkChain[] => [
  ...(p.ethereum ? (['eth', 'bnb'] as const) : []),
  ...(p.phantom?.solana ? (['sol'] as const) : []),
  ...(p.tronWeb ? (['trx'] as const) : []),
];

const utf8Hex = (s: string) => '0x' + Utils.toHex(Utils.toArray(s, 'utf8'));

export type ChainSigner = { address(): Promise<string>; sign(message: string, address: string): Promise<string> };

export const signerFor = (chain: LinkChain, p: Providers): ChainSigner | null => {
  if ((chain === 'eth' || chain === 'bnb') && p.ethereum) {
    const eth = p.ethereum;
    return {
      address: async () => {
        const a = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
        if (!a?.[0]) throw new Error('No account was shared');
        return a[0];
      },
      sign: async (m, a) => String(await eth.request({ method: 'personal_sign', params: [utf8Hex(m), a] })),
    };
  }
  if (chain === 'sol' && p.phantom?.solana) {
    const sol = p.phantom.solana;
    return {
      address: async () => (await sol.connect()).publicKey.toString(),
      sign: async (m) => {
        const r = await sol.signMessage(new Uint8Array(Utils.toArray(m, 'utf8')), 'utf8');
        const sig = r instanceof Uint8Array ? r : r.signature;
        return Utils.toBase58(Array.from(sig));
      },
    };
  }
  if (chain === 'trx' && p.tronWeb) {
    const tw = p.tronWeb;
    return {
      address: async () => {
        await p.tronLink?.request({ method: 'tron_requestAccounts' }).catch(() => undefined);
        const a = tw.defaultAddress?.base58;
        if (!a) throw new Error('Unlock TronLink and try again');
        return a;
      },
      sign: async (m) => tw.trx.signMessageV2(m),
    };
  }
  return null;
};

/** Challenge → sign in the browser wallet → verify. One message signature, nothing else. */
export const linkInPlace = async (req: Requester, chain: LinkChain, signer: ChainSigner): Promise<void> => {
  const address = await signer.address();
  const ch = (await req('POST', `${LINK_PATH}/challenge`, { chain, address })) as { message?: unknown };
  if (typeof ch?.message !== 'string' || !ch.message) throw new Error('bChatX did not return a message to sign');
  const signature = await signer.sign(ch.message, address);
  if (!signature) throw new Error('The wallet did not sign');
  await req('POST', `${LINK_PATH}/verify`, { chain, address, message: ch.message, signature });
};

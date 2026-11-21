import { PushDrop, ProtoWallet, Transaction, Utils, type LockingScript } from '@bsv/sdk';
import { IDENTITY_FIELD, P1SAT_PROTOCOL, opnsRegisterKeyId } from '@1sat/types';
import { fieldPairs, isIdentityKey } from '@1sat/utils';

/**
 * Second opinions on an OpNS index answer (b-Aware opns-indexer: rows 213, 71, 77, 251, 313, 336, 367, 388).
 *
 * The OpNS index (GorillaPool) says who holds a name: an owner address, the outpoint holding it, its origin and
 * maybe an `opns.idKey`. One server's word was enough to pay that address and to say "Verified on chain". Now:
 *
 *  1. WhatsOnChain: the outpoint's transaction exists, its output is a 1-sat ordinal that pays the owner, and
 *     nothing has spent it.
 *  2. The 1sat-stack name index (api.1sat.app, a different service): the name's registered origin, and the origin
 *     of the inscription at that outpoint (ORDFS), are both the origin the first index gave. Without this a lying
 *     index could point at any unspent coin the attacker holds.
 *  3. The key: only an identity binding on the owner output that its key signed (registerOpns's PushDrop) counts.
 *
 * Any source that answers and contradicts another refuses ('refused'). Sources that can't be reached, or don't
 * know the name yet, leave it 'index': payable as before, but labelled "From the OpNS index", never "Verified on
 * chain". Only when all of 1 and 2 agree is it 'chain'; `idKey` is set only when 3 holds.
 */

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

export const OPNS_CHECK_SERVICES = {
  woc: 'https://api.whatsonchain.com/v1/bsv/main',
  opnsOrigin: 'https://api.1sat.app/1sat/opns/origin',
  ordfsMetadata: 'https://api.1sat.app/1sat/ordfs/metadata',
};

export type OpnsIndexAnswer = { name: string; owner: string; outpoint?: string; origin?: string; idKey?: string };

export type OpnsChainCheck =
  /** 'chain': sources 1 and 2 agree. `keySigned`: `idKey` came from a binding its key signed on the owner output. */
  { status: 'chain' | 'index'; idKey?: string; keySigned: boolean } | { status: 'refused'; reason: string };

export const opnsMismatch = (name: string) =>
  `The name index's answer for "${name}" doesn't match the chain, so it may be wrong or tampered with. Not paying it.`;
export const opnsMoved = (name: string) =>
  `"${name}" has moved since the name index last looked, so its new holder isn't known yet. Not paying it. Try again in a few minutes.`;

const HEX64 = /^[0-9a-f]{64}$/i;

/** `txid_vout` / `txid.vout` → [txid, vout], or undefined when it isn't one. */
const splitOutpoint = (o: string | undefined): [string, number] | undefined => {
  const m = String(o ?? '').match(/^([0-9a-f]{64})[._](\d{1,6})$/i);
  return m ? [m[1].toLowerCase(), Number(m[2])] : undefined;
};
const sameOutpoint = (a: string | undefined, b: string | undefined) => {
  const x = splitOutpoint(a);
  const y = splitOutpoint(b);
  return !!x && !!y && x[0] === y[0] && x[1] === y[1];
};

const get = async (f: Fetch, url: string): Promise<Response | null> => {
  try {
    return await f(url, { credentials: 'omit' });
  } catch {
    return null;
  }
};
const json = async (r: Response | null): Promise<Record<string, unknown> | null> => {
  if (!r?.ok) return null;
  const j = (await r.json().catch(() => null)) as unknown;
  return j && typeof j === 'object' ? (j as Record<string, unknown>) : null;
};

/** P2PKH hash of a mainnet address, or undefined. */
const addressHash = (address: string): string | undefined => {
  try {
    const { prefix, data } = Utils.fromBase58Check(address, 'hex');
    const p = typeof prefix === 'string' ? prefix : Utils.toHex(prefix);
    return p === '00' && typeof data === 'string' && data.length === 40 ? data : undefined;
  } catch {
    return undefined;
  }
};

const pushDropOf = (script: LockingScript) => {
  try {
    return PushDrop.decode(script);
  } catch {
    return undefined;
  }
};

/** Does this output pay `owner`: a P2PKH to it (alone or inside an inscription), or a PushDrop locked to its key. */
const paysOwner = (script: LockingScript, owner: string): boolean => {
  const h = addressHash(owner);
  if (!h) return false;
  if (script.toHex().toLowerCase().includes(`76a914${h.toLowerCase()}88ac`)) return true;
  const pd = pushDropOf(script);
  return !!pd && pd.lockingPublicKey.toAddress() === owner;
};

/**
 * The identity key of a registerOpns binding on this output, only when the binding's signature and lock key both
 * check out against that identity for one of the tx's inputs (the bind key id is the spent name outpoint).
 * 'none' = no binding here; 'bad' = a binding whose signature doesn't verify.
 */
export const signedBindingKey = async (tx: Transaction, vout: number): Promise<string | 'none' | 'bad'> => {
  const out = tx.outputs[vout];
  const pd = out && pushDropOf(out.lockingScript);
  if (!pd || pd.fields.length < 3) return 'none';
  const fields = pd.fields.map((x) => [...x]);
  const signature = fields.pop() as number[];
  let identity: string | undefined;
  try {
    const ids = fieldPairs(fields).filter(([k]) => k === IDENTITY_FIELD);
    if (ids.length !== 1 || !isIdentityKey(ids[0][1])) return 'none';
    identity = Utils.toHex(ids[0][1]);
  } catch {
    return 'none';
  }
  // The binder signed with counterparty 'anyone'; a verifier is 'anyone' naming the binder (BRC-42 symmetry).
  const anyone = new ProtoWallet('anyone');
  const lockKey = pd.lockingPublicKey.toString();
  for (const input of tx.inputs) {
    const src = input.sourceTXID ?? input.sourceTransaction?.id('hex');
    if (!src) continue;
    const keyID = opnsRegisterKeyId(`${src}.${input.sourceOutputIndex}`);
    const args = { protocolID: P1SAT_PROTOCOL as never, keyID, counterparty: identity };
    try {
      const { publicKey } = await anyone.getPublicKey(args);
      if (publicKey !== lockKey) continue;
      const { valid } = await anyone.verifySignature({ ...args, data: fields.flat(), signature });
      if (valid) return identity;
    } catch {
      /* try the next input */
    }
  }
  return 'bad';
};

/** Check an OpNS index answer against WhatsOnChain and the 1sat-stack name index. Never throws. */
export const checkOpnsOnChain = async (
  f: Fetch,
  a: OpnsIndexAnswer,
  s: typeof OPNS_CHECK_SERVICES = OPNS_CHECK_SERVICES,
): Promise<OpnsChainCheck> => {
  const refused = (reason: string): OpnsChainCheck => ({ status: 'refused', reason });
  const at = splitOutpoint(a.outpoint);
  if (!at) return { status: 'index', idKey: a.idKey, keySigned: false };
  const [txid, vout] = at;
  const [hexRes, spentRes, nameOrigin, held] = await Promise.all([
    get(f, `${s.woc}/tx/${txid}/hex`),
    get(f, `${s.woc}/tx/${txid}/${vout}/spent`),
    get(f, `${s.opnsOrigin}/${encodeURIComponent(a.name)}`).then(json),
    get(f, `${s.ordfsMetadata}/${txid}_${vout}:-2`).then(json),
  ]);

  // 2. Which inscription is this, and is it the name? Contradictions refuse; silence leaves it 'index'.
  const registered = typeof nameOrigin?.outpoint === 'string' ? nameOrigin.outpoint : undefined;
  const heldOrigin = typeof held?.origin === 'string' ? held.origin : undefined;
  if (registered && a.origin && !sameOutpoint(registered, a.origin)) return refused(opnsMismatch(a.name));
  const expected = registered ?? a.origin;
  if (heldOrigin && expected && !sameOutpoint(heldOrigin, expected)) return refused(opnsMismatch(a.name));
  let confirmed = !!registered && !!heldOrigin;

  // 1. The coin itself.
  let tx: Transaction | undefined;
  if (hexRes?.ok) {
    const raw = (await hexRes.text().catch(() => '')).trim();
    try {
      if (/^[0-9a-f]+$/i.test(raw)) {
        const t = Transaction.fromHex(raw);
        if (t.id('hex') === txid) tx = t;
      }
    } catch {
      /* unreadable answer: unknown */
    }
  }
  if (tx) {
    const out = tx.outputs[vout];
    if (!out || out.satoshis !== 1 || !paysOwner(out.lockingScript, a.owner)) return refused(opnsMismatch(a.name));
  } else confirmed = false;
  if (spentRes?.ok) {
    const j = await json(spentRes);
    if (typeof j?.txid === 'string' && HEX64.test(j.txid)) return refused(opnsMoved(a.name));
    confirmed = false;
  } else if (spentRes?.status !== 404) confirmed = false;

  // 3. The key: only a binding its key signed, on this very output.
  let idKey: string | undefined;
  if (tx) {
    const bound = await signedBindingKey(tx, vout);
    if (bound !== 'none' && bound !== 'bad') {
      if (a.idKey && a.idKey.toLowerCase() !== bound.toLowerCase()) return refused(opnsMismatch(a.name));
      idKey = bound;
    }
  }
  // An index-only key stays (payable as before) but is never called verified.
  return { status: confirmed ? 'chain' : 'index', idKey: idKey ?? a.idKey, keySigned: !!idKey };
};

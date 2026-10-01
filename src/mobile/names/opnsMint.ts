import { OpNS } from '@1sat/templates';
import { OPNS_BASKET, P1SAT_PROTOCOL } from '@1sat/types';
import { buildOrdinalCustomInstructions, executeTrackedAction, type OneSatContext } from '@1sat/actions';
import { Beef, P2PKH, PublicKey, Script, Transaction, Utils, type CreateActionArgs } from '@bsv/sdk';
import { SERVICES, type Fetch } from './names';

/**
 * OpNS mint: one transaction per character, following the covenant's fixed layout
 * (BitcoinSchema/1sat-ordinals name-service/opns.md):
 *
 *   input 0   the live mine-tree node for the prefix (1 sat, keyless covenant unlock)
 *   input 1+  wallet funding
 *   output 0  the node restated: char marked claimed, pow = solution hash  (1 sat)
 *   output 1  the child node for prefix+char, claimed = 0x00, pow = solution  (1 sat)
 *   output 2  the name inscription prefix+char, locked to our ordinal key   (1 sat)
 *   output 3+ change (pushed raw into the unlock as "trailing outputs")
 *
 * Scripts come from @1sat/templates OpNS (lock / claimBit / buildInscription / unlock).
 * The wallet funds and signs via executeTrackedAction (createAction → signAction), so
 * the standard wallet broadcast path is used.
 */

export const OPNS_CHARSET = /^[a-z0-9-]+$/;
const OPNS_CONTENT_TYPE = 'application/op-ns';

export type MineNode = { outpoint: string; domain: string };

/** GET /1sat/opns/mine/:name → nearest mined prefix (null when the name is taken or no prefix is found). */
export const fetchMineNode = async (f: Fetch, name: string): Promise<MineNode | null> => {
  const res = await f(`${SERVICES.opnsMine}/${encodeURIComponent(name)}`);
  if (!res.ok) return null;
  const j = await res.json().catch(() => null);
  if (!j?.outpoint || typeof j.domain !== 'string') return null;
  return { outpoint: String(j.outpoint), domain: j.domain };
};

export const isTaken = async (f: Fetch, name: string): Promise<boolean> => {
  const res = await f(`${SERVICES.opnsOrigin}/${encodeURIComponent(name)}`);
  if (!res.ok) return false;
  const j = await res.json().catch(() => null);
  return !!j?.outpoint;
};

export const parseOutpoint = (op: string) => {
  const [txid, v] = op.replace('_', '.').split('.');
  return { txid, vout: Number(v) };
};

export type MintPlan = {
  char: number;
  newDomain: string;
  restated: Script;
  child: Script;
  inscription: Script;
};

/** The three covenant-mandated outputs for mining `char` from `node` with solution `hash`. */
export const buildMintOutputs = (
  node: { claimed: number[]; domain: string },
  char: number,
  hash: number[],
  ownerScript: Script,
): MintPlan => {
  const newDomain = node.domain + String.fromCharCode(char);
  return {
    char,
    newDomain,
    restated: OpNS.lock(OpNS.claimBit(node.claimed, char), node.domain, hash),
    child: OpNS.lock([0], newDomain, hash),
    inscription: OpNS.buildInscription(newDomain, ownerScript),
  };
};

const pushLen = (n: number) => (n < 0x4c ? 1 : n <= 0xff ? 2 : n <= 0xffff ? 3 : 5) + n;
const varIntLen = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);

/**
 * Upper bound for the covenant unlock: char + nonce + ownerScript + trailing outputs
 * (`maxTrailing` P2PKH change outputs) + BIP-143 preimage (which embeds the node's script).
 * The wallet only rejects an unlock longer than this, so overestimating is safe (slightly higher fee).
 */
export const estimateUnlockLength = (parentScriptLen: number, ownerScriptLen: number, maxTrailing = 4) => {
  const preimage = 4 + 32 + 32 + 36 + varIntLen(parentScriptLen) + parentScriptLen + 8 + 4 + 32 + 4 + 4;
  const trailing = maxTrailing * (8 + 1 + 25);
  return pushLen(1) + pushLen(32) + pushLen(ownerScriptLen) + pushLen(trailing) + pushLen(preimage);
};

/** Fee estimate per character at `satsPerKb` (default 100 sat/kB, the wallet's usual rate). */
export const estimateMintFee = (parentScriptLen: number, satsPerKb = 100) => {
  const unlock = estimateUnlockLength(parentScriptLen, 25, 1);
  // two node outputs (~ parent size each) + inscription + funding input + change + overhead
  const bytes = 10 + (41 + unlock) + (148 + 34) + 2 * (9 + parentScriptLen + 40) + 120;
  return Math.ceil((bytes * satsPerKb) / 1000) + 3; // + the three 1-sat outputs
};

export type LoadedNode = {
  outpoint: string;
  beef: number[];
  tx: Transaction;
  vout: number;
  state: { claimed: number[]; domain: string; pow: number[] };
};

/** Load the node tx (BEEF) and decode its covenant state. */
export const loadNode = async (ctx: OneSatContext, outpoint: string, beefHint?: number[]): Promise<LoadedNode> => {
  const { txid, vout } = parseOutpoint(outpoint);
  let beef: Beef;
  if (beefHint) beef = Beef.fromBinary(beefHint);
  else {
    if (!ctx.services) throw new Error('No network services to fetch the name tree');
    beef = await ctx.services.getBeefForTxid(txid);
  }
  const tx = beef.findTxid(txid)?.tx;
  if (!tx) throw new Error('Name tree transaction not found');
  const state = OpNS.decode(tx.outputs[vout].lockingScript);
  if (!state) throw new Error('Not an OpNS node');
  return { outpoint: `${txid}.${vout}`, beef: beef.toBinary(), tx, vout, state };
};

export type MintStepResult = { txid: string; tx?: number[]; newDomain: string; childOutpoint: string };

/**
 * Build, sign and broadcast one character mint. `nonce`/`hash` come from the worker.
 * The new name's inscription goes to the wallet's OPNS basket (tag `origin` = this outpoint).
 */
export const mintStep = async (
  ctx: OneSatContext,
  node: LoadedNode,
  char: number,
  nonce: number[],
  hash: number[],
): Promise<MintStepResult> => {
  const keyID = node.outpoint;
  const { publicKey } = await ctx.wallet.getPublicKey({
    protocolID: P1SAT_PROTOCOL,
    keyID,
    counterparty: 'self',
    forSelf: true,
  });
  const ownerScript = new P2PKH().lock(PublicKey.fromString(publicKey).toAddress());
  const plan = buildMintOutputs(node.state, char, hash, ownerScript);
  const tags = ['opns', `type:${OPNS_CONTENT_TYPE}`, 'origin', `name:${plan.newDomain}`];
  const parentScript = node.tx.outputs[node.vout].lockingScript;

  const args: CreateActionArgs = {
    description: `Mine OpNS ${plan.newDomain}`.slice(0, 50),
    inputBEEF: node.beef,
    inputs: [
      {
        outpoint: node.outpoint,
        inputDescription: 'OpNS name tree node',
        unlockingScriptLength: estimateUnlockLength(parentScript.toBinary().length, ownerScript.toBinary().length),
      },
    ],
    outputs: [
      { lockingScript: plan.restated.toHex(), satoshis: 1, outputDescription: 'OpNS node (restated)' },
      { lockingScript: plan.child.toHex(), satoshis: 1, outputDescription: 'OpNS node (child)' },
      {
        lockingScript: plan.inscription.toHex(),
        satoshis: 1,
        outputDescription: `OpNS name ${plan.newDomain}`.slice(0, 50),
        basket: OPNS_BASKET,
        tags,
        customInstructions: buildOrdinalCustomInstructions({
          protocolID: P1SAT_PROTOCOL,
          keyID,
          counterparty: 'self',
          tags,
          name: plan.newDomain,
        }),
      },
    ],
    options: { randomizeOutputs: false, acceptDelayedBroadcast: false },
  };

  const res = await executeTrackedAction(ctx.wallet, args, undefined, node.beef, async (tx: Transaction) => {
    const idx = tx.inputs.findIndex(
      (i) =>
        (i.sourceTXID ?? i.sourceTransaction?.id('hex')) === node.tx.id('hex') && i.sourceOutputIndex === node.vout,
    );
    if (idx < 0) throw new Error('Name tree input missing from the transaction');
    if (!tx.inputs[idx].sourceTransaction) tx.inputs[idx].sourceTransaction = node.tx;
    const unlock = await OpNS.unlock(char, nonce, ownerScript).sign(tx, idx);
    return { [idx]: { unlockingScript: unlock.toHex() } };
  });
  if ('error' in res && res.error) throw new Error(String(res.error));
  if (!res.txid) throw new Error('Mint was not broadcast');
  return {
    txid: res.txid,
    tx: res.tx,
    newDomain: plan.newDomain,
    childOutpoint: `${res.txid}.1`,
  };
};

/** Random 27-byte nonce prefix for a mining job. */
export const randomPrefix = () => Array.from(crypto.getRandomValues(new Uint8Array(27)));

export const toHex = (b: number[]) => Utils.toHex(b);

/**
 * Burn-on-entry tickets, Phase 0 prototype (see docs/TICKETS-BURN-PHASE0.md).
 *
 * Pure builders only: nothing here signs, funds or broadcasts. The wallet's
 * createAction (or a raw @bsv/sdk Transaction) supplies inputs, fee funding
 * and signatures.
 *
 * Method A (recommended): a BSV-21 `burn` inscription output
 *   {"p":"bsv-20","op":"burn","id":<id>,"amt":"N"} with NO locking suffix.
 * The script is `OP_0 OP_IF 'ord' ... OP_ENDIF`, which leaves an empty stack,
 * so the output is provably unspendable. 1sat-stack admits it as a burn and
 * debits it against the inputs (pkg/bsv21/topic_validated.go).
 *
 * Method B (fallback): a normal `transfer` of N whose suffix is
 * OP_FALSE OP_RETURN. Also unspendable, but indexers see a transfer, not a burn.
 */
import { BSV21, MAP } from '@1sat/templates';
import { LockingScript, OP, P2PKH, Script } from '@bsv/sdk';

export type BurnMethod = 'op-burn' | 'unspendable-transfer';

export interface TicketBurnOutput {
  lockingScript: string;
  satoshis: number;
  outputDescription: string;
  role: 'burn' | 'change' | 'overlay-fee' | 'entry-map';
}

export interface BuildTicketBurnInput {
  /** BSV-21 token id, `txid_vout`. */
  tokenId: string;
  /** Raw amount to burn (N per entry). */
  burnRaw: bigint;
  /** Sum of the raw amounts of the selected token inputs. */
  inputRaw: bigint;
  /** Where token change goes (the wallet's own derived P2PKH). Required when inputRaw > burnRaw. */
  changeLockingScript?: LockingScript;
  method?: BurnMethod;
  /** 1sat-stack overlay fee (token status.fee_address / fee_per_output). One per token output. */
  overlayFee?: { address: string; perOutput: number };
  /** Optional MAP tag linking the entry to a bChat handle. */
  entry?: { channel: string; handle: string };
}

/** OP_FALSE OP_RETURN: the Method B suffix. */
export function unspendableSuffix(): LockingScript {
  return new LockingScript([{ op: OP.OP_FALSE }, { op: OP.OP_RETURN }]);
}

export function buildTicketBurnOutputs(input: BuildTicketBurnInput): TicketBurnOutput[] {
  const { tokenId, burnRaw, inputRaw, method = 'op-burn' } = input;
  if (burnRaw <= 0n) throw new Error('burnRaw must be positive');
  if (inputRaw < burnRaw) throw new Error('insufficient token inputs');
  const change = inputRaw - burnRaw;
  if (change > 0n && !input.changeLockingScript) {
    throw new Error('changeLockingScript required when there is change');
  }

  const outputs: TicketBurnOutput[] = [];
  const burnScript =
    method === 'op-burn'
      ? BSV21.burn(tokenId, burnRaw).lock()
      : BSV21.transfer(tokenId, burnRaw).lock(unspendableSuffix());
  outputs.push({
    lockingScript: burnScript.toHex(),
    satoshis: 1,
    outputDescription: `Burn ${burnRaw} ticket(s)`,
    role: 'burn',
  });

  if (change > 0n && input.changeLockingScript) {
    outputs.push({
      lockingScript: BSV21.transfer(tokenId, change).lock(input.changeLockingScript).toHex(),
      satoshis: 1,
      outputDescription: 'Ticket change',
      role: 'change',
    });
  }

  const fee = input.overlayFee;
  if (fee && fee.perOutput > 0) {
    const tokenOutputs = outputs.length;
    outputs.push({
      lockingScript: new P2PKH().lock(fee.address).toHex(),
      satoshis: fee.perOutput * tokenOutputs,
      outputDescription: 'Overlay indexing fee',
      role: 'overlay-fee',
    });
  }

  if (input.entry) {
    const map = MAP.set({
      app: 'bWallet',
      type: 'room-entry',
      channel: input.entry.channel,
      handle: input.entry.handle,
    });
    outputs.push({
      lockingScript: new Script()
        .writeOpCode(OP.OP_FALSE)
        // MAP.set() already starts with OP_RETURN.
        .writeScript(map)
        .toHex(),
      satoshis: 0,
      outputDescription: 'Room entry tag',
      role: 'entry-map',
    });
  }
  return outputs;
}

/** Sum of burned raw amount for `tokenId` in a list of output scripts (verifier-side helper). */
export function burnedRawInScripts(tokenId: string, scripts: Script[], method: BurnMethod = 'op-burn'): bigint {
  let total = 0n;
  for (const s of scripts) {
    const t = BSV21.decode(s);
    if (!t || t.getTokenId() !== tokenId) continue;
    if (method === 'op-burn' && t.isBurn()) total += t.getAmount();
    if (method === 'unspendable-transfer' && t.operation() === 'transfer') {
      const tail = s.chunks.slice(-2);
      if (tail[0]?.op === OP.OP_FALSE && tail[1]?.op === OP.OP_RETURN) total += t.getAmount();
    }
  }
  return total;
}

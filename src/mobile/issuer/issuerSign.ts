import { applyAip, type OneSatContext } from '@1sat/actions';
import type { CreateActionArgs, WalletInterface } from '@bsv/sdk';
import {
  inscriptionTicker,
  isInscriptionScript,
  issueMapScript,
  ISSUER_KEY_ID,
  ISSUER_PROTOCOL,
  scriptSha256,
  type IssueKind,
} from './issuer';

/** What the wrapper signed (set once the next createAction ran). */
export interface IssueRecord {
  /** Index of the token output in the createAction outputs (its vout unless outputs are randomised). */
  index: number;
  scriptSha256: string;
  ticker: string | null;
  identityKey: string;
}

/**
 * Context whose wallet adds a signed issuer statement (issuer.ts) to the NEXT createAction:
 * it finds the first 1-sat inscription output (the token / NFT), hashes it, signs
 * MAP issue … with the identity key's [2,'bwallet issuer'] child via @1sat/actions applyAip
 * (the same AIP path feed posts use), and appends it as a 0-sat OP_RETURN output.
 *
 * Never blocks a mint: if there is no inscription output, or signing fails, the action goes
 * ahead unsigned (the token then shows as "Unverified issuer").
 */
export function withIssuerSignature(
  ctx: OneSatContext,
  kind: IssueKind,
  onSigned?: (r: IssueRecord) => void,
): OneSatContext {
  let done = false;
  const base = ctx.wallet as WalletInterface;
  const wallet = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'createAction' && !done) {
        return async (args: CreateActionArgs, originator?: string) => {
          done = true;
          const outs = args.outputs ?? [];
          const index = outs.findIndex((o) => o.satoshis === 1 && isInscriptionScript(o.lockingScript));
          if (index < 0) return target.createAction(args, originator);
          try {
            const { publicKey: identityKey } = await target.getPublicKey({ identityKey: true });
            const tokenHex = outs[index].lockingScript;
            const rec: IssueRecord = {
              index,
              scriptSha256: scriptSha256(tokenHex),
              ticker: kind === 'bsv21' ? inscriptionTicker(tokenHex) : null,
              identityKey,
            };
            const unsigned = issueMapScript({ kind, ticker: rec.ticker, scriptSha256: rec.scriptSha256, identityKey });
            const signed = await applyAip(
              { ...ctx, wallet: target } as OneSatContext,
              unsigned,
              ISSUER_PROTOCOL,
              ISSUER_KEY_ID,
              'anyone',
            );
            onSigned?.(rec);
            return target.createAction(
              {
                ...args,
                outputs: [
                  ...outs,
                  { lockingScript: signed.toHex(), satoshis: 0, outputDescription: 'Issuer signature (MAP + AIP)' },
                ],
              },
              originator,
            );
          } catch (e) {
            console.warn('[issuer] could not sign issuer statement; minting unsigned:', e);
            return target.createAction(args, originator);
          }
        };
      }
      const v = Reflect.get(target, prop, receiver);
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { ...ctx, wallet } as OneSatContext;
}

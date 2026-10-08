import type { OneSatContext } from '@1sat/actions';
import type { BchatClient } from './api';
import type { ClaimDeps } from './autoClaim';
import { issuerCandidates } from './holdings';
import { findKeyFor, signBsmWith } from './issuerKey';

/** The live wiring for claimIssuerAdmin: bit-sign's challenge, this wallet's keys. */
export const claimDepsFor = (client: BchatClient, ctx: OneSatContext): ClaimDeps => ({
  issuerChallenge: (t) => client.issuerChallenge(t),
  claimIssuer: (t, m, s) => client.claimIssuer(t, m, s),
  findKey: async (address) => findKeyFor(ctx.wallet, address, await issuerCandidates(ctx)),
  sign: (key, message) => signBsmWith(ctx.wallet, key, message),
});

/**
 * BSV-21 balances minus Quarantine (quarantine.ts). Every UI list, send picker, agent view and sweep goes through
 * this instead of getBsv21Balances directly, so quarantined tokens are never shown as yours or spent with your coins.
 */
import { getBsv21Balances, type Bsv21Balance } from '@1sat/actions';
import { activeQuarantine } from './inbox';
import { withoutQuarantined } from './quarantine';

type Ctx = Parameters<typeof getBsv21Balances.execute>[0];

export const heldBsv21Balances = async (ctx: Ctx): Promise<Bsv21Balance[]> =>
  withoutQuarantined(await getBsv21Balances.execute(ctx, {}), activeQuarantine());

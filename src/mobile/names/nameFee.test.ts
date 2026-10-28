import { describe, expect, test } from 'bun:test';
import { PrivateKey, Script } from '@bsv/sdk';
import { checkPaymentOutputs } from '../../utils/guardedSendBsv';
import serverFee from '../../../site/lib/nameFee.js';
import { nameFeeRequests } from './nameFee';

/** b-Aware 27 Oct 2026 (hilmiadi677, F-165): the app's fee tx commits to the claimant key and alias the server checks. */
describe('name fee commitment', () => {
  const key = PrivateKey.fromRandom().toPublicKey().toString();
  const fee = { address: '1BitcoinEaterAddressDontSendf59kuE', usd: 10 };

  test('the OP_RETURN the app builds is exactly what the server requires', () => {
    const [, commit] = nameFeeRequests(fee, 20_000, key, 'AbCd');
    // Upstream sendBsv builds data requests as OP_0 OP_RETURN <pushes>.
    const script = Script.fromASM(`OP_0 OP_RETURN ${commit.data!.join(' ')}`).toHex();
    expect(script).toBe(serverFee.feeCommitHex(key, 'abcd'));
  });

  test('the payment guard accepts the fee plus the 1-sat commitment', () => {
    const reqs = nameFeeRequests(fee, 20_000, key, 'abcd');
    const outs = [
      { satoshis: 20_000, outputDescription: 'Payment of 20000 sats' },
      { satoshis: 1, outputDescription: 'Payment of 1 sats' },
    ];
    expect(checkPaymentOutputs(reqs, outs)).toBeNull();
  });
});

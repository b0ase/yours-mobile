/**
 * P0, 20 Nov 2026 (RB's bit-sign seal on 5.2.59, twice, ~17:22Z and ~17:57Z): Allow on the one Seal sheet answered the
 * seal "denied", so createSignature returned ERR_PERMISSION_DENIED and bit-sign said "You cancelled in your wallet".
 *
 * Cause: ae664e79 (13 Nov) stopped pre-ticking "keys every app shares" (isSharedKeyRequest: a level-2 protocol for
 * counterparty 'anyone'). The Seal sheet's synthetic line is exactly that shape ([2,'bitsign seal'], 'anyone'), and
 * the Seal sheet draws no tick (BundleSheet hides the lines behind SealSheetBody), so its Allow sent `false` for the
 * only line on it. The background then rejected the seal with userDeniedError().
 *
 * This drives the sheet's own pure path (buildSheetModel → approvalKindForSheet → sheetView → sheetAnswer) for the
 * request background.ts askSealSheet builds.
 */
import { describe, expect, test } from 'bun:test';
import { approvalKindForSheet } from './approvalKind';
import { buildSheetModel, sheetAnswer, sheetHash, sheetView, shownItems, type BundleRequest } from './permissionBundle';
import { SEAL_MAX_SATS, SEAL_PROTOCOL, SEAL_REQUEST_PREFIX } from './sealPass';

/** The request background.ts askSealSheet puts on the sheet (two fields, as RB's ROOM7 instrument). */
const sealRequest = (id = `${SEAL_REQUEST_PREFIX}mi7abc-0`): BundleRequest =>
  ({
    requestID: id,
    type: 'protocol',
    originator: 'bitsign.network',
    protocolID: [...SEAL_PROTOCOL],
    counterparty: 'anyone',
    reason: 'Seal this document',
    seal: {
      title: 'Seal this document',
      ref: '92d27ccc-0000-0000-0000-000000000000',
      docHash: 'ab'.repeat(32),
      handle: 'b0asex',
      roles: ['Owner', 'Company'],
      maxSats: SEAL_MAX_SATS,
      site: 'bitsign.network',
    },
  }) as unknown as BundleRequest;

const answerFor = (items: BundleRequest[], choice: 'allow' | 'notNow') => {
  const model = buildSheetModel({ originator: 'bitsign.network', items });
  const kind = approvalKindForSheet(model);
  const careful = kind === 'careful';
  const detailsSeen = !careful;
  const view = sheetView(model, careful, careful && !detailsSeen ? new Set<string>() : undefined, kind);
  const answer = sheetAnswer(model, choice, {}, detailsSeen, view);
  const seen = sheetHash(choice === 'allow' ? shownItems(items, view) : items);
  return { model, kind, answer, seenMatches: seen === sheetHash(items) };
};

describe('the one Seal sheet', () => {
  test('Allow grants the seal (it was answered denied since ae664e79)', () => {
    const req = sealRequest();
    const { answer, seenMatches, kind } = answerFor([req], 'allow');
    expect(kind).not.toBe('careful');
    expect(seenMatches).toBe(true);
    expect(answer.decisions[req.requestID]).toBe(true);
  });

  test('Not now still declines it (the only path that may say ERR_PERMISSION_DENIED)', () => {
    const req = sealRequest();
    expect(answerFor([req], 'notNow').answer.decisions[req.requestID]).toBe(false);
  });

  test('an ordinary level-2 "anyone" protocol line is still not pre-ticked (ae664e79 stands)', () => {
    const plain = { ...sealRequest('req-plain'), seal: undefined } as BundleRequest;
    const line = buildSheetModel({ originator: 'bitsign.network', items: [plain] }).lines[0];
    expect(line.checked).toBe(false);
  });

  test('a seal line that is not alone on its sheet is not pre-ticked (ordinary lines show, ticks decide)', () => {
    const other = { ...sealRequest('req-other'), seal: undefined, protocolID: [1, 'other app'] } as BundleRequest;
    const seal = sealRequest();
    const model = buildSheetModel({ originator: 'bitsign.network', items: [seal, other] });
    expect(model.lines.find((l) => l.requestID === seal.requestID)?.checked).toBe(false);
  });

  test('a site cannot dress a request as a seal: only the wallet-made seal- id counts', () => {
    const forged = sealRequest('req-from-site');
    expect(buildSheetModel({ originator: 'bitsign.network', items: [forged] }).lines[0].checked).toBe(false);
  });
});

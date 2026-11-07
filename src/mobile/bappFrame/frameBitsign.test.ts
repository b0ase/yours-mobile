import { describe, expect, test } from 'bun:test';
import { handleBitsignCall } from '../pair/bitsign';
import { bitsignToXdm, parseFrameBitsignRequest, withFrameCapabilities } from './frameBitsign';

const BCHAT = 'https://chat.bwalletx.com';
const H = 'ab'.repeat(32);
const draw = (args: unknown = { origin: BCHAT, docHash: H, title: 'Brief' }) => ({
  type: 'CWI',
  isInvocation: true,
  id: 'r1',
  call: 'bitsign.drawSignature',
  args,
});

describe('frameBitsign', () => {
  test('bChatX origins only', () => {
    expect(parseFrameBitsignRequest(draw(), BCHAT)).toEqual({
      id: 'r1',
      call: 'bitsign.drawSignature',
      args: draw().args,
    });
    expect(parseFrameBitsignRequest(draw(), 'https://www.bchatx.com')).not.toBeNull();
    expect(parseFrameBitsignRequest(draw(), 'https://evil.example')).toBeNull();
  });

  test('only bitsign.* invocations', () => {
    expect(parseFrameBitsignRequest({ ...draw(), call: 'createSignature' }, BCHAT)).toBeNull();
    expect(parseFrameBitsignRequest({ ...draw(), isInvocation: false }, BCHAT)).toBeNull();
    expect(parseFrameBitsignRequest({ ...draw(), id: '' }, BCHAT)).toBeNull();
    expect(parseFrameBitsignRequest('x', BCHAT)).toBeNull();
  });

  test('drawn → success with the svg; cancelled → declined; bad args → INVALID_PARAMS', async () => {
    const path = 'M10 10L200 120L400 60Z';
    const ok = bitsignToXdm(
      'r1',
      await handleBitsignCall('bitsign.drawSignature', draw().args, BCHAT, async () => path),
    );
    expect(ok.status).toBe('success');
    expect((ok as { result: { svg: string; width: number; height: number } }).result.width).toBe(1000);
    const no = bitsignToXdm(
      'r1',
      await handleBitsignCall('bitsign.drawSignature', draw().args, BCHAT, async () => null),
    );
    expect(no).toMatchObject({ status: 'error', code: 'ERR_PERMISSION_DENIED', description: 'declined' });
    const bad = bitsignToXdm(
      'r1',
      await handleBitsignCall(
        'bitsign.drawSignature',
        { origin: 'https://evil.example', docHash: H, title: 'x' },
        BCHAT,
      ),
    );
    expect(bad).toMatchObject({ status: 'error', code: 'INVALID_PARAMS' });
  });

  test('capabilities', async () => {
    expect(bitsignToXdm('c', await handleBitsignCall('bitsign.capabilities', {}, BCHAT))).toMatchObject({
      status: 'success',
      result: { drawSignature: true },
    });
  });
});

describe('frame capabilities for bChatX', () => {
  // bit-sign's frame sign-in (frame-session-client.ts) reads `frameSession` from bitsign.capabilities; for a bChatX
  // origin that call is answered here (the pad), so the frame's own flags must ride along.
  test('the pad answer carries frameSession and keeps drawSignature: true', async () => {
    const reply = withFrameCapabilities(
      'bitsign.capabilities',
      await handleBitsignCall('bitsign.capabilities', {}, BCHAT),
    );
    expect(reply).toMatchObject({ result: { drawSignature: true, review: true, frameSession: true } });
  });
  test('a drawing answer is untouched', async () => {
    const r = await handleBitsignCall('bitsign.drawSignature', draw().args, BCHAT, async () => null);
    expect(withFrameCapabilities('bitsign.drawSignature', r)).toEqual(r);
  });
});

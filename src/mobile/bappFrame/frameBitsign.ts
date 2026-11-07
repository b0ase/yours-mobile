/**
 * bit-sign phone signing for a FRAMED bChatX page (pair/bitsign.ts is the paired-relay twin): the page asks the
 * wallet for the native signature pad over XDM and gets back only the drawing, never keys or money.
 *
 *   page → wallet  { type: 'CWI', isInvocation: true, id, call: 'bitsign.drawSignature',
 *                    args: { origin, docHash, title, ref?, fieldLabel?, signerHandle? } }
 *   wallet → page  { type: 'CWI', isInvocation: false, id, status: 'success', result: { svg, width: 1000, height: 250 } }
 *              or  { type: 'CWI', isInvocation: false, id, status: 'error', description, code }
 *                  (code 'ERR_PERMISSION_DENIED' + 'declined' on Cancel; 'INVALID_PARAMS' on bad args)
 *
 * `bitsign.capabilities` answers { drawSignature: true }. bChatX origins only. PURE: frameBitsign.test.ts.
 *
 * The full-screen dApp browser has no parent to post to: there the page calls window.CWI.bitsign(call, args)
 * (dapp/provider.ts), the native bridge brings it here with the WebView's own origin, and answerDappBitsign gives
 * the same answer in the browser's { success, data } shape (dappBitsign.test.ts).
 */
import { BCHAT_ORIGINS } from '../../services/bchatOrigin';
import { FRAME_BITSIGN_CAPABILITIES } from './frameBridge';
import {
  BAD_REQUEST_CODE,
  BITSIGN_CAPABILITIES,
  BITSIGN_DRAW,
  askDrawSignature,
  handleBitsignCall,
  isBitsignAction,
  type BitsignReply,
  type DrawAnswer,
  type DrawRequest,
} from '../pair/bitsign';

const MAX_ID = 128;

export type FrameBitsignRequest = { id: string; call: string; args: unknown };

/** A bitsign.* XDM invocation from a bChatX origin, or null (anything else goes to the normal CWI path). */
export const parseFrameBitsignRequest = (data: unknown, origin: string): FrameBitsignRequest | null => {
  if (!(BCHAT_ORIGINS as readonly string[]).includes(origin)) return null;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (d.type !== 'CWI' || d.isInvocation !== true) return null;
  if (typeof d.id !== 'string' || d.id.length === 0 || d.id.length > MAX_ID) return null;
  if (typeof d.call !== 'string' || !isBitsignAction(d.call)) return null;
  return { id: d.id, call: d.call, args: d.args ?? {} };
};

/**
 * In the frame, bitsign.capabilities from bChatX is answered by the pad (drawSignature: true), but bChatX's frame
 * sign-in reads `frameSession` from the same answer (bit-sign frame-session-client.ts): add the frame's own flags.
 */
export const withFrameCapabilities = (call: string, reply: BitsignReply): BitsignReply =>
  call === BITSIGN_CAPABILITIES && 'result' in reply
    ? { result: { ...FRAME_BITSIGN_CAPABILITIES, ...(reply.result as Record<string, unknown>) } }
    : reply;

/** handleBitsignCall's reply as an XDM response. */
export const bitsignToXdm = (id: string, reply: BitsignReply) =>
  'result' in reply
    ? ({ type: 'CWI', isInvocation: false, id, status: 'success', result: reply.result } as const)
    : ({
        type: 'CWI',
        isInvocation: false,
        id,
        status: 'error',
        description: reply.error.message,
        code: reply.error.code,
      } as const);

export type DappBitsignReply = { success: true; data: unknown } | { success: false; error: string; code?: string };

// One pad at a time from the browser: a second draw while one is open is refused, not queued behind it.
let dappDrawing = false;

/**
 * A bitsign.* call from the dApp browser, or null when `type` is not one (the normal CWI path then). `origin` is the
 * native WebView's main-frame origin, never the page's say-so. `cover` steps the browser aside while the pad is up
 * (it draws in the wallet WebView, underneath); `ask` shows the pad (tests pass their own).
 */
export const answerDappBitsign = async (
  origin: string,
  type: string,
  params: unknown,
  deps: { ask?: (req: DrawRequest) => Promise<DrawAnswer>; cover?: (on: boolean) => void } = {},
): Promise<DappBitsignReply | null> => {
  if (!isBitsignAction(type)) return null;
  if (!(BCHAT_ORIGINS as readonly string[]).includes(origin))
    return { success: false, error: `Unsupported request: ${type}` };
  const draw = type === BITSIGN_DRAW;
  if (draw && dappDrawing) return { success: false, error: 'A signature pad is already open', code: BAD_REQUEST_CODE };
  const ask = deps.ask ?? askDrawSignature;
  if (draw) dappDrawing = true;
  let reply: BitsignReply;
  try {
    reply = await handleBitsignCall(type, params, origin, async (req) => {
      deps.cover?.(true);
      try {
        return await ask(req);
      } finally {
        deps.cover?.(false);
      }
    });
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    if (draw) dappDrawing = false;
  }
  return 'result' in reply
    ? { success: true, data: reply.result }
    : { success: false, error: reply.error.message, code: reply.error.code };
};

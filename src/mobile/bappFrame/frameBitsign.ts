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
 */
import { BCHAT_ORIGINS } from '../../services/bchatOrigin';
import { isBitsignAction, type BitsignReply } from '../pair/bitsign';

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

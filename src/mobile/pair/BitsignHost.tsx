import { useEffect, useMemo, useState } from 'react';
import { SignaturePad } from '../signature/SignaturePad';
import {
  DRAW_REVIEW,
  answerDrawRequest,
  currentDrawRequest,
  drawRequestSeq,
  keepDrawing,
  onDrawRequest,
  shortHash,
  takeKeptDrawing,
} from './bitsign';

const hostOf = (origin: string) => {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
};

/**
 * Shows the pad for a paired site's bitsign.drawSignature (bitsign.ts), one request at a time. Done sends the
 * drawing back; Cancel, Back or close is "declined". Nothing is signed with keys or put on-chain here.
 * Lengthwise on a landscape phone with the buttons on the right (SignaturePad sideways, owner 7 Nov 2026). A page that
 * takes Review gets the Review button and "Sign & seal": Review answers { action: 'review' } and keeps the drawing for
 * that page's next ask on the same document.
 */
export function BitsignHost() {
  const [req, setReq] = useState(currentDrawRequest);
  useEffect(() => {
    const f = () => setReq(currentDrawRequest());
    f();
    return onDrawRequest(f);
  }, []);
  // Taken once per request (its sequence number): the drawing kept over this page's last Review, if any.
  const seq = drawRequestSeq();
  const kept = useMemo(() => (req ? takeKeptDrawing(req) : undefined), [req, seq]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!req) return null;
  const who = req.signerHandle ? (req.signerHandle.startsWith('$') ? req.signerHandle : `$${req.signerHandle}`) : '';
  return (
    <SignaturePad
      key={seq}
      sideways
      initialStrokes={kept}
      onCancel={() => answerDrawRequest(null)}
      onSave={(path) => answerDrawRequest(path)}
      onReview={
        req.review
          ? (strokes) => {
              keepDrawing(req, strokes);
              answerDrawRequest(DRAW_REVIEW);
            }
          : undefined
      }
      saveLabel={req.review ? 'Sign & seal' : 'Done'}
      note={
        req.review
          ? `Sends only this drawing to ${hostOf(req.origin)}. You approve the seal and its fee next.`
          : `Sends only this drawing to ${hostOf(req.origin)}. No keys, no payment.`
      }
      details={
        <div className="bw-sigpad-doc">
          <strong>{req.title || 'Document'}</strong>
          {req.ref && <span>Ref {req.ref}</span>}
          {req.fieldLabel && <span>{req.fieldLabel}</span>}
          <span>Document {shortHash(req.docHash)}</span>
          {who && <span>Sign as {who}</span>}
        </div>
      }
    />
  );
}

export default BitsignHost;

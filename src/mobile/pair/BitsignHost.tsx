import { useEffect, useState } from 'react';
import { SignaturePad } from '../signature/SignaturePad';
import { answerDrawRequest, currentDrawRequest, drawRequestSeq, onDrawRequest, shortHash } from './bitsign';

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
 */
export function BitsignHost() {
  const [req, setReq] = useState(currentDrawRequest);
  useEffect(() => {
    const f = () => setReq(currentDrawRequest());
    f();
    return onDrawRequest(f);
  }, []);
  if (!req) return null;
  const who = req.signerHandle ? (req.signerHandle.startsWith('$') ? req.signerHandle : `$${req.signerHandle}`) : '';
  return (
    <SignaturePad
      key={drawRequestSeq()}
      onCancel={() => answerDrawRequest(null)}
      onSave={(path) => answerDrawRequest(path)}
      saveLabel="Done"
      note={`Sends only this drawing to ${hostOf(req.origin)}. No keys, no payment.`}
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

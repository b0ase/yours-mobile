/**
 * Read a letter I sent (owner, 28 Oct 2026: "I can't open it up to see it and read what I sent").
 *
 * The letter itself goes out BRC-2 sealed to the recipient. The sender's copy is the plaintext kept in this wallet's
 * local bMail store (store.ts `Sent`), the same way an opened received letter is kept (`Received.opened`). It never
 * leaves the device: nothing here sends, syncs or uploads it. Letters sent before a copy was kept (or whose copy is
 * not on this device) say so plainly instead of showing a blank.
 */
import type { Sent } from './store';
import { NO_SENT_COPY, sentAttachments, sentBody } from './sentCopy';

const MUTED = '#98A2B3';

export const SentReader = ({ s, money }: { s: Sent; money: (sats: number) => string }) => {
  const body = sentBody(s);
  const files = sentAttachments(s);
  const postage = Math.max(0, s.sats - s.replyPaidSats);
  return (
    <div className="flex flex-col gap-3" data-testid="sent-reader">
      <div className="bw-mail-card p-4 flex flex-col gap-1.5">
        <div className="text-sm text-white font-semibold">To {s.toLabel}</div>
        <div className="text-[11px] break-all" style={{ color: MUTED }}>
          {s.to}
        </div>
        <div className="text-[11px]" style={{ color: MUTED }}>
          Sent {new Date(s.at).toLocaleString()}
        </div>
        <div className="text-[11px]" style={{ color: MUTED }}>
          {s.sats ? `Postage ${money(postage)}` : 'No stamp'}
          {s.replyPaidSats > 0 ? ` · Reply paid ${money(s.replyPaidSats)}` : ''}
        </div>
        {s.txid && (
          <a
            href={`https://whatsonchain.com/tx/${s.txid}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] break-all underline"
            style={{ color: '#667085' }}
          >
            Postage tx {s.txid}
          </a>
        )}
      </div>
      <div className="bw-mail-card bw-mail-letter flex flex-col gap-3">
        <div className="text-lg font-bold text-white">{s.subject || '(no subject)'}</div>
        {body ? (
          <div className="bw-mail-body whitespace-pre-wrap break-words">{body}</div>
        ) : (
          <p className="text-xs m-0" style={{ color: MUTED }}>
            {NO_SENT_COPY}
          </p>
        )}
        {files.length > 0 && (
          <div className="flex flex-col gap-1">
            <div className="text-[11px] font-semibold" style={{ color: MUTED }}>
              Attached
            </div>
            {files.map((f) => (
              <div key={f} className="text-xs text-white">
                {f}
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="text-[11px] m-0" style={{ color: MUTED }}>
        Your copy. Sealed to {s.toLabel} when sent; this copy stays on this device.
      </p>
    </div>
  );
};

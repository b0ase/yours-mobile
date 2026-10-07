import { ArrowDownToLine, ArrowUpFromLine } from 'lucide-react';
import { Sheet } from './Sheet';
import type { WalletAction } from './walletAction';

/** The dock's Send/Receive: a small launcher for the wallet's own Send and Receive screens. */
export const SendReceiveSheet = ({ onPick, onClose }: { onPick: (a: WalletAction) => void; onClose: () => void }) => (
  <Sheet label="Send or receive" onClose={onClose}>
    <p className="text-base font-bold text-white">Send or receive</p>
    <div className="flex gap-3">
      <SendReceiveButtons onPick={onPick} />
    </div>
    <button onClick={onClose} className="py-2 text-sm text-[#98A2B3] bg-transparent border-0">
      Cancel
    </button>
  </Sheet>
);

/** The two buttons, shared with HOME (which always shows them: the safeguard if the dock is empty). */
export const SendReceiveButtons = ({ onPick }: { onPick: (a: WalletAction) => void }) => (
  <>
    <button
      type="button"
      onClick={() => onPick('receive')}
      className="flex flex-1 items-center justify-center gap-2 py-3 rounded-2xl font-semibold text-sm border-0"
      style={{ background: 'linear-gradient(135deg, #FFD24D, #F5B800)', color: '#010101' }}
    >
      <ArrowDownToLine size={16} strokeWidth={2.5} />
      Receive
    </button>
    <button
      type="button"
      onClick={() => onPick('send')}
      className="flex flex-1 items-center justify-center gap-2 py-3 rounded-2xl font-semibold text-sm border-0"
      style={{ background: 'linear-gradient(135deg, #FFD24D, #F5B800)', color: '#010101' }}
    >
      <ArrowUpFromLine size={16} strokeWidth={2.5} />
      Send
    </button>
  </>
);

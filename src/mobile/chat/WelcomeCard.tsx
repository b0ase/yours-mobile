import { FileSignature, Info, MessageCircle, UserPlus } from 'lucide-react';
import bGlyph from '../brand/bwallet-glyph.svg';

/**
 * b's welcome in a new room (as on bchatx.com; logic in roomWelcome.ts). One line and a few buttons; a button
 * is hidden when this room can't do it. None of them spends or signs: Invite opens the invite sheet, "Make an
 * agreement" puts a /b request in the composer for b to draft, Room info opens the info sheet.
 */
const GOLD = 'var(--bw-accent-hi)';
const PANEL = '#121316';
const LINE = '#1f2127';
const MUTED = '#8a8f98';

export const WelcomeCard = ({
  onInvite,
  onAgreement,
  onInfo,
  onDismiss,
}: {
  onInvite: (() => void) | null;
  onAgreement: (() => void) | null;
  onInfo: (() => void) | null;
  onDismiss: () => void;
}) => {
  const btn = 'flex items-center gap-2 rounded-2xl px-3.5 py-2.5 text-left text-[14px] font-semibold active:opacity-70';
  const plain = { border: `1px solid ${LINE}`, color: '#F2F2F0', background: 'transparent' };
  return (
    <div className="my-3 flex w-full max-w-md items-start gap-2 self-start">
      <img src={bGlyph} alt="" width={28} height={28} className="mt-1 shrink-0" />
      <div
        className="min-w-0 flex-1 rounded-[20px] rounded-tl-md p-3.5"
        style={{ background: PANEL, border: `1px solid ${LINE}` }}
      >
        <p className="text-[15px] leading-snug text-white m-0">
          Hi, I’m{' '}
          <span className="font-semibold" style={{ color: GOLD }}>
            b
          </span>
          , bWalletX’s assistant. What’s this room for?
        </p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {onInvite && (
            <button type="button" onClick={onInvite} className={btn} style={{ background: GOLD, color: '#1a1300' }}>
              <UserPlus size={17} /> Invite someone
            </button>
          )}
          {onAgreement && (
            <button type="button" onClick={onAgreement} className={btn} style={plain}>
              <FileSignature size={17} /> Make an agreement
            </button>
          )}
          {onInfo && (
            <button type="button" onClick={onInfo} className={btn} style={plain}>
              <Info size={17} /> Room info
            </button>
          )}
          <button type="button" onClick={onDismiss} className={btn} style={{ ...plain, color: MUTED }}>
            <MessageCircle size={17} /> Just chat
          </button>
        </div>
      </div>
    </div>
  );
};

import { FileSignature } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useBureau } from './useBureau';
import { countFolders } from './folders';

/**
 * bMail's sixth box: Agreements (owner, 18 Oct 2026). Same look as the five mailbox buttons; the badge counts what
 * needs my signature. Opens /m/bmail/agreements. bWalletX only (lazy, behind BUREAU_ENABLED).
 */
const AgreementsBox = ({ gold }: { gold: string }) => {
  const navigate = useNavigate();
  const b = useBureau();
  const n = countFolders(b.items, b.me).needs;
  return (
    <button
      type="button"
      aria-label={n ? `Agreements, ${n} need your signature` : 'Agreements'}
      onClick={() => navigate('/m/bmail/agreements')}
      className="relative h-[60px] w-full flex flex-col items-center justify-center gap-0.5 rounded-xl px-1 py-1.5 text-[10px] font-semibold"
      style={{ border: '1px solid #2b2f36', color: '#fff' }}
    >
      <FileSignature size={18} aria-hidden="true" />
      <span className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap">Agreements</span>
      {n > 0 && (
        <span
          className="absolute top-1 right-1 min-w-[16px] rounded-full px-1 text-[9px] font-bold leading-4 text-center"
          style={{ background: gold, color: '#1a1300' }}
        >
          {n > 99 ? '99+' : n}
        </span>
      )}
    </button>
  );
};

export default AgreementsBox;

import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import {
  BACKUP_FULL_NOTICE,
  STORAGE_PAY_REFUSED_NOTICE,
  clearTopUpRefused,
  readTopUpRefused,
  type TopUpRefused,
} from '../services/storagePaymentGuard';

/**
 * Settings › Storage: a lasting warning while an online store is full and its top-up was refused
 * (services/storagePaymentGuard.ts). The balance card's sync line only shows it for a moment.
 */
export const TopUpRefusedNotice = () => {
  const [refused, setRefused] = useState<TopUpRefused | undefined>();
  useEffect(() => {
    let live = true;
    readTopUpRefused()
      .then((r) => live && setRefused(r))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  if (!refused) return null;
  return (
    <div
      className="w-full rounded-xl p-4"
      style={{ background: 'rgba(249,112,102,0.06)', border: '1px solid rgba(249,112,102,0.2)' }}
    >
      <div className="flex items-start gap-2.5">
        <AlertTriangle size={16} style={{ color: '#F97066' }} className="shrink-0 mt-0.5" />
        <div className="flex-1">
          <p className="text-xs font-semibold mb-1" style={{ color: '#F97066' }}>
            {refused.kind === 'backup' ? 'Online backup is full' : 'Online storage is full'}
          </p>
          <p className="text-[10px] leading-relaxed" style={{ color: '#D0D5DD' }}>
            {refused.kind === 'backup' ? BACKUP_FULL_NOTICE : STORAGE_PAY_REFUSED_NOTICE}
          </p>
          <p className="text-[10px] mt-1" style={{ color: '#98A2B3' }}>
            Last seen {new Date(refused.at).toLocaleString()}
          </p>
        </div>
        <button
          type="button"
          className="text-[10px] border-0 bg-transparent cursor-pointer"
          style={{ color: '#98A2B3' }}
          onClick={() => {
            void clearTopUpRefused();
            setRefused(undefined);
          }}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
};

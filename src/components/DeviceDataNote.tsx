import { CheckCircle, Smartphone } from 'lucide-react';
import { DEVICE_DATA_NOTE, DEVICE_DATA_UP_TO_DATE } from '../services/localFirst';

/**
 * Honest copy until an account is on this device's store (P0, 3 Nov 2026; services/localFirst.ts): its change may only
 * be recoverable from this device's data. Shown in Show my 12 words and on the restore screen; once the account is on
 * this device's store it reads "Up to date".
 */
export const DeviceDataNote = ({ onDevice }: { onDevice: boolean }) => (
  <div
    role="status"
    className="rounded-xl p-3 mb-4 flex items-start gap-2 text-xs leading-relaxed"
    style={
      onDevice
        ? {
            background: 'rgba(46,125,79,0.12)',
            border: '1px solid rgba(46,125,79,0.4)',
            color: 'var(--bw-text, #FFFFFF)',
          }
        : {
            background: 'rgba(245,158,11,0.10)',
            border: '1px solid rgba(245,158,11,0.4)',
            color: 'var(--bw-text, #FFFFFF)',
          }
    }
  >
    {onDevice ? (
      <CheckCircle size={16} color="#2E7D4F" aria-hidden="true" style={{ flexShrink: 0 }} />
    ) : (
      <Smartphone size={16} color="#F59E0B" aria-hidden="true" style={{ flexShrink: 0 }} />
    )}
    <span>{onDevice ? DEVICE_DATA_UP_TO_DATE : DEVICE_DATA_NOTE}</span>
  </div>
);

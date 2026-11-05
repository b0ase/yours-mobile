import { useEffect, useState } from 'react';
import { CheckCircle, Smartphone } from 'lucide-react';
import { DEVICE_DATA_COPY, deviceDataState, type DeviceDataState } from '../services/localFirst';
import { moveStatusSend } from './moveToDevice';

type MoveAnswer =
  | {
      success?: boolean;
      data?: {
        onDevice: boolean;
        backup?: {
          backupConfigured: boolean;
          pendingPush: boolean;
          failures: number;
          lastPushOkAt: number;
          paused?: boolean;
        };
      };
    }
  | undefined;

/**
 * Where this account's records are, in plain words (P0, 3 Nov 2026; review 4 Nov 2026, F11; services/localFirst.ts):
 * still on the online backup; on this device only (keep it: the change may need its data); or Up to date (on this
 * device and in the backup, nothing waiting). Shown in Show my 12 words and on the restore screen. Without a `state`
 * it asks the wallet (STORAGE_MOVE_STATUS) and shows nothing until it knows.
 */
export const DeviceDataNote = ({
  state,
  send = moveStatusSend,
}: {
  state?: DeviceDataState;
  send?: (m: object) => Promise<MoveAnswer>;
}) => {
  const [asked, setAsked] = useState<DeviceDataState | null>(null);
  useEffect(() => {
    if (state) return;
    let live = true;
    void send({ action: 'STORAGE_MOVE_STATUS' })
      .then((r) => {
        if (!live || !r?.success || !r.data) return;
        const b = r.data.backup ?? { backupConfigured: false, pendingPush: false, failures: 0, lastPushOkAt: 0 };
        setAsked(deviceDataState({ onDevice: r.data.onDevice, ...b }));
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [state, send]);
  const s = state ?? asked;
  if (!s) return null;
  const ok = s === 'up-to-date';
  return (
    <div
      role="status"
      className="rounded-xl p-3 mb-4 flex items-start gap-2 text-xs leading-relaxed"
      style={
        ok
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
      {ok ? (
        <CheckCircle size={16} color="#2E7D4F" aria-hidden="true" style={{ flexShrink: 0 }} />
      ) : (
        <Smartphone size={16} color="#F59E0B" aria-hidden="true" style={{ flexShrink: 0 }} />
      )}
      <span>{DEVICE_DATA_COPY[s]}</span>
    </div>
  );
};

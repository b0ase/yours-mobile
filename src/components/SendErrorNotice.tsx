import { useContext, useState } from 'react';
import { BottomMenuContext } from '../contexts/BottomMenuContext';
import type { SendErrorInfo } from '../utils/sendErrors';
import { errorReportText } from '../mobile/errors/errorReport';

/**
 * A failed send, said plainly: what happened, whether money moved, what to do. The raw reason is behind Details,
 * with Copy, for support. Never a raw Chrome or toolbox string on its own (owner, 28 Oct 2026).
 */
export const SendErrorNotice = ({ info, onClose }: { info: SendErrorInfo; onClose: () => void }) => {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menu = useContext(BottomMenuContext);
  const [switchState, setSwitchState] = useState<'idle' | 'busy' | 'done' | string>('idle');
  const storageFailing = info.kind === 'storage-remote-failing';
  // One tap: the same STORAGE_SET_ACTIVE_STORAGE 'local' Settings › Storage sends (merge from the remote, then flip).
  const useThisDevice = async () => {
    setSwitchState('busy');
    try {
      const r = await chrome.runtime.sendMessage({ action: 'STORAGE_SET_ACTIVE_STORAGE', target: 'local' });
      setSwitchState(r?.success ? 'done' : String(r?.error || 'Switch failed'));
    } catch (e) {
      setSwitchState(e instanceof Error ? e.message : 'Switch failed');
    }
  };
  const openStorage = () => {
    onClose();
    menu?.handleSelect('settings', 'storage');
  };
  // Redacted, with Screen · Version · Edition · Channel appended (mobile/errors/errorReport.ts).
  const report = errorReportText(
    [
      info.message,
      `kind: ${info.kind}`,
      `money moved: ${info.moneyMoved}`,
      info.txid ? `txid: ${info.txid}` : '',
      info.detail,
    ]
      .filter(Boolean)
      .join('\n'),
  );
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setOpen(true);
    }
  };
  const btn: React.CSSProperties = {
    background: 'transparent',
    border: '1px solid rgba(255,255,255,0.35)',
    color: 'inherit',
    borderRadius: 8,
    padding: '4px 10px',
    fontSize: 12,
    cursor: 'pointer',
  };
  return (
    <div
      role="alert"
      data-testid="send-error"
      style={{
        position: 'fixed',
        left: 12,
        right: 12,
        bottom: 84,
        zIndex: 1000,
        background: '#3a1414',
        color: '#fff',
        border: '1px solid #b33',
        borderRadius: 12,
        padding: 12,
        fontSize: 13,
        lineHeight: 1.4,
        boxShadow: '0 6px 24px rgba(0,0,0,0.4)',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 4 }}>
        {info.moneyMoved === 'no' ? 'Payment not sent' : 'Payment status unclear'}
      </div>
      <div>{info.message}</div>
      {storageFailing && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 8, alignItems: 'center' }}>
          <button
            type="button"
            data-testid="use-this-device"
            style={{ ...btn, background: '#d4a017', color: '#000', border: 'none', fontWeight: 600 }}
            disabled={switchState === 'busy' || switchState === 'done'}
            onClick={useThisDevice}
          >
            {switchState === 'busy'
              ? 'Switching…'
              : switchState === 'done'
                ? 'This device is active'
                : 'Use This device'}
          </button>
          <button type="button" style={btn} onClick={openStorage}>
            Settings › Storage
          </button>
          {switchState === 'done' && <span>Now send again.</span>}
          {!['idle', 'busy', 'done'].includes(switchState) && <span>{switchState}</span>}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" style={btn} onClick={() => setOpen((o) => !o)}>
          {open ? 'Hide details' : 'Details'}
        </button>
        <button type="button" style={btn} onClick={copy}>
          {copied ? 'Copied' : 'Copy'}
        </button>
        <button type="button" style={{ ...btn, marginLeft: 'auto' }} onClick={onClose}>
          Close
        </button>
      </div>
      {open && (
        <pre
          style={{
            marginTop: 8,
            maxHeight: 160,
            overflow: 'auto',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-all',
            fontSize: 11,
            opacity: 0.85,
          }}
        >
          {report}
        </pre>
      )}
    </div>
  );
};

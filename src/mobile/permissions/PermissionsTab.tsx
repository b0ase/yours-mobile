/**
 * permissions.html (extension only): Chrome shows its mic/camera prompt in a tab but not in the
 * side panel. Allow → getUserMedia here (grants the extension origin) → stop the tracks → tell
 * the side panel to retry.
 */
import { useState } from 'react';
import { MEDIA_GRANTED } from './extensionMedia';

const kinds = new URLSearchParams(location.search).get('kinds')?.split(',') ?? ['mic'];
const wantCam = kinds.includes('camera');
const what = wantCam ? 'microphone and camera' : 'microphone';

export const PermissionsTab = () => {
  const [state, setState] = useState<'idle' | 'asking' | 'done' | 'refused'>('idle');
  const allow = async () => {
    setState('asking');
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true, video: wantCam });
      s.getTracks().forEach((t) => t.stop());
      setState('done');
      void chrome.runtime.sendMessage({ action: MEDIA_GRANTED }).catch(() => undefined);
    } catch {
      setState('refused');
    }
  };
  return (
    <main
      style={{
        minHeight: '100vh',
        background: '#050505',
        color: '#fff',
        fontFamily: 'Inter, system-ui, sans-serif',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div style={{ maxWidth: 420, textAlign: 'center' }}>
        <h1 style={{ fontSize: 22, fontWeight: 700 }}>bWalletX needs your {what}</h1>
        <p style={{ color: '#98A2B3', marginTop: 8 }}>
          For Spaces and calls. Chrome can only ask in a tab, so tap Allow and choose Allow when Chrome asks.
        </p>
        {state === 'done' ? (
          <p style={{ marginTop: 20, fontWeight: 600, color: '#FFD24D' }}>Done. Go back to bWalletX.</p>
        ) : (
          <button
            onClick={() => void allow()}
            disabled={state === 'asking'}
            style={{
              marginTop: 20,
              background: '#FFD24D',
              color: '#010101',
              border: 0,
              borderRadius: 999,
              padding: '12px 28px',
              fontWeight: 700,
              fontSize: 15,
            }}
          >
            {state === 'asking' ? 'Asking…' : 'Allow'}
          </button>
        )}
        {state === 'refused' && (
          <p style={{ color: '#F97066', marginTop: 12, fontSize: 13 }}>
            Chrome refused. Open chrome://settings/content and allow it for bWalletX, then tap Allow again.
          </p>
        )}
      </div>
    </main>
  );
};

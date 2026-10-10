import { useEffect, useState } from 'react';
import { X } from 'lucide-react';

/**
 * bWalletX extension: approval prompts (connect, sign, spend, notifications…) shown inside the side panel
 * instead of a separate popup window (owner, 6 Oct 2026). The background posts SHOW_PROMPT_PANEL /
 * HIDE_PROMPT_PANEL on the panel's 'extension-popup' port (App.tsx); this overlays prompt.html, which
 * talks to the background exactly as the window did. Closing it denies what is pending, like closing the window.
 */
type Show = { kind: string; requestID?: string };
export const PANEL_PROMPT_EVENT = 'bwx-panel-prompt';

export const PanelPrompt = () => {
  const [show, setShow] = useState<Show | null>(null);

  useEffect(() => {
    const on = (e: Event) => {
      const d = (e as CustomEvent<{ action: string } & Show>).detail;
      if (d.action === 'SHOW_PROMPT_PANEL') setShow((cur) => cur ?? { kind: d.kind, requestID: d.requestID });
      if (d.action === 'HIDE_PROMPT_PANEL' || d.action === 'SHOW_UNLOCK_PANEL') setShow(null);
    };
    window.addEventListener(PANEL_PROMPT_EVENT, on);
    return () => window.removeEventListener(PANEL_PROMPT_EVENT, on);
  }, []);

  if (!show) return null;
  const q = new URLSearchParams({ kind: show.kind, ...(show.requestID ? { requestID: show.requestID } : {}) });
  const dismiss = () => {
    setShow(null);
    chrome.runtime.sendMessage({ action: 'DISMISS_PROMPT_PANEL' }).catch(() => undefined);
  };

  return (
    <div className="fixed inset-0 z-[1000] flex flex-col" style={{ background: '#010101' }}>
      <div className="flex items-center justify-between px-3 py-2" style={{ borderBottom: '1px solid #ffffff14' }}>
        <span className="text-sm font-bold text-white">Approval needed</span>
        <button type="button" aria-label="Deny and close" onClick={dismiss} className="p-1 border-0 bg-transparent">
          <X size={18} color="#98A2B3" />
        </button>
      </div>
      <iframe
        key={`${show.kind}:${show.requestID ?? ''}`}
        title="Approval"
        src={chrome.runtime.getURL(`prompt.html?${q}`)}
        className="flex-1 w-full border-0"
      />
    </div>
  );
};

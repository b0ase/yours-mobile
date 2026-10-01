import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useBackClose } from '../backStack';
import type { MediaItem } from './useWalletMedia';

const ELLIPSIS = 'overflow-hidden text-ellipsis whitespace-nowrap';

/** Full-screen viewer for a video / image / other inscription. Portalled: parents animate with transforms. */
export const MediaViewer = ({ item, onClose }: { item: MediaItem; onClose: () => void }) => {
  useBackClose(true, onClose);
  return createPortal(
    <div className="fixed inset-0 z-[200] flex flex-col bg-black" style={{ paddingTop: 'env(safe-area-inset-top)' }}>
      <div className="flex items-center justify-between px-4 py-3">
        <span className={`text-sm font-semibold text-white ${ELLIPSIS}`}>{item.name}</span>
        <button aria-label="Close" onClick={onClose} className="p-2">
          <X size={20} color="#fff" />
        </button>
      </div>
      <div className="flex-1 flex items-center justify-center min-h-0">
        {item.kind === 'video' && (
          <video src={item.url} controls autoPlay playsInline className="max-w-full max-h-full" />
        )}
        {item.kind === 'images' && (
          <img src={item.url} alt={item.name} className="max-w-full max-h-full object-contain" />
        )}
        {item.kind === 'other' && (
          <iframe src={item.url} title={item.name} sandbox="" className="w-full h-full bg-white" />
        )}
      </div>
      <div className="px-4 py-3 text-[10px] text-[#667085] break-all">
        {item.type ?? 'unknown type'} · {item.output.outpoint}
      </div>
    </div>,
    document.body,
  );
};

import React, { useCallback, useRef, useState } from 'react';
import type { MintLayer } from '../lib/types';

type Props = {
  layers: MintLayer[];
  selectedLayerId: string | null;
  getThumbnailSrc?: (id: string) => string | null;
  onSelect: (id: string) => void;
  onReorder: (id: string, newIndex: number) => void;
  onToggleVisible: (id: string) => void;
  onToggleLock: (id: string) => void;
  onRemove: (id: string) => void;
  onDuplicate: (id: string) => void;
};

const LAYER_ICONS: Record<string, string> = {
  guilloche: '\u223F', // ∿
  rosette: '\u2609', // ☉
  'fine-line': '\u2261', // ≡
  border: '\u25A1', // □
  microprint: '\u2630', // ☰
  text: 'T',
  image: '\u25A3', // ▣
  'serial-number': '#',
  thread: '\u2016', // ‖
  lathe: '\u25CE', // ◎
  gradient: '\u25D3', // ◓
  'qr-code': '\u25A6', // ▦
  'text-arc': '\u2312', // ⌒
  moire: '\u2248', // ≈
  crosshatch: '\u2573', // ╳
  stipple: '\u2234', // ∴
  'watermark-pattern': '\u2591', // ░
  hologram: '\u2728', // ✨
};

export default function LayerList({
  layers,
  selectedLayerId,
  getThumbnailSrc,
  onSelect,
  onReorder,
  onToggleVisible,
  onToggleLock,
  onRemove,
  onDuplicate,
}: Props) {
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Display layers in reverse (top of list = top of stack = last drawn)
  const displayLayers = [...layers].reverse();

  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    setDragId(id);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', id);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, displayIndex: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(displayIndex);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, displayIndex: number) => {
      e.preventDefault();
      if (!dragId) return;
      // Convert display index back to actual index (reversed)
      const actualIndex = layers.length - 1 - displayIndex;
      onReorder(dragId, actualIndex);
      setDragId(null);
      setDragOverIndex(null);
    },
    [dragId, layers.length, onReorder],
  );

  const handleDragEnd = useCallback(() => {
    setDragId(null);
    setDragOverIndex(null);
  }, []);

  return (
    <div className="layer-list" ref={listRef}>
      {displayLayers.map((layer, displayIdx) => (
        <div
          key={layer.id}
          className={[
            'layer-item',
            layer.id === selectedLayerId && 'selected',
            layer.id === dragId && 'dragging',
            dragOverIndex === displayIdx && dragId !== layer.id && 'drag-over',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={() => onSelect(layer.id)}
          draggable
          onDragStart={(e) => handleDragStart(e, layer.id)}
          onDragOver={(e) => handleDragOver(e, displayIdx)}
          onDrop={(e) => handleDrop(e, displayIdx)}
          onDragEnd={handleDragEnd}
        >
          <span className="layer-drag-handle" title="Drag to reorder">
            {'\u2630'}
          </span>
          <button
            className="layer-vis-btn"
            onClick={(e) => {
              e.stopPropagation();
              onToggleVisible(layer.id);
            }}
            title={layer.visible ? 'Hide' : 'Show'}
          >
            {layer.visible ? '\u25C9' : '\u25CB'}
          </button>
          {getThumbnailSrc ? (
            (() => {
              const src = getThumbnailSrc(layer.id);
              return src ? (
                <img className="layer-thumb" src={src} alt="" />
              ) : (
                <span className="layer-type-icon">{LAYER_ICONS[layer.type] || '?'}</span>
              );
            })()
          ) : (
            <span className="layer-type-icon">{LAYER_ICONS[layer.type] || '?'}</span>
          )}
          <span className="layer-name">{layer.name}</span>
          <div className="layer-actions">
            <button
              className="layer-lock-btn"
              onClick={(e) => {
                e.stopPropagation();
                onToggleLock(layer.id);
              }}
              title={layer.locked ? 'Unlock' : 'Lock'}
            >
              {layer.locked ? '\u{1F512}' : '\u{1F513}'}
            </button>
            <button
              className="layer-action-btn"
              onClick={(e) => {
                e.stopPropagation();
                onDuplicate(layer.id);
              }}
              title="Duplicate"
            >
              +
            </button>
            <button
              className="layer-action-btn danger"
              onClick={(e) => {
                e.stopPropagation();
                onRemove(layer.id);
              }}
              title="Remove"
            >
              x
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

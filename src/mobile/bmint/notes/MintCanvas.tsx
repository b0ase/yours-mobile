import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { MintDocument } from '../lib/types';

type Props = {
  doc: MintDocument;
  selectedLayerId: string | null;
  renderToCanvas: (canvas: HTMLCanvasElement) => void;
  onSelectLayer: (id: string | null) => void;
  showGrid: boolean;
  animatePreview: boolean;
};

export default function MintCanvas({
  doc,
  renderToCanvas,
  onSelectLayer,
  selectedLayerId,
  showGrid,
  animatePreview,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Zoom/pan state
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const isPanning = useRef(false);
  const panStart = useRef({ x: 0, y: 0 });
  const panOrigin = useRef({ x: 0, y: 0 });

  // Redraw whenever renderToCanvas identity changes (which tracks doc + cache updates)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    renderToCanvas(canvas);
  }, [renderToCanvas]);

  // Draw grid overlay
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    grid.width = doc.width;
    grid.height = doc.height;

    const ctx = grid.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, doc.width, doc.height);

    if (!showGrid) return;

    const gridSize = Math.max(20, Math.min(doc.width, doc.height) / 20);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)';
    ctx.lineWidth = 0.5;

    for (let x = gridSize; x < doc.width; x += gridSize) {
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, doc.height);
      ctx.stroke();
    }

    for (let y = gridSize; y < doc.height; y += gridSize) {
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(doc.width, y);
      ctx.stroke();
    }

    // Center crosshairs
    ctx.strokeStyle = 'rgba(255, 45, 120, 0.2)';
    ctx.lineWidth = 1;
    ctx.setLineDash([6, 4]);

    ctx.beginPath();
    ctx.moveTo(doc.width / 2, 0);
    ctx.lineTo(doc.width / 2, doc.height);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(0, doc.height / 2);
    ctx.lineTo(doc.width, doc.height / 2);
    ctx.stroke();

    ctx.setLineDash([]);
  }, [showGrid, doc.width, doc.height, renderToCanvas]);

  // Scale canvas to fit container while preserving aspect ratio + zoom/pan
  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const grid = gridRef.current;
    if (!container || !canvas) return;

    const fit = () => {
      const cw = container.clientWidth;
      const ch = container.clientHeight;
      const aspect = doc.width / doc.height;
      let displayW: number, displayH: number;

      if (cw / ch > aspect) {
        displayH = ch;
        displayW = ch * aspect;
      } else {
        displayW = cw;
        displayH = cw / aspect;
      }

      const w = displayW * zoom;
      const h = displayH * zoom;

      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      if (grid) {
        grid.style.width = `${w}px`;
        grid.style.height = `${h}px`;
      }
    };

    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [doc.width, doc.height, zoom]);

  // Wheel zoom
  const handleWheel = useCallback((e: React.WheelEvent) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const delta = e.deltaY > 0 ? 0.9 : 1.1;
      setZoom((prev) => Math.max(0.25, Math.min(5, prev * delta)));
    }
    // A plain wheel scrolls the page (bWalletX: the designer sits inside a scrolling page).
  }, []);

  // Pan with middle-click or space+drag
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button === 1 || (e.button === 0 && e.altKey)) {
        e.preventDefault();
        isPanning.current = true;
        panStart.current = { x: e.clientX, y: e.clientY };
        panOrigin.current = { ...pan };
        (e.target as HTMLElement).setPointerCapture(e.pointerId);
      }
    },
    [pan],
  );

  const handlePointerMove = useCallback((e: React.PointerEvent) => {
    if (!isPanning.current) return;
    setPan({
      x: panOrigin.current.x + (e.clientX - panStart.current.x),
      y: panOrigin.current.y + (e.clientY - panStart.current.y),
    });
  }, []);

  const handlePointerUp = useCallback(() => {
    isPanning.current = false;
  }, []);

  const handleClick = useCallback(
    (_e: React.MouseEvent) => {
      if (!isPanning.current) {
        onSelectLayer(null);
      }
    },
    [onSelectLayer],
  );

  const resetView = useCallback(() => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
  }, []);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(5, z * 1.25)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(0.25, z * 0.8)), []);

  return (
    <div className="mint-canvas-container" ref={containerRef}>
      <div
        className="mint-canvas-inner"
        onWheel={handleWheel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <div
          className={`mint-canvas-stack${animatePreview ? (doc.circleMask ? ' mint-animate-coin' : ' mint-animate-shimmer') : ''}`}
          style={{ transform: `translate(${pan.x}px, ${pan.y}px)` }}
        >
          <canvas ref={canvasRef} className="mint-canvas" onClick={handleClick} />
          {showGrid && <canvas ref={gridRef} className="mint-canvas mint-grid-overlay" />}
        </div>
      </div>
      <div className="mint-canvas-info">
        <span className="small">
          {doc.width} x {doc.height}
        </span>
        <div className="mint-zoom-controls">
          <button className="mint-zoom-btn" onClick={zoomOut} title="Zoom out">
            -
          </button>
          <button className="mint-zoom-btn" onClick={resetView} title="Reset view">
            {Math.round(zoom * 100)}%
          </button>
          <button className="mint-zoom-btn" onClick={zoomIn} title="Zoom in">
            +
          </button>
        </div>
        <span className="small">
          {doc.layers.length} layers{selectedLayerId ? ' \u00b7 Selected' : ''}
        </span>
      </div>
    </div>
  );
}

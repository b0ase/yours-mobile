import { useCallback, useEffect, useRef, useState } from 'react';
import {
  defaultBorderConfig,
  defaultCrosshatchConfig,
  defaultFilters,
  defaultFineLineConfig,
  defaultGradientConfig,
  defaultGuillocheConfig,
  defaultHologramConfig,
  defaultImageLayerConfig,
  defaultLatheConfig,
  defaultMicroprintConfig,
  defaultMintDocument,
  defaultMoireConfig,
  defaultQRCodeConfig,
  defaultRosetteConfig,
  defaultThreadConfig,
  defaultSerialNumberConfig,
  defaultStippleConfig,
  defaultTextArcConfig,
  defaultTextLayerConfig,
  defaultTransform,
  defaultWatermarkPatternConfig,
} from '../lib/mint-defaults';
import { encodeSvg, generators } from '../lib/mint-patterns';
import { embeddedFonts } from '../lib/fonts';
import { withFonts } from '../lib/svg';
import type {
  MintBlendMode,
  MintDocument,
  MintLayer,
  MintLayerConfig,
  MintLayerFilters,
  MintLayerTransform,
} from '../lib/types';

const MAX_UNDO = 50;

type LayerMetaPatch = {
  name?: string;
  visible?: boolean;
  locked?: boolean;
  opacity?: number;
  blendMode?: MintBlendMode;
  uvOnly?: boolean;
  transform?: MintLayerTransform;
  filters?: Partial<MintLayerFilters>;
};

function defaultConfigForType(type: MintLayerConfig['type']): MintLayerConfig['config'] {
  switch (type) {
    case 'guilloche':
      return defaultGuillocheConfig();
    case 'rosette':
      return defaultRosetteConfig();
    case 'fine-line':
      return defaultFineLineConfig();
    case 'border':
      return defaultBorderConfig();
    case 'microprint':
      return defaultMicroprintConfig();
    case 'text':
      return defaultTextLayerConfig();
    case 'image':
      return defaultImageLayerConfig();
    case 'serial-number':
      return defaultSerialNumberConfig();
    case 'thread':
      return defaultThreadConfig();
    case 'lathe':
      return defaultLatheConfig();
    case 'gradient':
      return defaultGradientConfig();
    case 'qr-code':
      return defaultQRCodeConfig();
    case 'text-arc':
      return defaultTextArcConfig();
    case 'moire':
      return defaultMoireConfig();
    case 'crosshatch':
      return defaultCrosshatchConfig();
    case 'stipple':
      return defaultStippleConfig();
    case 'watermark-pattern':
      return defaultWatermarkPatternConfig();
    case 'hologram':
      return defaultHologramConfig();
  }
}

function layerName(type: MintLayerConfig['type']): string {
  switch (type) {
    case 'guilloche':
      return 'Guilloche';
    case 'rosette':
      return 'Rosette';
    case 'fine-line':
      return 'Fine Lines';
    case 'border':
      return 'Border';
    case 'microprint':
      return 'Microprint';
    case 'text':
      return 'Text';
    case 'image':
      return 'Image';
    case 'serial-number':
      return 'Serial No.';
    case 'thread':
      return 'Foil Thread';
    case 'lathe':
      return 'Lathe';
    case 'gradient':
      return 'Gradient';
    case 'qr-code':
      return 'QR Code';
    case 'text-arc':
      return 'Text Arc';
    case 'moire':
      return 'Moir\u00e9';
    case 'crosshatch':
      return 'Crosshatch';
    case 'stipple':
      return 'Stipple';
    case 'watermark-pattern':
      return 'Watermark';
    case 'hologram':
      return 'Hologram';
  }
}

export function useMintDesigner() {
  const [doc, setDoc] = useState<MintDocument>(defaultMintDocument);
  const [selectedLayerId, setSelectedLayerId] = useState<string | null>(null);
  const [undoStack, setUndoStack] = useState<MintDocument[]>([]);
  const [redoStack, setRedoStack] = useState<MintDocument[]>([]);
  const [uvMode, setUvMode] = useState(false);
  const svgCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const imageCache = useRef<Map<string, HTMLImageElement>>(new Map());
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());
  const [renderTick, setRenderTick] = useState(0);

  const pushUndo = useCallback((current: MintDocument) => {
    setUndoStack((prev) => {
      const next = [...prev, current];
      if (next.length > MAX_UNDO) next.shift();
      return next;
    });
    setRedoStack([]);
  }, []);

  const undo = useCallback(() => {
    setUndoStack((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const last = next.pop()!;
      setRedoStack((r) => [...r, doc]);
      setDoc(last);
      return next;
    });
  }, [doc]);

  const redo = useCallback(() => {
    setRedoStack((prev) => {
      if (prev.length === 0) return prev;
      const next = [...prev];
      const last = next.pop()!;
      setUndoStack((u) => [...u, doc]);
      setDoc(last);
      return next;
    });
  }, [doc]);

  const regenerateLayer = useCallback((layer: MintLayer, width: number, height: number) => {
    const gen = generators[layer.type];
    if (!gen) return;

    if (layer.type === 'image' && layer.config.src) {
      const img = new Image();
      img.onload = () => {
        imageCache.current.set(layer.id, img);
        setRenderTick((t) => t + 1);
      };
      img.src = layer.config.src;
      return;
    }

    const svgStr = withFonts(gen(width, height, layer.config), embeddedFonts());
    const dataUrl = encodeSvg(svgStr);
    const img = new Image();
    img.onload = () => {
      svgCache.current.set(layer.id, img);
      setRenderTick((t) => t + 1);
    };
    img.src = dataUrl;
  }, []);

  const scheduleRegenerate = useCallback(
    (layerId: string) => {
      const existing = debounceTimers.current.get(layerId);
      if (existing) clearTimeout(existing);

      debounceTimers.current.set(
        layerId,
        setTimeout(() => {
          debounceTimers.current.delete(layerId);
          const layer = doc.layers.find((l) => l.id === layerId);
          if (layer) regenerateLayer(layer, doc.width, doc.height);
        }, 100),
      );
    },
    [doc, regenerateLayer],
  );

  useEffect(() => {
    for (const layer of doc.layers) {
      regenerateLayer(layer, doc.width, doc.height);
    }
  }, [doc.width, doc.height]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Re-render every layer (after the fonts finish loading). */
  const refreshAll = useCallback(() => {
    for (const layer of doc.layers) regenerateLayer(layer, doc.width, doc.height);
  }, [doc, regenerateLayer]);

  const addLayer = useCallback(
    (type: MintLayerConfig['type']) => {
      pushUndo(doc);
      const config = defaultConfigForType(type);
      const layer: MintLayer = {
        id: crypto.randomUUID(),
        name: layerName(type),
        visible: true,
        locked: false,
        opacity: 1,
        blendMode: 'source-over',
        uvOnly: false,
        transform: defaultTransform(),
        filters: defaultFilters(),
        type,
        config,
      } as MintLayer;

      setDoc((prev) => ({ ...prev, layers: [...prev.layers, layer] }));
      setSelectedLayerId(layer.id);
      regenerateLayer(layer, doc.width, doc.height);
    },
    [doc, pushUndo, regenerateLayer],
  );

  const addImageLayer = useCallback(
    (src: string, _name: string) => {
      pushUndo(doc);

      // Sentinel name for the background image layer we manage
      const BG_IMAGE_NAME = '\u00b7 Background';
      const VEIL_NAME = '\u00b7 Veil';

      setDoc((prev) => {
        const layers = [...prev.layers];

        // Find insertion point above the first gradient layer
        let insertIdx = 0;
        for (let i = 0; i < layers.length; i++) {
          if (layers[i].type === 'gradient') {
            layers[i] = { ...layers[i], blendMode: 'multiply' };
            insertIdx = i + 1;
            break;
          }
        }

        // Check if we already have a managed background image — replace it
        const existingIdx = layers.findIndex((l) => l.name === BG_IMAGE_NAME);
        if (existingIdx !== -1) {
          const existing = layers[existingIdx];
          layers[existingIdx] = {
            ...existing,
            config: { ...existing.config, src },
            name: BG_IMAGE_NAME,
          } as typeof existing;
          // Reload the image
          const img = new Image();
          img.src = src;
          img.onload = () => {
            imageCache.current.set(existing.id, img);
            setRenderTick((t) => t + 1);
          };
          return { ...prev, layers };
        }

        // New background image layer
        const imageLayer: MintLayer = {
          id: crypto.randomUUID(),
          name: BG_IMAGE_NAME,
          visible: true,
          locked: false,
          opacity: 1,
          blendMode: 'source-over',
          uvOnly: false,
          transform: defaultTransform(),
          filters: defaultFilters(),
          type: 'image',
          config: { src, fit: 'cover' as const, x: 0.5, y: 0.5, scale: 1 },
        };

        // Dark veil layer above image so gold filigree stays visible
        const veilLayer: MintLayer = {
          id: crypto.randomUUID(),
          name: VEIL_NAME,
          visible: true,
          locked: false,
          opacity: 0.45,
          blendMode: 'source-over',
          uvOnly: false,
          transform: defaultTransform(),
          filters: defaultFilters(),
          type: 'gradient',
          config: { type: 'radial' as const, colors: ['transparent', 'rgba(0,0,0,0.9)'], angle: 0, opacity: 1 },
        };

        layers.splice(insertIdx, 0, imageLayer, veilLayer);
        regenerateLayer(imageLayer, prev.width, prev.height);
        regenerateLayer(veilLayer, prev.width, prev.height);
        setSelectedLayerId(imageLayer.id);
        return { ...prev, layers };
      });
    },
    [doc, pushUndo, regenerateLayer],
  );

  const removeLayer = useCallback(
    (id: string) => {
      pushUndo(doc);
      svgCache.current.delete(id);
      imageCache.current.delete(id);
      setDoc((prev) => ({ ...prev, layers: prev.layers.filter((l) => l.id !== id) }));
      setSelectedLayerId((prev) => (prev === id ? null : prev));
    },
    [doc, pushUndo],
  );

  const reorderLayer = useCallback(
    (id: string, newIndex: number) => {
      pushUndo(doc);
      setDoc((prev) => {
        const layers = [...prev.layers];
        const oldIndex = layers.findIndex((l) => l.id === id);
        if (oldIndex < 0 || newIndex < 0 || newIndex >= layers.length) return prev;
        const [removed] = layers.splice(oldIndex, 1);
        layers.splice(newIndex, 0, removed);
        return { ...prev, layers };
      });
    },
    [doc, pushUndo],
  );

  const updateLayerConfig = useCallback(
    (id: string, configPatch: Record<string, unknown>) => {
      pushUndo(doc);
      setDoc((prev) => ({
        ...prev,
        layers: prev.layers.map((l) =>
          l.id === id ? ({ ...l, config: { ...l.config, ...configPatch } } as typeof l) : l,
        ),
      }));
      scheduleRegenerate(id);
    },
    [doc, pushUndo, scheduleRegenerate],
  );

  const updateLayerMeta = useCallback(
    (id: string, patch: LayerMetaPatch) => {
      pushUndo(doc);
      const { filters: filtersPatch, ...rest } = patch;
      setDoc((prev) => ({
        ...prev,
        layers: prev.layers.map((l) => {
          if (l.id !== id) return l;
          const updated = { ...l, ...rest };
          if (filtersPatch) {
            updated.filters = { ...(l.filters || defaultFilters()), ...filtersPatch };
          }
          return updated;
        }),
      }));
      setRenderTick((t) => t + 1);
    },
    [doc, pushUndo],
  );

  const updateLayerTransform = useCallback(
    (id: string, transformPatch: Partial<MintLayerTransform>) => {
      pushUndo(doc);
      setDoc((prev) => ({
        ...prev,
        layers: prev.layers.map((l) =>
          l.id === id ? { ...l, transform: { ...(l.transform || defaultTransform()), ...transformPatch } } : l,
        ),
      }));
      setRenderTick((t) => t + 1);
    },
    [doc, pushUndo],
  );

  const duplicateLayer = useCallback(
    (id: string) => {
      pushUndo(doc);
      const source = doc.layers.find((l) => l.id === id);
      if (!source) return;
      const newLayer: MintLayer = {
        ...structuredClone(source),
        id: crypto.randomUUID(),
        name: `${source.name} Copy`,
      };
      setDoc((prev) => {
        const idx = prev.layers.findIndex((l) => l.id === id);
        const layers = [...prev.layers];
        layers.splice(idx + 1, 0, newLayer);
        return { ...prev, layers };
      });
      setSelectedLayerId(newLayer.id);
      regenerateLayer(newLayer, doc.width, doc.height);
    },
    [doc, pushUndo, regenerateLayer],
  );

  const setCanvasSize = useCallback(
    (width: number, height: number) => {
      pushUndo(doc);
      setDoc((prev) => ({ ...prev, width, height }));
    },
    [doc, pushUndo],
  );

  const setBackgroundColor = useCallback(
    (backgroundColor: string) => {
      pushUndo(doc);
      setDoc((prev) => ({ ...prev, backgroundColor }));
    },
    [doc, pushUndo],
  );

  const setDocMeta = useCallback(
    (patch: Partial<Pick<MintDocument, 'name' | 'description' | 'circleMask' | 'rimPattern'>>) => {
      pushUndo(doc);
      setDoc((prev) => ({ ...prev, ...patch }));
    },
    [doc, pushUndo],
  );

  // Render all layers to a canvas
  const renderToCanvas = useCallback(
    (canvas: HTMLCanvasElement, forExport = false) => {
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = doc.width;
      canvas.height = doc.height;

      // Circle mask setup
      if (doc.circleMask) {
        ctx.save();
        const cx = doc.width / 2;
        const cy = doc.height / 2;
        const r = Math.min(doc.width, doc.height) / 2;
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.clip();
      }

      // Background
      ctx.fillStyle = doc.backgroundColor;
      ctx.fillRect(0, 0, doc.width, doc.height);

      // Composite layers bottom-to-top
      for (const layer of doc.layers) {
        if (!layer.visible) continue;
        // UV mode filtering: in normal mode, hide uvOnly layers; in UV mode, show all but dim non-UV
        if (!forExport) {
          if (!uvMode && layer.uvOnly) continue;
        }

        ctx.save();
        ctx.globalAlpha = layer.opacity * (!forExport && uvMode && !layer.uvOnly ? 0.3 : 1);
        ctx.globalCompositeOperation = layer.blendMode;

        // Apply layer transform
        const t = layer.transform || { x: 0, y: 0, rotation: 0, scale: 1 };
        if (t.x !== 0 || t.y !== 0 || t.rotation !== 0 || t.scale !== 1) {
          const cx = doc.width / 2 + t.x;
          const cy = doc.height / 2 + t.y;
          ctx.translate(cx, cy);
          if (t.rotation !== 0) ctx.rotate((t.rotation * Math.PI) / 180);
          if (t.scale !== 1) ctx.scale(t.scale, t.scale);
          ctx.translate(-doc.width / 2, -doc.height / 2);
        }

        // Apply per-layer HSL filters
        const f = layer.filters || { hue: 0, saturation: 0, brightness: 0 };
        if (f.hue !== 0 || f.saturation !== 0 || f.brightness !== 0) {
          ctx.filter = `hue-rotate(${f.hue}deg) saturate(${100 + f.saturation}%) brightness(${100 + f.brightness}%)`;
        }

        if (layer.type === 'image' && layer.config.src) {
          const img = imageCache.current.get(layer.id);
          if (img && img.complete) {
            const { fit, x, y, scale } = layer.config;
            if (fit === 'cover') {
              const ratio = Math.max(doc.width / img.naturalWidth, doc.height / img.naturalHeight) * scale;
              const sw = img.naturalWidth * ratio;
              const sh = img.naturalHeight * ratio;
              ctx.drawImage(img, (doc.width - sw) * x, (doc.height - sh) * y, sw, sh);
            } else if (fit === 'fill') {
              ctx.drawImage(img, 0, 0, doc.width, doc.height);
            } else {
              const dw = img.naturalWidth * scale;
              const dh = img.naturalHeight * scale;
              ctx.drawImage(img, doc.width * x - dw / 2, doc.height * y - dh / 2, dw, dh);
            }
          }
        } else {
          const cached = svgCache.current.get(layer.id);
          if (cached && cached.complete) {
            ctx.drawImage(cached, 0, 0, doc.width, doc.height);
          }
        }

        ctx.filter = 'none';

        ctx.restore();
      }

      // Restore circle mask clip
      if (doc.circleMask) {
        ctx.restore();

        // Rim pattern (knurling)
        if (doc.rimPattern?.enabled) {
          const cx = doc.width / 2;
          const cy = doc.height / 2;
          const r = Math.min(doc.width, doc.height) / 2;
          const teeth = doc.rimPattern.teeth;
          const depth = doc.rimPattern.depth;
          ctx.strokeStyle = doc.rimPattern.color;
          ctx.lineWidth = 1;

          for (let i = 0; i < teeth; i++) {
            const angle = (i / teeth) * Math.PI * 2;
            const x1 = cx + Math.cos(angle) * (r - depth);
            const y1 = cy + Math.sin(angle) * (r - depth);
            const x2 = cx + Math.cos(angle) * r;
            const y2 = cy + Math.sin(angle) * r;
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
            ctx.stroke();
          }
        }
      }
    },
    // renderTick: redraw when a layer image finishes loading.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [doc, uvMode, renderTick],
  );

  const loadDocument = useCallback(
    (newDoc: MintDocument) => {
      pushUndo(doc);
      svgCache.current.clear();
      imageCache.current.clear();
      // Ensure new document fields have defaults for backward compat
      const normalized: MintDocument = {
        ...newDoc,
        name: newDoc.name || '',
        description: newDoc.description || '',
        circleMask: newDoc.circleMask ?? false,
        rimPattern: newDoc.rimPattern ?? { enabled: false, teeth: 120, depth: 6, color: '#daa520' },
        layers: newDoc.layers.map((l) => ({
          ...l,
          uvOnly: l.uvOnly ?? false,
          transform: l.transform ?? defaultTransform(),
          filters: l.filters ?? defaultFilters(),
        })) as MintLayer[],
      };
      setDoc(normalized);
      setSelectedLayerId(null);
      setTimeout(() => {
        for (const layer of normalized.layers) {
          regenerateLayer(layer, normalized.width, normalized.height);
        }
      }, 0);
    },
    [doc, pushUndo, regenerateLayer],
  );

  const exportPng = useCallback((): string | null => {
    const canvas = document.createElement('canvas');
    renderToCanvas(canvas, true);
    return canvas.toDataURL('image/png');
  }, [renderToCanvas]);

  const exportBatchPng = useCallback(
    (serialOverride?: { layerId: string; number: number }): string | null => {
      if (serialOverride) {
        const layer = doc.layers.find((l) => l.id === serialOverride.layerId);
        if (layer && layer.type === 'serial-number') {
          const tempConfig = { ...layer.config, startNumber: serialOverride.number };
          const gen = generators['serial-number'];
          const svgStr = gen(doc.width, doc.height, tempConfig);
          const dataUrl = encodeSvg(svgStr);
          const img = new Image();
          img.src = dataUrl;
          svgCache.current.set(layer.id, img);
        }
      }
      const canvas = document.createElement('canvas');
      renderToCanvas(canvas, true);
      return canvas.toDataURL('image/png');
    },
    [doc, renderToCanvas],
  );

  const getLayerThumbnailSrc = useCallback((id: string): string | null => {
    const svgImg = svgCache.current.get(id);
    if (svgImg?.src) return svgImg.src;
    const imgImg = imageCache.current.get(id);
    if (imgImg?.src) return imgImg.src;
    return null;
  }, []);

  const selectedLayer = doc.layers.find((l) => l.id === selectedLayerId) ?? null;

  return {
    doc,
    selectedLayerId,
    selectedLayer,
    canUndo: undoStack.length > 0,
    canRedo: redoStack.length > 0,
    uvMode,

    addLayer,
    addImageLayer,
    removeLayer,
    reorderLayer,
    updateLayerConfig,
    updateLayerMeta,
    updateLayerTransform,
    duplicateLayer,
    selectLayer: setSelectedLayerId,

    setCanvasSize,
    setBackgroundColor,
    setDocMeta,
    setUvMode,
    loadDocument,

    undo,
    redo,

    renderToCanvas,
    exportPng,
    exportBatchPng,
    getLayerThumbnailSrc,
    refreshAll,
  };
}

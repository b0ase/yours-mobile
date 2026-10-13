import type {
  BorderConfig,
  CrosshatchConfig,
  FineLineConfig,
  GradientConfig,
  GuillocheConfig,
  HologramConfig,
  ImageLayerConfig,
  LatheConfig,
  MicroprintConfig,
  MintDocument,
  MintLayer,
  MintLayerTransform,
  MoireConfig,
  QRCodeConfig,
  RosetteConfig,
  ThreadConfig,
  SerialNumberConfig,
  StippleConfig,
  TextArcConfig,
  TextLayerConfig,
  WatermarkPatternConfig,
} from './types';

export const defaultTransform = (): MintLayerTransform => ({ x: 0, y: 0, rotation: 0, scale: 1 });

export function defaultGuillocheConfig(): GuillocheConfig {
  return {
    waves: 3,
    frequency: 8,
    amplitude: 60,
    lines: 30,
    strokeWidth: 0.8,
    color: '#c9a84c',
    phase: 0,
    damping: 0.4,
  };
}

export function defaultRosetteConfig(): RosetteConfig {
  return { petals: 12, rings: 8, radius: 0.35, strokeWidth: 0.6, color: '#daa520', rotation: 0, innerRadius: 0.3 };
}

export function defaultFineLineConfig(): FineLineConfig {
  return {
    angle: 45,
    spacing: 6,
    strokeWidth: 0.4,
    color: 'rgba(255, 255, 255, 0.15)',
    wave: false,
    waveAmplitude: 3,
    waveFrequency: 4,
  };
}

export function defaultBorderConfig(): BorderConfig {
  return { style: 'classic', thickness: 40, color: '#c9a84c', cornerStyle: 'square', innerBorder: true, innerGap: 8 };
}

export function defaultMicroprintConfig(): MicroprintConfig {
  return {
    text: 'THE MINT BITCOIN CORPORATION',
    fontSize: 3,
    color: 'rgba(255, 255, 255, 0.2)',
    rows: 12,
    angle: 0,
    spacing: 6,
  };
}

export function defaultTextLayerConfig(): TextLayerConfig {
  return {
    text: 'THE MINT',
    fontFamily: 'Space Grotesk',
    fontSize: 64,
    fontWeight: 700,
    color: '#ffffff',
    letterSpacing: 8,
    align: 'center',
    x: 0.5,
    y: 0.5,
  };
}

export function defaultImageLayerConfig(): ImageLayerConfig {
  return { src: '', fit: 'contain', x: 0.5, y: 0.5, scale: 1 };
}

export function defaultSerialNumberConfig(): SerialNumberConfig {
  return {
    prefix: 'AA',
    startNumber: 1,
    digits: 6,
    fontFamily: 'IBM Plex Mono',
    fontSize: 24,
    color: '#ffffff',
    letterSpacing: 4,
    x: 0.85,
    y: 0.9,
  };
}

export function defaultThreadConfig(): ThreadConfig {
  return {
    x: 0.33,
    width: 4,
    color: 'rgba(255, 255, 255, 0.15)',
    text: 'THE MINT',
    textColor: 'rgba(255, 255, 255, 0.3)',
    dashed: true,
    dashLength: 30,
    gapLength: 15,
  };
}

export function defaultLatheConfig(): LatheConfig {
  return {
    lineCount: 60,
    strokeWidth: 0.3,
    color: 'rgba(255, 255, 255, 0.08)',
    centerX: 0.5,
    centerY: 0.5,
    scale: 1,
    rotation: 0,
  };
}

export function defaultGradientConfig(): GradientConfig {
  return { type: 'linear', colors: ['#1a1000', '#0a0800', '#1a1000'], angle: 90, opacity: 0.5 };
}

export function defaultQRCodeConfig(): QRCodeConfig {
  return { text: 'THE MINT', size: 0.15, x: 0.9, y: 0.1, color: '#ffffff', backgroundColor: 'transparent' };
}

export function defaultTextArcConfig(): TextArcConfig {
  return {
    text: 'THE BITCOIN CORPORATION',
    fontFamily: 'Space Grotesk',
    fontSize: 24,
    fontWeight: 600,
    color: '#ffffff',
    letterSpacing: 4,
    radius: 0.35,
    startAngle: -90,
    centerX: 0.5,
    centerY: 0.5,
    flipText: false,
  };
}

export function defaultMoireConfig(): MoireConfig {
  return { angle1: 0, angle2: 5, spacing: 4, strokeWidth: 0.3, color: 'rgba(255, 255, 255, 0.1)' };
}

export function defaultCrosshatchConfig(): CrosshatchConfig {
  return { angle: 45, spacing: 8, strokeWidth: 0.3, color: 'rgba(255, 255, 255, 0.08)', sets: 2 };
}

export function defaultStippleConfig(): StippleConfig {
  return { density: 200, dotSize: 1, color: 'rgba(255, 255, 255, 0.1)', pattern: 'random', seed: 42 };
}

export function defaultWatermarkPatternConfig(): WatermarkPatternConfig {
  return {
    text: 'THE MINT',
    fontFamily: 'Space Grotesk',
    fontSize: 18,
    color: 'rgba(255, 255, 255, 0.04)',
    angle: -30,
    spacingX: 200,
    spacingY: 80,
  };
}

export function defaultHologramConfig(): HologramConfig {
  return {
    colors: ['#c9a84c', '#e6c665', '#daa520', '#b8860b', '#ffd700', '#c9a84c'],
    angle: 45,
    stripWidth: 8,
    shimmer: 0.5,
    x: 0.05,
    y: 0.05,
    width: 0.2,
    height: 0.15,
  };
}

export const defaultFilters = () => ({ hue: 0, saturation: 0, brightness: 0 });

export function makeLayer(type: MintLayer['type'], name: string, config: MintLayer['config']): MintLayer {
  return {
    id: crypto.randomUUID(),
    name,
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
}

export const defaultRimPattern = () => ({ enabled: false, teeth: 120, depth: 6, color: '#daa520' });

export function defaultMintDocument(): MintDocument {
  return {
    name: '',
    description: '',
    width: 1200,
    height: 600,
    backgroundColor: '#060012',
    layers: [
      // 1. Base Gradient — Deep indigo→midnight radial
      makeLayer('gradient', 'Base Gradient', {
        type: 'radial',
        colors: ['#0a0020', '#060012', '#0a0028'],
        angle: 0,
        opacity: 1,
      } as GradientConfig),
      // 2. Crosshatch Substrate — Fine paper texture
      makeLayer('crosshatch', 'Crosshatch Substrate', {
        angle: 30,
        spacing: 4,
        strokeWidth: 0.15,
        color: 'rgba(201,168,76,0.04)',
        sets: 3,
      } as CrosshatchConfig),
      // 3. Moiré Anti-Copy — Subtle interference
      makeLayer('moire', 'Moiré Anti-Copy', {
        angle1: 0,
        angle2: 4,
        spacing: 3,
        strokeWidth: 0.2,
        color: 'rgba(201,168,76,0.05)',
      } as MoireConfig),
      // 4. Wavy Fine Lines — Angled engraving lines with wave
      makeLayer('fine-line', 'Wavy Fine Lines', {
        angle: 25,
        spacing: 5,
        strokeWidth: 0.3,
        color: 'rgba(201,168,76,0.08)',
        wave: true,
        waveAmplitude: 4,
        waveFrequency: 6,
      } as FineLineConfig),
      // 5. Lathe Engine Turn — Radial engine-turning pattern (left side)
      makeLayer('lathe', 'Lathe Engine Turn', {
        lineCount: 80,
        strokeWidth: 0.2,
        color: 'rgba(218,165,32,0.1)',
        centerX: 0.25,
        centerY: 0.5,
        scale: 1,
        rotation: 0,
      } as LatheConfig),
      // 6. Guilloche Left — Left-side oval wave medallion
      makeLayer('guilloche', 'Guilloche Left', {
        waves: 4,
        frequency: 12,
        amplitude: 55,
        lines: 35,
        strokeWidth: 0.5,
        color: '#c9a84c',
        phase: 0,
        damping: 0.35,
      } as GuillocheConfig),
      // 7. Guilloche Right — Right-side complementary (phase offset, translated)
      (() => {
        const l = makeLayer('guilloche', 'Guilloche Right', {
          waves: 3,
          frequency: 10,
          amplitude: 45,
          lines: 25,
          strokeWidth: 0.5,
          color: '#daa520',
          phase: 45,
          damping: 0.4,
        } as GuillocheConfig);
        l.transform = { x: 200, y: 0, rotation: 0, scale: 1 };
        return l;
      })(),
      // 8. Centre Rosette — Central medallion/seal
      makeLayer('rosette', 'Centre Rosette', {
        petals: 20,
        rings: 12,
        radius: 0.18,
        strokeWidth: 0.4,
        color: '#e6c665',
        rotation: 0,
        innerRadius: 0.25,
      } as RosetteConfig),
      // 9. Ornate Border — Art-deco frame + inner border
      makeLayer('border', 'Ornate Border', {
        style: 'ornate',
        thickness: 48,
        color: '#c9a84c',
        cornerStyle: 'ornament',
        innerBorder: true,
        innerGap: 10,
      } as BorderConfig),
      // 10. Foil Thread — Vertical dashed thread
      makeLayer('thread', 'Foil Thread', {
        x: 0.35,
        width: 4,
        color: 'rgba(230,198,101,0.15)',
        text: 'THE MINT',
        textColor: 'rgba(255,248,220,0.25)',
        dashed: true,
        dashLength: 30,
        gapLength: 15,
      } as ThreadConfig),
      // 11. Watermark Pattern — Tiled diagonal watermark
      makeLayer('watermark-pattern', 'Watermark Pattern', {
        text: 'THE MINT',
        fontFamily: 'Space Grotesk',
        fontSize: 14,
        color: 'rgba(255,255,255,0.025)',
        angle: -30,
        spacingX: 180,
        spacingY: 65,
      } as WatermarkPatternConfig),
      // 12. Microprint Band — Tiny repeating text
      makeLayer('microprint', 'Microprint Band', {
        text: 'THE BITCOIN CORPORATION MINT',
        fontSize: 2.5,
        color: 'rgba(255,248,220,0.12)',
        rows: 10,
        angle: 0,
        spacing: 5,
      } as MicroprintConfig),
      // 13. Hologram Strip — Iridescent foil badge top-left
      makeLayer('hologram', 'Hologram Strip', {
        colors: ['#c9a84c', '#e6c665', '#daa520', '#b8860b', '#ffd700', '#c9a84c'],
        angle: 45,
        stripWidth: 6,
        shimmer: 0.6,
        x: 0.04,
        y: 0.06,
        width: 0.18,
        height: 0.14,
      } as HologramConfig),
      // 14. Stipple Texture — Dot-cloud for depth
      makeLayer('stipple', 'Stipple Texture', {
        density: 300,
        dotSize: 0.8,
        color: 'rgba(201,168,76,0.04)',
        pattern: 'halftone',
        seed: 1729,
      } as StippleConfig),
      // 15. Title Text — "THE BITCOIN CORPORATION" header
      makeLayer('text', 'Title Text', {
        text: 'THE BITCOIN CORPORATION',
        fontFamily: 'Space Grotesk',
        fontSize: 26,
        fontWeight: 700,
        color: '#fff8dc',
        letterSpacing: 8,
        align: 'center',
        x: 0.5,
        y: 0.13,
      } as TextLayerConfig),
      // 16. Denomination — Large "100" numeral
      makeLayer('text', 'Denomination', {
        text: '100',
        fontFamily: 'Bebas Neue',
        fontSize: 140,
        fontWeight: 700,
        color: 'rgba(255,248,220,0.9)',
        letterSpacing: 0,
        align: 'center',
        x: 0.82,
        y: 0.45,
      } as TextLayerConfig),
      // 17. Sub-denomination — "ONE HUNDRED" small text
      makeLayer('text', 'Sub-denomination', {
        text: 'ONE HUNDRED',
        fontFamily: 'Space Grotesk',
        fontSize: 14,
        fontWeight: 400,
        color: 'rgba(255,248,220,0.5)',
        letterSpacing: 6,
        align: 'center',
        x: 0.82,
        y: 0.62,
      } as TextLayerConfig),
      // 18. Serial Number — "AA000001" bottom-right
      makeLayer('serial-number', 'Serial Number', {
        prefix: 'AA',
        startNumber: 1,
        digits: 6,
        fontFamily: 'IBM Plex Mono',
        fontSize: 20,
        color: '#c9a84c',
        letterSpacing: 4,
        x: 0.88,
        y: 0.9,
      } as SerialNumberConfig),
    ],
    circleMask: false,
    rimPattern: defaultRimPattern(),
  };
}

// --- Color Scheme Presets ---

export type ColorScheme = {
  name: string;
  background: string;
  primary: string;
  secondary: string;
  accent: string;
  text: string;
};

export const COLOR_SCHEMES: ColorScheme[] = [
  {
    name: 'Gold Reserve',
    background: '#0a0800',
    primary: '#c9a84c',
    secondary: '#daa520',
    accent: '#e6c665',
    text: '#fff8dc',
  },
  {
    name: 'USD Green',
    background: '#0a1a0a',
    primary: '#2d8f4e',
    secondary: '#1a6b37',
    accent: '#4caf50',
    text: '#d4e8d0',
  },
  {
    name: 'Euro Blue',
    background: '#0a0a1a',
    primary: '#1565c0',
    secondary: '#42a5f5',
    accent: '#ffd54f',
    text: '#e3f2fd',
  },
  {
    name: 'GBP Purple',
    background: '#1a0a1a',
    primary: '#7b1fa2',
    secondary: '#ab47bc',
    accent: '#ffd700',
    text: '#f3e5f5',
  },
  {
    name: 'BTC Orange',
    background: '#1a0f0a',
    primary: '#f7931a',
    secondary: '#ff9800',
    accent: '#ffffff',
    text: '#fff3e0',
  },
  {
    name: 'Silver Standard',
    background: '#0a0a0a',
    primary: '#c0c0c0',
    secondary: '#808080',
    accent: '#e0e0e0',
    text: '#f5f5f5',
  },
  {
    name: 'Swiss Red',
    background: '#1a0a0a',
    primary: '#d32f2f',
    secondary: '#ef5350',
    accent: '#ffffff',
    text: '#ffebee',
  },
  { name: 'Noir', background: '#000000', primary: '#333333', secondary: '#555555', accent: '#888888', text: '#cccccc' },
  { name: 'Neon', background: '#0a0010', primary: '#00e5ff', secondary: '#7b2dff', accent: '#ffd700', text: '#e0f7fa' },
  { name: 'Rose', background: '#0a0a0a', primary: '#ff2d78', secondary: '#ff69b4', accent: '#ffd700', text: '#ffffff' },
];
// --- Document Templates ---

export type MintTemplate = {
  id: string;
  name: string;
  description: string;
  factory: () => MintDocument;
};

const docBase = (
  name: string,
  w: number,
  h: number,
  bg: string,
  layers: MintLayer[],
  opts?: Partial<MintDocument>,
): MintDocument => ({
  name,
  description: '',
  width: w,
  height: h,
  backgroundColor: bg,
  layers,
  circleMask: false,
  rimPattern: defaultRimPattern(),
  ...opts,
});

export const MINT_TEMPLATES: MintTemplate[] = [
  {
    id: 'banknote',
    name: 'Banknote',
    description: 'Classic currency note (1200x600)',
    factory: () =>
      docBase('Banknote', 1200, 600, '#0a0a1a', [
        makeLayer('gradient', 'Background Gradient', {
          type: 'linear',
          colors: ['#0a0020', '#0a0a2e', '#0a0020'],
          angle: 0,
          opacity: 1,
        } as GradientConfig),
        makeLayer('fine-line', 'Fine Lines', {
          angle: 30,
          spacing: 8,
          strokeWidth: 0.3,
          color: 'rgba(255,255,255,0.06)',
          wave: false,
          waveAmplitude: 3,
          waveFrequency: 4,
        } as FineLineConfig),
        makeLayer('lathe', 'Lathe Background', defaultLatheConfig()),
        makeLayer('guilloche', 'Guilloche', {
          waves: 3,
          frequency: 10,
          amplitude: 50,
          lines: 25,
          strokeWidth: 0.6,
          color: '#1565c0',
          phase: 0,
          damping: 0.3,
        } as GuillocheConfig),
        makeLayer('border', 'Border', {
          style: 'ornate',
          thickness: 45,
          color: '#1565c0',
          cornerStyle: 'ornament',
          innerBorder: true,
          innerGap: 10,
        } as BorderConfig),
        makeLayer('rosette', 'Left Rosette', {
          petals: 16,
          rings: 10,
          radius: 0.2,
          strokeWidth: 0.4,
          color: '#42a5f5',
          rotation: 0,
          innerRadius: 0.3,
        } as RosetteConfig),
        makeLayer('microprint', 'Microprint', {
          text: 'BITCOIN CORPORATION',
          fontSize: 3,
          color: 'rgba(255,255,255,0.12)',
          rows: 8,
          angle: 0,
          spacing: 7,
        } as MicroprintConfig),
        makeLayer('thread', 'Foil Thread', defaultThreadConfig()),
        makeLayer('text', 'Denomination', {
          text: '100',
          fontFamily: 'Bebas Neue',
          fontSize: 120,
          fontWeight: 700,
          color: '#e3f2fd',
          letterSpacing: 4,
          align: 'center',
          x: 0.8,
          y: 0.45,
        } as TextLayerConfig),
        makeLayer('text', 'Title', {
          text: 'THE BITCOIN CORPORATION',
          fontFamily: 'Space Grotesk',
          fontSize: 28,
          fontWeight: 600,
          color: '#e3f2fd',
          letterSpacing: 6,
          align: 'center',
          x: 0.5,
          y: 0.15,
        } as TextLayerConfig),
        makeLayer('serial-number', 'Serial', defaultSerialNumberConfig()),
      ]),
  },
  {
    id: 'coin',
    name: 'Coin',
    description: 'Circular coin design (800x800)',
    factory: () =>
      docBase(
        'Coin',
        800,
        800,
        '#0a0800',
        [
          makeLayer('gradient', 'Gold Gradient', {
            type: 'radial',
            colors: ['#ffd700', '#b8860b', '#8b6914'],
            angle: 0,
            opacity: 0.6,
          } as GradientConfig),
          makeLayer('rosette', 'Outer Ring', {
            petals: 24,
            rings: 4,
            radius: 0.48,
            strokeWidth: 0.8,
            color: '#daa520',
            rotation: 0,
            innerRadius: 0.85,
          } as RosetteConfig),
          makeLayer('rosette', 'Inner Ring', {
            petals: 12,
            rings: 8,
            radius: 0.35,
            strokeWidth: 0.5,
            color: '#ffd700',
            rotation: 15,
            innerRadius: 0.2,
          } as RosetteConfig),
          makeLayer('lathe', 'Edge Pattern', {
            lineCount: 120,
            strokeWidth: 0.2,
            color: 'rgba(255,215,0,0.2)',
            centerX: 0.5,
            centerY: 0.5,
            scale: 1.3,
            rotation: 0,
          } as LatheConfig),
          makeLayer('text-arc', 'Rim Text', {
            text: 'THE BITCOIN CORPORATION',
            fontFamily: 'Space Grotesk',
            fontSize: 18,
            fontWeight: 600,
            color: '#fff8dc',
            letterSpacing: 6,
            radius: 0.42,
            startAngle: -90,
            centerX: 0.5,
            centerY: 0.5,
            flipText: false,
          } as TextArcConfig),
          makeLayer('text', 'Value', {
            text: '1',
            fontFamily: 'Bebas Neue',
            fontSize: 180,
            fontWeight: 700,
            color: '#fff8dc',
            letterSpacing: 0,
            align: 'center',
            x: 0.5,
            y: 0.48,
          } as TextLayerConfig),
          makeLayer('text', 'Label', {
            text: 'BITCOIN',
            fontFamily: 'Space Grotesk',
            fontSize: 32,
            fontWeight: 600,
            color: '#fff8dc',
            letterSpacing: 8,
            align: 'center',
            x: 0.5,
            y: 0.72,
          } as TextLayerConfig),
        ],
        { circleMask: true, rimPattern: { enabled: true, teeth: 120, depth: 6, color: '#daa520' } },
      ),
  },
  {
    id: 'token-icon',
    name: 'Token Icon',
    description: 'BSV-21 token icon (512x512)',
    factory: () =>
      docBase('Token Icon', 512, 512, '#0a0a0a', [
        makeLayer('gradient', 'Background', {
          type: 'radial',
          colors: ['#1a1000', '#0a0a0a'],
          angle: 0,
          opacity: 1,
        } as GradientConfig),
        makeLayer('rosette', 'Pattern', {
          petals: 8,
          rings: 5,
          radius: 0.45,
          strokeWidth: 0.8,
          color: '#c9a84c',
          rotation: 0,
          innerRadius: 0.2,
        } as RosetteConfig),
        makeLayer('text', 'Symbol', {
          text: '$TOKEN',
          fontFamily: 'Space Grotesk',
          fontSize: 72,
          fontWeight: 700,
          color: '#ffffff',
          letterSpacing: 4,
          align: 'center',
          x: 0.5,
          y: 0.5,
        } as TextLayerConfig),
      ]),
  },
  {
    id: 'stamp',
    name: 'Postage Stamp',
    description: 'Compact stamp design (400x500)',
    factory: () =>
      docBase('Postage Stamp', 400, 500, '#0a0800', [
        makeLayer('gradient', 'Tint', {
          type: 'linear',
          colors: ['#1a1000', '#0a0800', '#1a1000'],
          angle: 45,
          opacity: 1,
        } as GradientConfig),
        makeLayer('fine-line', 'Background', {
          angle: 60,
          spacing: 4,
          strokeWidth: 0.2,
          color: 'rgba(255,255,255,0.05)',
          wave: true,
          waveAmplitude: 2,
          waveFrequency: 6,
        } as FineLineConfig),
        makeLayer('border', 'Frame', {
          style: 'geometric',
          thickness: 25,
          color: '#c9a84c',
          cornerStyle: 'square',
          innerBorder: true,
          innerGap: 6,
        } as BorderConfig),
        makeLayer('microprint', 'Border Text', {
          text: 'BSV POSTAGE',
          fontSize: 2,
          color: 'rgba(201,168,76,0.2)',
          rows: 20,
          angle: 0,
          spacing: 4,
        } as MicroprintConfig),
        makeLayer('text', 'Value', {
          text: '1 SAT',
          fontFamily: 'Bebas Neue',
          fontSize: 48,
          fontWeight: 700,
          color: '#ffffff',
          letterSpacing: 4,
          align: 'center',
          x: 0.5,
          y: 0.85,
        } as TextLayerConfig),
      ]),
  },
  {
    id: 'blank',
    name: 'Blank Canvas',
    description: 'Empty 1200x600 canvas',
    factory: () => defaultMintDocument(),
  },
];

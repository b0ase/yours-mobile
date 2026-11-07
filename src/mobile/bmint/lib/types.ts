/** bMint note designer types. Ported from bcorp-mint (lib/types.ts) (The Bitcoin Corporation Mint, Open BSV License). */

export type MintBlendMode = 'source-over' | 'multiply' | 'screen' | 'overlay' | 'soft-light';

export type GuillocheConfig = {
  waves: number;
  frequency: number;
  amplitude: number;
  lines: number;
  strokeWidth: number;
  color: string;
  phase: number;
  damping: number;
};

export type RosetteConfig = {
  petals: number;
  rings: number;
  radius: number;
  strokeWidth: number;
  color: string;
  rotation: number;
  innerRadius: number;
};

export type FineLineConfig = {
  angle: number;
  spacing: number;
  strokeWidth: number;
  color: string;
  wave: boolean;
  waveAmplitude: number;
  waveFrequency: number;
};

export type BorderConfig = {
  style: 'classic' | 'ornate' | 'geometric' | 'art-deco';
  thickness: number;
  color: string;
  cornerStyle: 'square' | 'rounded' | 'ornament';
  innerBorder: boolean;
  innerGap: number;
};

export type MicroprintConfig = {
  text: string;
  fontSize: number;
  color: string;
  rows: number;
  angle: number;
  spacing: number;
};

export type TextLayerConfig = {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  letterSpacing: number;
  align: 'left' | 'center' | 'right';
  x: number;
  y: number;
};

export type ImageLayerConfig = {
  src: string;
  fit: 'cover' | 'contain' | 'fill';
  x: number;
  y: number;
  scale: number;
};

export type SerialNumberConfig = {
  prefix: string;
  startNumber: number;
  digits: number;
  fontFamily: string;
  fontSize: number;
  color: string;
  letterSpacing: number;
  x: number;
  y: number;
};

export type ThreadConfig = {
  x: number;
  width: number;
  color: string;
  text: string;
  textColor: string;
  dashed: boolean;
  dashLength: number;
  gapLength: number;
};

export type LatheConfig = {
  lineCount: number;
  strokeWidth: number;
  color: string;
  centerX: number;
  centerY: number;
  scale: number;
  rotation: number;
};

export type GradientConfig = {
  type: 'linear' | 'radial';
  colors: string[];
  angle: number;
  opacity: number;
};

export type QRCodeConfig = {
  text: string;
  size: number;
  x: number;
  y: number;
  color: string;
  backgroundColor: string;
};

export type TextArcConfig = {
  text: string;
  fontFamily: string;
  fontSize: number;
  fontWeight: number;
  color: string;
  letterSpacing: number;
  radius: number;
  startAngle: number;
  centerX: number;
  centerY: number;
  flipText: boolean;
};

export type MoireConfig = {
  angle1: number;
  angle2: number;
  spacing: number;
  strokeWidth: number;
  color: string;
};

export type CrosshatchConfig = {
  angle: number;
  spacing: number;
  strokeWidth: number;
  color: string;
  sets: number;
};

export type StippleConfig = {
  density: number;
  dotSize: number;
  color: string;
  pattern: 'random' | 'halftone' | 'noise';
  seed: number;
};

export type WatermarkPatternConfig = {
  text: string;
  fontFamily: string;
  fontSize: number;
  color: string;
  angle: number;
  spacingX: number;
  spacingY: number;
};

export type HologramConfig = {
  colors: string[];
  angle: number;
  stripWidth: number;
  shimmer: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export type MintLayerTransform = {
  x: number;
  y: number;
  rotation: number;
  scale: number;
};

export type MintLayerConfig =
  | { type: 'image'; config: ImageLayerConfig }
  | { type: 'text'; config: TextLayerConfig }
  | { type: 'guilloche'; config: GuillocheConfig }
  | { type: 'rosette'; config: RosetteConfig }
  | { type: 'fine-line'; config: FineLineConfig }
  | { type: 'border'; config: BorderConfig }
  | { type: 'microprint'; config: MicroprintConfig }
  | { type: 'serial-number'; config: SerialNumberConfig }
  | { type: 'thread'; config: ThreadConfig }
  | { type: 'lathe'; config: LatheConfig }
  | { type: 'gradient'; config: GradientConfig }
  | { type: 'qr-code'; config: QRCodeConfig }
  | { type: 'text-arc'; config: TextArcConfig }
  | { type: 'moire'; config: MoireConfig }
  | { type: 'crosshatch'; config: CrosshatchConfig }
  | { type: 'stipple'; config: StippleConfig }
  | { type: 'watermark-pattern'; config: WatermarkPatternConfig }
  | { type: 'hologram'; config: HologramConfig };

export type MintLayerFilters = {
  hue: number; // -180 to +180 degrees
  saturation: number; // -100 to +100 (% adjustment)
  brightness: number; // -100 to +100 (% adjustment)
};

export type MintLayer = {
  id: string;
  name: string;
  visible: boolean;
  locked: boolean;
  opacity: number;
  blendMode: MintBlendMode;
  uvOnly: boolean;
  transform: MintLayerTransform;
  filters: MintLayerFilters;
} & MintLayerConfig;

export type MintDocument = {
  name: string;
  description: string;
  width: number;
  height: number;
  backgroundColor: string;
  layers: MintLayer[];
  circleMask: boolean;
  rimPattern: {
    enabled: boolean;
    teeth: number;
    depth: number;
    color: string;
  };
};

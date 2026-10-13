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

const encodeSvg = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

// Deterministic ids (each layer is its own SVG document, so ids only need to be stable, not global).
const idFor = (prefix: string, config: unknown) => {
  const str = JSON.stringify(config);
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return `${prefix}-${(h >>> 0).toString(36)}`;
};

const escapeXml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- Guilloche ---

function guillocheEnvelope(i: number, total: number, damping: number): number {
  if (total <= 1) return 1;
  const t = (i / (total - 1)) * 2 - 1; // -1 to 1
  return 1 - damping * t * t;
}

export function generateGuilloche(width: number, height: number, config: GuillocheConfig): string {
  const paths: string[] = [];
  const step = 2;

  for (let i = 0; i < config.lines; i++) {
    const baseY = (height * (i + 0.5)) / config.lines;
    const ampI = config.amplitude * guillocheEnvelope(i, config.lines, config.damping);
    const points: string[] = [];

    for (let x = 0; x <= width; x += step) {
      let y = baseY;
      for (let k = 0; k < config.waves; k++) {
        const freqK = config.frequency * (1 + k * 0.3);
        const phaseK = config.phase + k * 47;
        y += (ampI * Math.sin(((freqK * x) / width) * 2 * Math.PI + (phaseK * Math.PI) / 180)) / config.waves;
      }
      points.push(`${x.toFixed(1)},${y.toFixed(2)}`);
    }

    paths.push(
      `<polyline points="${points.join(' ')}" fill="none" stroke="${config.color}" stroke-width="${config.strokeWidth}" />`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${paths.join('\n')}
</svg>`;
}

// --- Rosette ---

export function generateRosette(width: number, height: number, config: RosetteConfig): string {
  const cx = width / 2;
  const cy = height / 2;
  const maxR = (Math.min(width, height) / 2) * config.radius;
  const innerR = maxR * config.innerRadius;
  const paths: string[] = [];
  const thetaStep = 0.02;
  const rotRad = (config.rotation * Math.PI) / 180;

  for (let r = 0; r < config.rings; r++) {
    const baseR = innerR + (maxR - innerR) * (r / Math.max(config.rings - 1, 1));
    const amp = baseR * 0.15 * (1 - r / config.rings);
    const points: string[] = [];

    for (let theta = 0; theta <= Math.PI * 2 + thetaStep; theta += thetaStep) {
      const radius = baseR + amp * Math.sin(config.petals * theta + rotRad);
      const x = cx + radius * Math.cos(theta);
      const y = cy + radius * Math.sin(theta);
      points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
    }

    paths.push(
      `<polyline points="${points.join(' ')}" fill="none" stroke="${config.color}" stroke-width="${config.strokeWidth}" />`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${paths.join('\n')}
</svg>`;
}

// --- Fine Lines ---

export function generateFineLines(width: number, height: number, config: FineLineConfig): string {
  const angleRad = (config.angle * Math.PI) / 180;
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);
  const perpX = -dy;
  const perpY = dx;

  // Calculate how many lines we need to cover the canvas
  const diagonal = Math.sqrt(width * width + height * height);
  const lineCount = Math.ceil(diagonal / config.spacing) + 2;
  const cx = width / 2;
  const cy = height / 2;

  const paths: string[] = [];

  for (let i = -lineCount / 2; i <= lineCount / 2; i++) {
    const offset = i * config.spacing;
    const startX = cx + perpX * offset - (dx * diagonal) / 2;
    const startY = cy + perpY * offset - (dy * diagonal) / 2;
    const endX = cx + perpX * offset + (dx * diagonal) / 2;
    const endY = cy + perpY * offset + (dy * diagonal) / 2;

    if (config.wave) {
      // Wavy line
      const points: string[] = [];
      const steps = 100;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const bx = startX + (endX - startX) * t;
        const by = startY + (endY - startY) * t;
        const waveOffset = config.waveAmplitude * Math.sin(config.waveFrequency * t * Math.PI * 2);
        points.push(`${(bx + perpX * waveOffset).toFixed(1)},${(by + perpY * waveOffset).toFixed(1)}`);
      }
      paths.push(
        `<polyline points="${points.join(' ')}" fill="none" stroke="${config.color}" stroke-width="${config.strokeWidth}" />`,
      );
    } else {
      paths.push(
        `<line x1="${startX.toFixed(1)}" y1="${startY.toFixed(1)}" x2="${endX.toFixed(1)}" y2="${endY.toFixed(1)}" stroke="${config.color}" stroke-width="${config.strokeWidth}" />`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${paths.join('\n')}
</svg>`;
}

// --- Border ---

export function generateBorder(width: number, height: number, config: BorderConfig): string {
  const t = config.thickness;
  const r = config.cornerStyle === 'rounded' ? t * 0.4 : 0;
  const parts: string[] = [];

  if (config.style === 'classic') {
    parts.push(
      `<rect x="${t * 0.1}" y="${t * 0.1}" width="${width - t * 0.2}" height="${height - t * 0.2}" rx="${r}" fill="none" stroke="${config.color}" stroke-width="${t * 0.15}" />`,
    );
    parts.push(
      `<rect x="${t * 0.4}" y="${t * 0.4}" width="${width - t * 0.8}" height="${height - t * 0.8}" rx="${r * 0.8}" fill="none" stroke="${config.color}" stroke-width="${t * 0.08}" opacity="0.6" />`,
    );
    if (config.innerBorder) {
      const gap = config.innerGap;
      parts.push(
        `<rect x="${t + gap}" y="${t + gap}" width="${width - (t + gap) * 2}" height="${height - (t + gap) * 2}" rx="${r * 0.5}" fill="none" stroke="${config.color}" stroke-width="${t * 0.04}" opacity="0.4" />`,
      );
    }
  } else if (config.style === 'ornate') {
    // Outer frame
    parts.push(
      `<rect x="${t * 0.1}" y="${t * 0.1}" width="${width - t * 0.2}" height="${height - t * 0.2}" rx="${r}" fill="none" stroke="${config.color}" stroke-width="${t * 0.12}" />`,
    );
    // Inner frame
    parts.push(
      `<rect x="${t * 0.5}" y="${t * 0.5}" width="${width - t}" height="${height - t}" rx="${r * 0.6}" fill="none" stroke="${config.color}" stroke-width="${t * 0.06}" opacity="0.5" />`,
    );
    // Ornament dots along edges
    const dotSpacing = 20;
    const dotR = t * 0.04;
    for (let x = t; x < width - t; x += dotSpacing) {
      parts.push(`<circle cx="${x}" cy="${t * 0.3}" r="${dotR}" fill="${config.color}" opacity="0.5" />`);
      parts.push(`<circle cx="${x}" cy="${height - t * 0.3}" r="${dotR}" fill="${config.color}" opacity="0.5" />`);
    }
    for (let y = t; y < height - t; y += dotSpacing) {
      parts.push(`<circle cx="${t * 0.3}" cy="${y}" r="${dotR}" fill="${config.color}" opacity="0.5" />`);
      parts.push(`<circle cx="${width - t * 0.3}" cy="${y}" r="${dotR}" fill="${config.color}" opacity="0.5" />`);
    }
    if (config.innerBorder) {
      const gap = config.innerGap;
      parts.push(
        `<rect x="${t + gap}" y="${t + gap}" width="${width - (t + gap) * 2}" height="${height - (t + gap) * 2}" rx="${r * 0.4}" fill="none" stroke="${config.color}" stroke-width="${t * 0.03}" opacity="0.3" />`,
      );
    }
    // Corner ornaments
    if (config.cornerStyle === 'ornament') {
      const cs = t * 0.6;
      const corners = [
        [0, 0],
        [width, 0],
        [0, height],
        [width, height],
      ];
      for (const [cx, cy] of corners) {
        parts.push(
          `<circle cx="${cx}" cy="${cy}" r="${cs}" fill="none" stroke="${config.color}" stroke-width="${t * 0.05}" opacity="0.4" />`,
        );
        parts.push(
          `<circle cx="${cx}" cy="${cy}" r="${cs * 0.5}" fill="none" stroke="${config.color}" stroke-width="${t * 0.03}" opacity="0.3" />`,
        );
      }
    }
  } else if (config.style === 'geometric') {
    const step = t * 0.2;
    for (let i = 0; i < 3; i++) {
      const inset = i * step;
      const sw = t * (0.12 - i * 0.03);
      parts.push(
        `<rect x="${inset}" y="${inset}" width="${width - inset * 2}" height="${height - inset * 2}" fill="none" stroke="${config.color}" stroke-width="${sw}" opacity="${1 - i * 0.25}" />`,
      );
    }
    if (config.innerBorder) {
      const gap = config.innerGap;
      parts.push(
        `<rect x="${t + gap}" y="${t + gap}" width="${width - (t + gap) * 2}" height="${height - (t + gap) * 2}" fill="none" stroke="${config.color}" stroke-width="${t * 0.04}" opacity="0.3" />`,
      );
    }
  } else if (config.style === 'art-deco') {
    // Stepped corners art deco style
    parts.push(
      `<rect x="${t * 0.1}" y="${t * 0.1}" width="${width - t * 0.2}" height="${height - t * 0.2}" rx="0" fill="none" stroke="${config.color}" stroke-width="${t * 0.15}" />`,
    );
    const stepSize = t * 0.25;
    const steps = 3;
    // Corner steps at each corner
    for (const [sx, sy, dirX, dirY] of [
      [0, 0, 1, 1],
      [width, 0, -1, 1],
      [0, height, 1, -1],
      [width, height, -1, -1],
    ] as [number, number, number, number][]) {
      for (let s = 0; s < steps; s++) {
        const offset = s * stepSize;
        const len = t - offset;
        parts.push(
          `<line x1="${sx + dirX * offset}" y1="${sy + dirY * offset}" x2="${sx + dirX * (offset + len * 0.3)}" y2="${sy + dirY * offset}" stroke="${config.color}" stroke-width="${t * 0.04}" opacity="${0.5 - s * 0.1}" />`,
        );
        parts.push(
          `<line x1="${sx + dirX * offset}" y1="${sy + dirY * offset}" x2="${sx + dirX * offset}" y2="${sy + dirY * (offset + len * 0.3)}" stroke="${config.color}" stroke-width="${t * 0.04}" opacity="${0.5 - s * 0.1}" />`,
        );
      }
    }
    if (config.innerBorder) {
      const gap = config.innerGap;
      parts.push(
        `<rect x="${t + gap}" y="${t + gap}" width="${width - (t + gap) * 2}" height="${height - (t + gap) * 2}" fill="none" stroke="${config.color}" stroke-width="${t * 0.05}" opacity="0.35" />`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${parts.join('\n')}
</svg>`;
}

// --- Microprint ---

export function generateMicroprint(width: number, height: number, config: MicroprintConfig): string {
  const safeText = escapeXml(config.text || 'THE MINT');
  // Repeat text enough to fill width
  const repeatCount = Math.ceil(width / (safeText.length * config.fontSize * 0.6)) + 2;
  const fullText = Array(repeatCount).fill(safeText).join(' ');

  const rows: string[] = [];
  const totalHeight = config.rows * config.spacing;
  const startY = (height - totalHeight) / 2;

  for (let i = 0; i < config.rows; i++) {
    const y = startY + i * config.spacing + config.fontSize;
    rows.push(
      `<text x="0" y="${y}" font-size="${config.fontSize}" fill="${config.color}" font-family="'IBM Plex Mono', monospace" letter-spacing="0.5">${fullText}</text>`,
    );
  }

  const transform = config.angle !== 0 ? ` transform="rotate(${config.angle} ${width / 2} ${height / 2})"` : '';

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<g${transform}>
${rows.join('\n')}
</g>
</svg>`;
}

// --- Text ---

export function generateTextLayer(width: number, height: number, config: TextLayerConfig): string {
  const safeText = escapeXml(config.text || 'TEXT');
  const x = width * config.x;
  const y = height * config.y;
  const anchor = config.align === 'left' ? 'start' : config.align === 'right' ? 'end' : 'middle';
  const fontStack = `'${config.fontFamily}', 'Helvetica Neue', Arial, sans-serif`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<text x="${x}" y="${y}" text-anchor="${anchor}" dominant-baseline="middle" font-family="${fontStack}" font-weight="${config.fontWeight}" font-size="${config.fontSize}" letter-spacing="${config.letterSpacing}" fill="${config.color}">${safeText}</text>
</svg>`;
}

// --- Image layer (returns empty SVG — drawn directly from src) ---

export function generateImageLayer(width: number, height: number, _config: ImageLayerConfig): string {
  // Image layers are drawn directly onto the canvas from their src.
  // Return a transparent SVG as a placeholder for the cache.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"></svg>`;
}

// --- Serial Number ---

export function generateSerialNumber(width: number, height: number, config: SerialNumberConfig): string {
  const serial = config.prefix + String(config.startNumber).padStart(config.digits, '0');
  const safeText = escapeXml(serial);
  const x = width * config.x;
  const y = height * config.y;
  const fontStack = `'${config.fontFamily}', 'IBM Plex Mono', monospace`;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="middle" font-family="${fontStack}" font-weight="500" font-size="${config.fontSize}" letter-spacing="${config.letterSpacing}" fill="${config.color}">${safeText}</text>
</svg>`;
}

// --- Foil Thread ---

export function generateThread(width: number, height: number, config: ThreadConfig): string {
  const x = width * config.x;
  const parts: string[] = [];

  if (config.dashed) {
    // Windowed thread — alternating visible/hidden segments
    let y = 0;
    let visible = true;
    while (y < height) {
      const segLen = visible ? config.dashLength : config.gapLength;
      if (visible) {
        parts.push(
          `<rect x="${x - config.width / 2}" y="${y}" width="${config.width}" height="${Math.min(segLen, height - y)}" fill="${config.color}" />`,
        );
      }
      y += segLen;
      visible = !visible;
    }
  } else {
    parts.push(
      `<rect x="${x - config.width / 2}" y="0" width="${config.width}" height="${height}" fill="${config.color}" />`,
    );
  }

  // Text along thread (rotated 90 degrees)
  if (config.text) {
    const safeText = escapeXml(config.text);
    const repeated = Array(Math.ceil(height / 80))
      .fill(safeText)
      .join('  ');
    parts.push(
      `<text transform="translate(${x + config.width / 2 + 2}, 0) rotate(90)" font-size="6" fill="${config.textColor}" font-family="'IBM Plex Mono', monospace" letter-spacing="2">${repeated}</text>`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${parts.join('\n')}
</svg>`;
}

// --- Lathe / Engine Turning ---

export function generateLathe(width: number, height: number, config: LatheConfig): string {
  const cx = width * config.centerX;
  const cy = height * config.centerY;
  const maxR = Math.max(width, height) * config.scale;
  const rotRad = (config.rotation * Math.PI) / 180;
  const paths: string[] = [];

  for (let i = 0; i < config.lineCount; i++) {
    const angle = (i / config.lineCount) * Math.PI * 2 + rotRad;
    const x2 = cx + Math.cos(angle) * maxR;
    const y2 = cy + Math.sin(angle) * maxR;
    paths.push(
      `<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${config.color}" stroke-width="${config.strokeWidth}" />`,
    );
  }

  // Add concentric circles for the engine-turned look
  const rings = 8;
  for (let r = 1; r <= rings; r++) {
    const radius = (maxR / rings) * r * 0.5;
    paths.push(
      `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${radius.toFixed(1)}" fill="none" stroke="${config.color}" stroke-width="${config.strokeWidth * 0.5}" opacity="0.5" />`,
    );
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${paths.join('\n')}
</svg>`;
}

// --- Gradient ---

export function generateGradient(width: number, height: number, config: GradientConfig): string {
  const id = idFor('grad', config);
  let gradDef: string;

  if (config.type === 'radial') {
    const stops = config.colors
      .map((color, i) => {
        const offset = config.colors.length > 1 ? (i / (config.colors.length - 1)) * 100 : 0;
        return `<stop offset="${offset}%" stop-color="${color}" />`;
      })
      .join('\n');
    gradDef = `<radialGradient id="${id}" cx="50%" cy="50%" r="70%">\n${stops}\n</radialGradient>`;
  } else {
    const angleRad = (config.angle * Math.PI) / 180;
    const x1 = 50 - Math.cos(angleRad) * 50;
    const y1 = 50 - Math.sin(angleRad) * 50;
    const x2 = 50 + Math.cos(angleRad) * 50;
    const y2 = 50 + Math.sin(angleRad) * 50;
    const stops = config.colors
      .map((color, i) => {
        const offset = config.colors.length > 1 ? (i / (config.colors.length - 1)) * 100 : 0;
        return `<stop offset="${offset}%" stop-color="${color}" />`;
      })
      .join('\n');
    gradDef = `<linearGradient id="${id}" x1="${x1.toFixed(1)}%" y1="${y1.toFixed(1)}%" x2="${x2.toFixed(1)}%" y2="${y2.toFixed(1)}%">\n${stops}\n</linearGradient>`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>${gradDef}</defs>
<rect width="${width}" height="${height}" fill="url(#${id})" opacity="${config.opacity}" />
</svg>`;
}

// --- QR Code (deterministic binary matrix from text) ---

function simpleHash(text: string): number[] {
  // Simple deterministic hash to generate a binary matrix from text
  const bytes: number[] = [];
  let h = 0x811c9dc5;
  for (let i = 0; i < 256; i++) {
    const ch = text.charCodeAt(i % text.length);
    h ^= ch;
    h = Math.imul(h, 0x01000193);
    bytes.push((h >>> 24) & 0xff);
  }
  return bytes;
}

export function generateQRCode(width: number, height: number, config: QRCodeConfig): string {
  const minDim = Math.min(width, height);
  const qrSize = minDim * config.size;
  const modules = 21; // QR version 1 is 21x21
  const cellSize = qrSize / modules;
  const ox = width * config.x - qrSize / 2;
  const oy = height * config.y - qrSize / 2;

  const hashBytes = simpleHash(config.text || 'THE MINT');
  const parts: string[] = [];

  // Background
  if (config.backgroundColor !== 'transparent') {
    parts.push(`<rect x="${ox}" y="${oy}" width="${qrSize}" height="${qrSize}" fill="${config.backgroundColor}" />`);
  }

  // Finder patterns (3 corner squares)
  const drawFinder = (fx: number, fy: number) => {
    parts.push(`<rect x="${fx}" y="${fy}" width="${cellSize * 7}" height="${cellSize * 7}" fill="${config.color}" />`);
    parts.push(
      `<rect x="${fx + cellSize}" y="${fy + cellSize}" width="${cellSize * 5}" height="${cellSize * 5}" fill="${config.backgroundColor === 'transparent' ? '#000' : config.backgroundColor}" />`,
    );
    parts.push(
      `<rect x="${fx + cellSize * 2}" y="${fy + cellSize * 2}" width="${cellSize * 3}" height="${cellSize * 3}" fill="${config.color}" />`,
    );
  };

  drawFinder(ox, oy);
  drawFinder(ox + cellSize * (modules - 7), oy);
  drawFinder(ox, oy + cellSize * (modules - 7));

  // Data modules from hash
  let byteIdx = 0;
  for (let row = 0; row < modules; row++) {
    for (let col = 0; col < modules; col++) {
      // Skip finder pattern areas
      if ((row < 8 && col < 8) || (row < 8 && col >= modules - 8) || (row >= modules - 8 && col < 8)) continue;
      const bit = (hashBytes[byteIdx % hashBytes.length] >> (col % 8)) & 1;
      byteIdx++;
      if (bit) {
        parts.push(
          `<rect x="${ox + col * cellSize}" y="${oy + row * cellSize}" width="${cellSize}" height="${cellSize}" fill="${config.color}" />`,
        );
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${parts.join('\n')}
</svg>`;
}

// --- Text Arc (text on circular path) ---

export function generateTextArc(width: number, height: number, config: TextArcConfig): string {
  const cx = width * config.centerX;
  const cy = height * config.centerY;
  const r = Math.min(width, height) * config.radius;
  const safeText = escapeXml(config.text || 'TEXT');
  const fontStack = `'${config.fontFamily}', 'Helvetica Neue', Arial, sans-serif`;
  const pathId = idFor('arc', config);

  // Create circular path
  const startAngleRad = (config.startAngle * Math.PI) / 180;
  let pathD: string;

  if (config.flipText) {
    // Text on inside of arc (clockwise from bottom)
    pathD = `M ${cx + r * Math.cos(startAngleRad)} ${cy + r * Math.sin(startAngleRad)} A ${r} ${r} 0 1 0 ${cx + r * Math.cos(startAngleRad + 0.001)} ${cy + r * Math.sin(startAngleRad + 0.001)}`;
  } else {
    // Text on outside of arc (counter-clockwise path)
    pathD = `M ${cx + r * Math.cos(startAngleRad)} ${cy + r * Math.sin(startAngleRad)} A ${r} ${r} 0 1 1 ${cx + r * Math.cos(startAngleRad - 0.001)} ${cy + r * Math.sin(startAngleRad - 0.001)}`;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
<defs>
  <path id="${pathId}" d="${pathD}" fill="none" />
</defs>
<text font-family="${fontStack}" font-weight="${config.fontWeight}" font-size="${config.fontSize}" fill="${config.color}" letter-spacing="${config.letterSpacing}">
  <textPath href="#${pathId}" startOffset="0">${safeText}</textPath>
</text>
</svg>`;
}

// --- Moiré Pattern (two overlapping line grids) ---

export function generateMoire(width: number, height: number, config: MoireConfig): string {
  const parts: string[] = [];
  const diagonal = Math.sqrt(width * width + height * height);

  for (const angle of [config.angle1, config.angle2]) {
    const angleRad = (angle * Math.PI) / 180;
    const dx = Math.cos(angleRad);
    const dy = Math.sin(angleRad);
    const perpX = -dy;
    const perpY = dx;
    const cx = width / 2;
    const cy = height / 2;
    const lineCount = Math.ceil(diagonal / config.spacing) + 2;

    for (let i = -lineCount / 2; i <= lineCount / 2; i++) {
      const offset = i * config.spacing;
      const x1 = cx + perpX * offset - (dx * diagonal) / 2;
      const y1 = cy + perpY * offset - (dy * diagonal) / 2;
      const x2 = cx + perpX * offset + (dx * diagonal) / 2;
      const y2 = cy + perpY * offset + (dy * diagonal) / 2;
      parts.push(
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${config.color}" stroke-width="${config.strokeWidth}" />`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${parts.join('\n')}
</svg>`;
}

// --- Crosshatch ---

export function generateCrosshatch(width: number, height: number, config: CrosshatchConfig): string {
  const parts: string[] = [];
  const diagonal = Math.sqrt(width * width + height * height);
  const cx = width / 2;
  const cy = height / 2;

  for (let s = 0; s < config.sets; s++) {
    const angle = config.angle + (s * 180) / config.sets;
    const angleRad = (angle * Math.PI) / 180;
    const dx = Math.cos(angleRad);
    const dy = Math.sin(angleRad);
    const perpX = -dy;
    const perpY = dx;
    const lineCount = Math.ceil(diagonal / config.spacing) + 2;

    for (let i = -lineCount / 2; i <= lineCount / 2; i++) {
      const offset = i * config.spacing;
      const x1 = cx + perpX * offset - (dx * diagonal) / 2;
      const y1 = cy + perpY * offset - (dy * diagonal) / 2;
      const x2 = cx + perpX * offset + (dx * diagonal) / 2;
      const y2 = cy + perpY * offset + (dy * diagonal) / 2;
      parts.push(
        `<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="${config.color}" stroke-width="${config.strokeWidth}" />`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${parts.join('\n')}
</svg>`;
}

// --- Stipple ---

function seededRandom(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

export function generateStipple(width: number, height: number, config: StippleConfig): string {
  const rand = seededRandom(config.seed);
  const area = width * height;
  const dotCount = Math.floor((area / 1000) * config.density);
  const parts: string[] = [];

  if (config.pattern === 'halftone') {
    // Grid-based halftone with size variation
    const gridSize = Math.sqrt(area / dotCount);
    for (let y = gridSize / 2; y < height; y += gridSize) {
      for (let x = gridSize / 2; x < width; x += gridSize) {
        const sizeVar = 0.5 + rand() * 0.5;
        parts.push(
          `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${(config.dotSize * sizeVar).toFixed(2)}" fill="${config.color}" />`,
        );
      }
    }
  } else if (config.pattern === 'noise') {
    // Perlin-noise-like clusters
    for (let i = 0; i < dotCount; i++) {
      const x = rand() * width;
      const y = rand() * height;
      const cluster = Math.sin(x * 0.05) * Math.cos(y * 0.05);
      if (cluster + rand() * 0.5 > 0.2) {
        parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${config.dotSize}" fill="${config.color}" />`);
      }
    }
  } else {
    // random
    for (let i = 0; i < dotCount; i++) {
      const x = rand() * width;
      const y = rand() * height;
      parts.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${config.dotSize}" fill="${config.color}" />`);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${parts.join('\n')}
</svg>`;
}

// --- Watermark Pattern (tiled repeated text) ---

export function generateWatermarkPattern(width: number, height: number, config: WatermarkPatternConfig): string {
  const safeText = escapeXml(config.text || 'WATERMARK');
  const fontStack = `'${config.fontFamily}', 'Helvetica Neue', Arial, sans-serif`;
  const parts: string[] = [];

  // Generate enough tiles to cover the rotated area
  const padding = Math.max(width, height) * 0.5;

  for (let y = -padding; y < height + padding; y += config.spacingY) {
    for (let x = -padding; x < width + padding; x += config.spacingX) {
      parts.push(
        `<text x="${x}" y="${y}" font-family="${fontStack}" font-size="${config.fontSize}" fill="${config.color}" transform="rotate(${config.angle} ${x} ${y})">${safeText}</text>`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${parts.join('\n')}
</svg>`;
}

// --- Hologram (iridescent color-shifting foil) ---

export function generateHologram(width: number, height: number, config: HologramConfig): string {
  const hx = width * config.x;
  const hy = height * config.y;
  const hw = width * config.width;
  const hh = height * config.height;
  const id = idFor('holo', config);
  const parts: string[] = [];

  // Create iridescent strips
  const angleRad = (config.angle * Math.PI) / 180;
  const stripCount = Math.ceil(Math.max(hw, hh) / config.stripWidth) + 2;

  // Clip to hologram area
  parts.push(`<defs>`);
  parts.push(`<clipPath id="${id}-clip"><rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" rx="4" /></clipPath>`);

  // Rainbow gradient for each strip
  const colors =
    config.colors.length > 0 ? config.colors : ['#ff0080', '#8000ff', '#0080ff', '#00ff80', '#ffff00', '#ff0080'];
  const stops = colors
    .map((c, i) => {
      const offset = colors.length > 1 ? (i / (colors.length - 1)) * 100 : 0;
      return `<stop offset="${offset}%" stop-color="${c}" />`;
    })
    .join('');
  parts.push(`<linearGradient id="${id}-grad" x1="0%" y1="0%" x2="100%" y2="0%">${stops}</linearGradient>`);
  parts.push(`</defs>`);

  // Base hologram with gradient
  parts.push(`<g clip-path="url(#${id}-clip)">`);
  parts.push(`<rect x="${hx}" y="${hy}" width="${hw}" height="${hh}" fill="url(#${id}-grad)" opacity="0.6" />`);

  // Shimmer strips
  const dx = Math.cos(angleRad);
  const dy = Math.sin(angleRad);
  for (let i = 0; i < stripCount; i++) {
    const offset = i * config.stripWidth;
    const opacity = 0.1 + config.shimmer * 0.3 * Math.abs(Math.sin(i * 0.8));
    const perpX = hx - dy * offset + dx * hw;
    const perpY = hy + dx * offset + dy * hw;
    parts.push(
      `<line x1="${hx - dy * offset}" y1="${hy + dx * offset}" x2="${perpX}" y2="${perpY}" stroke="rgba(255,255,255,${opacity})" stroke-width="${config.stripWidth * 0.5}" />`,
    );
  }

  parts.push(`</g>`);

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
${parts.join('\n')}
</svg>`;
}

// --- Unified generator ---

export type PatternGenerator = (width: number, height: number, config: unknown) => string;

export const generators: Record<string, PatternGenerator> = {
  guilloche: (w, h, c) => generateGuilloche(w, h, c as GuillocheConfig),
  rosette: (w, h, c) => generateRosette(w, h, c as RosetteConfig),
  'fine-line': (w, h, c) => generateFineLines(w, h, c as FineLineConfig),
  border: (w, h, c) => generateBorder(w, h, c as BorderConfig),
  microprint: (w, h, c) => generateMicroprint(w, h, c as MicroprintConfig),
  text: (w, h, c) => generateTextLayer(w, h, c as TextLayerConfig),
  image: (w, h, c) => generateImageLayer(w, h, c as ImageLayerConfig),
  'serial-number': (w, h, c) => generateSerialNumber(w, h, c as SerialNumberConfig),
  thread: (w, h, c) => generateThread(w, h, c as ThreadConfig),
  lathe: (w, h, c) => generateLathe(w, h, c as LatheConfig),
  gradient: (w, h, c) => generateGradient(w, h, c as GradientConfig),
  'qr-code': (w, h, c) => generateQRCode(w, h, c as QRCodeConfig),
  'text-arc': (w, h, c) => generateTextArc(w, h, c as TextArcConfig),
  moire: (w, h, c) => generateMoire(w, h, c as MoireConfig),
  crosshatch: (w, h, c) => generateCrosshatch(w, h, c as CrosshatchConfig),
  stipple: (w, h, c) => generateStipple(w, h, c as StippleConfig),
  'watermark-pattern': (w, h, c) => generateWatermarkPattern(w, h, c as WatermarkPatternConfig),
  hologram: (w, h, c) => generateHologram(w, h, c as HologramConfig),
};

export { encodeSvg };

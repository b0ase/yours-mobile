/** Pure SVG helpers for the note designer: font embedding and the vector export. */
import { encodeSvg, generators } from './mint-patterns';
import type { MintDocument } from './types';

/** Insert @font-face rules (family → rules) for the families an SVG string uses. */
export function withFonts(svg: string, rules: ReadonlyMap<string, string>): string {
  if (!svg.includes('font-family')) return svg;
  const css = [...rules]
    .filter(([fam]) => svg.includes(fam))
    .map(([, r]) => r)
    .join('');
  if (!css) return svg;
  return svg.replace(/<svg\b[^>]*>/, (open) => `${open}<defs><style>${css}</style></defs>`);
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The whole design as one vector SVG: each visible layer is its generator's SVG (or the image)
 * nested with the layer's opacity, blend, transform and filters. UV-only layers are left out, the
 * same as a normal-light PNG export.
 */
export function composeSvg(doc: MintDocument, fonts: ReadonlyMap<string, string> = new Map()): string {
  const { width: w, height: h } = doc;
  const parts: string[] = [];
  for (const layer of doc.layers) {
    if (!layer.visible || layer.uvOnly) continue;
    let inner = '';
    if (layer.type === 'image') {
      const { src, fit } = layer.config;
      if (!src) continue;
      const par = fit === 'fill' ? 'none' : fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet';
      inner = `<image href="${esc(src)}" width="${w}" height="${h}" preserveAspectRatio="${par}"/>`;
    } else {
      const gen = generators[layer.type];
      if (!gen) continue;
      inner = `<image href="${esc(encodeSvg(withFonts(gen(w, h, layer.config), fonts)))}" width="${w}" height="${h}"/>`;
    }
    const t = layer.transform ?? { x: 0, y: 0, rotation: 0, scale: 1 };
    const tf =
      t.x || t.y || t.rotation || t.scale !== 1
        ? ` transform="translate(${w / 2 + t.x} ${h / 2 + t.y}) rotate(${t.rotation}) scale(${t.scale}) translate(${-w / 2} ${-h / 2})"`
        : '';
    const f = layer.filters ?? { hue: 0, saturation: 0, brightness: 0 };
    const filter =
      f.hue || f.saturation || f.brightness
        ? `filter:hue-rotate(${f.hue}deg) saturate(${100 + f.saturation}%) brightness(${100 + f.brightness}%);`
        : '';
    const blend = layer.blendMode === 'source-over' ? '' : `mix-blend-mode:${layer.blendMode};`;
    parts.push(`<g opacity="${layer.opacity}"${tf} style="${blend}${filter}">${inner}</g>`);
  }
  const clip = doc.circleMask
    ? `<defs><clipPath id="m"><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 2}"/></clipPath></defs>`
    : '';
  const body = `<rect width="${w}" height="${h}" fill="${esc(doc.backgroundColor)}"/>${parts.join('')}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `${clip}${doc.circleMask ? `<g clip-path="url(#m)">${body}</g>` : body}</svg>`
  );
}

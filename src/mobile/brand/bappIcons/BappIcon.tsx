import { useMemo } from 'react';
import { bappIconUrl } from './api';

/** A bApp icon at `size` px, laid out for that size (see render.ts). */
export const BappIcon = ({
  slug,
  size = 64,
  label,
  color,
  className,
}: {
  slug: string;
  size?: number;
  /** For the fallback initial when the slug has no glyph yet. */
  label?: string;
  color?: string;
  className?: string;
}) => {
  const src = useMemo(() => bappIconUrl(slug, size, { label, color }), [slug, size, label, color]);
  return <img src={src} width={size} height={size} alt="" draggable={false} className={className} />;
};

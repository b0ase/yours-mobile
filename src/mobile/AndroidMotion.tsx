import { Capacitor } from '@capacitor/core';
import { MotionConfig } from 'framer-motion';
import type { ReactNode } from 'react';

/**
 * Android WebView keeps stale raster tiles of elements framer-motion animates
 * with transforms (variants y/scale, whileTap) inside non-composited scrollers,
 * leaving ghost copies of rows painted over other content. On Android, skip
 * transform animations app-wide (opacity still animates). iOS is untouched.
 */
const isAndroid = Capacitor.getPlatform() === 'android';

export const AndroidMotion = ({ children }: { children: ReactNode }) =>
  isAndroid ? <MotionConfig reducedMotion="always">{children}</MotionConfig> : <>{children}</>;

import { mergeConfig } from 'vite';
import { resolve } from 'path';
import mobile from './vite.config.mobile';

/** Developer bench for the native chat (src/mobile/nativeChat/bench). Never part of a normal or store build. */
export default mergeConfig(mobile, {
  build: { rollupOptions: { input: { ncbench: resolve(__dirname, 'ncbench.html') } } },
});

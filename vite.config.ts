import { defineConfig, mergeConfig } from 'vite';
import baseConfig from './vite.config.base';
import { brandDefines, extensionBrandPlugins } from './vite.brand';

// Extension popup/pages: the shared base config plus the brand switch (BRAND env, default bcorp).
export default mergeConfig(
  baseConfig,
  defineConfig({
    plugins: extensionBrandPlugins({ emitAvatar: true }),
    define: brandDefines(),
  }),
);

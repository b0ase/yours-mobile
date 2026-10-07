import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';

// Draco was missing until 5.1.79: 4 of the 45 GLB listings on the 1Sat order book (7 Oct 2026: "Limited edition",
// ArtOnBSV_4, BSVLuxuryGold) require KHR_draco_mesh_compression, and three.js rejects them without a DRACOLoader.
let draco: DRACOLoader | null = null;

/**
 * A GLTFLoader with Meshopt and Draco wired up. DRACOLoader's default decoder paths are three's own
 * draco_wasm_wrapper.js + draco_decoder.wasm via new URL(..., import.meta.url), so Vite bundles them with the
 * app: self-hosted, no CDN, works offline and in WKWebView. The decoder runs in a worker from a blob: URL.
 */
export function createGltfLoader(decoderPath?: string): GLTFLoader {
  if (!draco) {
    draco = new DRACOLoader().setDecoderConfig({ type: 'wasm' });
    if (decoderPath) draco.setDecoderPath(decoderPath); // tests only
  }
  return new GLTFLoader().setMeshoptDecoder(MeshoptDecoder).setDRACOLoader(draco);
}

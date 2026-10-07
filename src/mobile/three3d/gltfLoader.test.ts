import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createGltfLoader } from './gltfLoader';

/** A minimal .glb whose glTF JSON requires the given extensions (no meshes, so nothing is decoded). */
const glb = (json: object): ArrayBuffer => {
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const body = new TextEncoder().encode(text);
  const out = new ArrayBuffer(20 + body.length);
  const v = new DataView(out);
  v.setUint32(0, 0x46546c67, true); // 'glTF'
  v.setUint32(4, 2, true);
  v.setUint32(8, out.byteLength, true);
  v.setUint32(12, body.length, true);
  v.setUint32(16, 0x4e4f534a, true); // 'JSON'
  new Uint8Array(out, 20).set(body);
  return out;
};

// Same shape as the Draco listings in Market › 3D (e.g. ArtOnBSV_4, BSVLuxuryGold).
const DRACO_GLB = glb({
  asset: { version: '2.0' },
  extensionsUsed: ['KHR_draco_mesh_compression', 'KHR_materials_specular'],
  extensionsRequired: ['KHR_draco_mesh_compression'],
  scenes: [{ nodes: [] }],
  scene: 0,
});

const parse = (loader: GLTFLoader, buf: ArrayBuffer) =>
  new Promise<unknown>((resolve, reject) => loader.parse(buf, '', resolve, reject));

describe('Market › 3D model loader', () => {
  // DRACOLoader fetches its decoder up front; answer locally so the test never touches the network.
  const realFetch = globalThis.fetch;
  beforeAll(() => {
    globalThis.fetch = (async () => new Response(new ArrayBuffer(0))) as unknown as typeof fetch;
  });
  afterAll(() => {
    globalThis.fetch = realFetch;
  });

  test('a bare GLTFLoader rejects Draco GLBs (the 5.1.78 viewer bug)', async () => {
    await expect(parse(new GLTFLoader(), DRACO_GLB)).rejects.toThrow(/DRACO/i);
  });

  test('the viewer loader accepts Draco GLBs', async () => {
    const loader = createGltfLoader('http://localhost:9/draco/');
    expect(loader.dracoLoader).not.toBeNull();
    await expect(parse(loader, DRACO_GLB)).resolves.toBeDefined();
  });
});

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { createGltfLoader } from './gltfLoader';

/**
 * Still thumbnails of GLB models for grid tiles (Market › 3D, the Ordnance grid). The tiles used to show a
 * placeholder Box icon (owner's iPhone, 7 Oct 2026). iOS allows only a handful of live WebGL contexts, so tiles
 * never get one each: ONE shared offscreen renderer renders each model once, in queue order, to a PNG blob.
 * Results are cached in memory (object URLs) and in IndexedDB (blobs), keyed by the model URL.
 */
export const SNAPSHOT_SIZE = 320;
const RENDER_TIMEOUT_MS = 25_000;
const DB = 'bwallet-3d-thumbs';
const STORE = 'thumbs';

const mem = new Map<string, string>();
const failed = new Set<string>();

let dbp: Promise<IDBDatabase | null> | null = null;
const db = (): Promise<IDBDatabase | null> =>
  (dbp ??= new Promise((ok) => {
    try {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(STORE);
      r.onsuccess = () => ok(r.result);
      r.onerror = () => ok(null);
    } catch {
      ok(null);
    }
  }));

const idbGet = async (key: string): Promise<Blob | null> => {
  const d = await db();
  if (!d) return null;
  return new Promise((ok) => {
    try {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => ok(r.result instanceof Blob ? r.result : null);
      r.onerror = () => ok(null);
    } catch {
      ok(null);
    }
  });
};

const idbPut = async (key: string, blob: Blob) => {
  const d = await db();
  if (!d) return;
  try {
    d.transaction(STORE, 'readwrite').objectStore(STORE).put(blob, key);
  } catch {
    /* cache is a nicety */
  }
};

/** A snapshot already in memory, for a first paint without a skeleton flash. */
export const cachedSnapshot = (key: string): string | undefined => mem.get(key);

let renderer: THREE.WebGLRenderer | null = null;
let env: THREE.Texture | null = null;
const getRenderer = () => {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(1);
    renderer.setSize(SNAPSHOT_SIZE, SNAPSHOT_SIZE, false);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setClearColor(0x000000, 0);
    const pmrem = new THREE.PMREMGenerator(renderer);
    env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    // If iOS takes the context back, start over with a fresh renderer on the next job.
    renderer.domElement.addEventListener('webglcontextlost', () => {
      renderer = null;
      env = null;
    });
  }
  return renderer;
};

const disposeTree = (root: THREE.Object3D) => {
  root.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    m.geometry?.dispose();
    (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => {
      Object.values(mat).forEach((v) => (v as THREE.Texture)?.isTexture && (v as THREE.Texture).dispose());
      mat.dispose();
    });
  });
};

export type SnapshotOpts = { tint?: string; tintAmount?: number; turn?: number };

const render = async (url: string, opts: SnapshotOpts): Promise<Blob> => {
  // A model that never arrives (or a decoder that never answers) must not stall the whole queue.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const gltf = await Promise.race([
    createGltfLoader().loadAsync(url),
    new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error('snapshot timed out')), RENDER_TIMEOUT_MS))),
  ]).finally(() => clearTimeout(timer));
  const r = getRenderer();
  const scene = new THREE.Scene();
  scene.environment = env;
  scene.add(new THREE.AmbientLight('#ffffff', 0.5));
  const key = new THREE.DirectionalLight('#ffffff', 1.6);
  key.position.set(3, 4, 5);
  scene.add(key);
  const model = gltf.scene;
  if (opts.tint) {
    const c = new THREE.Color(opts.tint);
    model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => {
        const s = mat as THREE.MeshStandardMaterial;
        s.color?.lerp(c, opts.tintAmount ?? 0.3);
      });
    });
  }
  // Slight 3/4 view.
  model.rotation.y = (opts.turn ?? 0) + Math.PI / 5;
  model.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(model);
  if (box.isEmpty()) throw new Error('empty model');
  const sphere = box.getBoundingSphere(new THREE.Sphere());
  model.position.sub(sphere.center);
  scene.add(model);
  const camera = new THREE.PerspectiveCamera(35, 1, 0.001, 1000);
  const dist = (sphere.radius / Math.sin(THREE.MathUtils.degToRad(35) / 2)) * 1.02;
  camera.position.set(0, dist * 0.28, dist);
  camera.near = dist / 100;
  camera.far = dist * 10;
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  try {
    r.render(scene, camera);
    return await new Promise<Blob>((ok, no) =>
      r.domElement.toBlob((b) => (b ? ok(b) : no(new Error('toBlob failed'))), 'image/png'),
    );
  } finally {
    disposeTree(model);
    r.renderLists.dispose();
  }
};

type Job = { key: string; url: string; opts: SnapshotOpts; ok: (u: string) => void; no: (e: unknown) => void };
const queue: Job[] = [];
const inflight = new Map<string, Promise<string>>();
let running = false;

const pump = async () => {
  if (running) return;
  running = true;
  while (queue.length) {
    const job = queue.shift()!;
    try {
      const blob = await render(job.url, job.opts);
      const u = URL.createObjectURL(blob);
      mem.set(job.key, u);
      void idbPut(job.key, blob);
      job.ok(u);
    } catch (e) {
      failed.add(job.key);
      job.no(e);
    }
  }
  running = false;
};

/**
 * Object URL of a still of the model at `url`. Requests are served in the order they arrive (tiles ask as they
 * come into view), one at a time on the shared renderer.
 */
export const snapshot = (url: string, opts: SnapshotOpts = {}, key = url): Promise<string> => {
  const hit = mem.get(key);
  if (hit) return Promise.resolve(hit);
  if (failed.has(key)) return Promise.reject(new Error('failed before'));
  const running = inflight.get(key);
  if (running) return running;
  const p = idbGet(key).then(
    (blob) =>
      blob
        ? (() => {
            const u = URL.createObjectURL(blob);
            mem.set(key, u);
            return u;
          })()
        : new Promise<string>((ok, no) => {
            queue.push({ key, url, opts, ok, no });
            void pump();
          }),
  );
  inflight.set(key, p);
  void p.finally(() => inflight.delete(key)).catch(() => undefined);
  return p;
};

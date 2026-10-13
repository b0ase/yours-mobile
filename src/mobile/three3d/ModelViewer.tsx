import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { USDZLoader } from 'three/examples/jsm/loaders/USDZLoader.js';
import { createGltfLoader } from './gltfLoader';

/**
 * 3D NFT viewer (GLB, embedded glTF, USDZ): orbit (drag), pinch/scroll zoom, slow auto-rotate, studio lighting.
 * three.js is bundled with the app (no CDN) and this module is only ever loaded lazily, when a 3D NFT opens, so
 * it stays out of the extension popup's first bundle. One WebGL context while open; everything is disposed on close.
 * On iPhone/iPad a .usdz also offers AR Quick Look ("View in your room") where Safari supports it.
 */
const MUTED = '#98A2B3';
const GOLD = '#F5B800';

const isUsdz = (t: string) => t.split(';')[0].trim().toLowerCase() === 'model/vnd.usdz+zip';

/** AR Quick Look: Safari on iOS/iPadOS supports <a rel="ar"> with an <img> child. */
const canQuickLook = () => {
  try {
    return document.createElement('a').relList.supports('ar');
  } catch {
    return false;
  }
};

async function loadModel(src: string, contentType: string): Promise<THREE.Object3D> {
  const buf = await (await fetch(src)).arrayBuffer();
  if (isUsdz(contentType)) return new USDZLoader().parse(buf) as THREE.Object3D;
  const gltf = await createGltfLoader().parseAsync(buf, '');
  return gltf.scene;
}

export const ModelViewer = ({ src, contentType, poster }: { src: string; contentType: string; poster?: string }) => {
  const host = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | string>('loading');

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dead = false;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      setState('3D graphics (WebGL) are not available right now.');
      return;
    }
    const w = el.clientWidth || 320;
    const h = el.clientHeight || 320;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTex = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTex;
    const key = new THREE.DirectionalLight('#ffffff', 1.6);
    key.position.set(3, 4, 5);
    const rim = new THREE.DirectionalLight('#ffd27a', 1.2);
    rim.position.set(-3, 2, -3);
    scene.add(key, rim, new THREE.AmbientLight('#ffffff', 0.4));

    const camera = new THREE.PerspectiveCamera(35, w / h, 0.01, 1000);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 1.6;
    controls.addEventListener('start', () => (controls.autoRotate = false));

    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      controls.update();
      renderer.render(scene, camera);
    };
    const timeout = setTimeout(() => !dead && setState('The 3D model took too long to load.'), 60_000);
    loadModel(src, contentType)
      .then((model) => {
        clearTimeout(timeout);
        if (dead) return;
        model.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(model);
        if (box.isEmpty()) throw new Error('empty');
        const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
        model.position.sub(box.getCenter(new THREE.Vector3()));
        scene.add(model);
        const vFov = THREE.MathUtils.degToRad(camera.fov);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.08;
        camera.position.set(0, dist * 0.2, dist);
        camera.near = dist / 100;
        camera.far = dist * 20;
        camera.updateProjectionMatrix();
        controls.minDistance = dist * 0.3;
        controls.maxDistance = dist * 3;
        setState('ready');
        tick();
      })
      .catch(() => {
        clearTimeout(timeout);
        if (!dead) setState("Couldn't open this 3D model.");
      });

    const onResize = () => {
      const nw = el.clientWidth;
      const nh = el.clientHeight;
      if (!nw || !nh) return;
      renderer.setSize(nw, nh);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', onResize);
    return () => {
      dead = true;
      clearTimeout(timeout);
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry?.dispose();
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => {
          Object.values(mat).forEach((v) => (v as THREE.Texture)?.isTexture && (v as THREE.Texture).dispose());
          mat.dispose();
        });
      });
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [src, contentType]);

  return (
    <div className="relative w-full" style={{ aspectRatio: '1 / 1', maxHeight: '70vh', background: '#050506' }}>
      <div ref={host} className="absolute inset-0 touch-none" />
      {state === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: MUTED }}>
          {poster ? (
            <img src={poster} alt="" className="w-full h-full object-contain opacity-60" />
          ) : (
            'Loading 3D model…'
          )}
        </div>
      )}
      {state !== 'loading' && state !== 'ready' && (
        <div
          role="alert"
          className="absolute inset-0 flex items-center justify-center px-8 text-center text-sm"
          style={{ color: MUTED }}
        >
          {state}
        </div>
      )}
      {isUsdz(contentType) && canQuickLook() && (
        <a
          rel="ar"
          href={src}
          className="absolute bottom-3 right-3 rounded-full px-3 py-1.5 text-xs font-semibold no-underline"
          style={{ background: 'rgba(0,0,0,0.6)', color: GOLD, border: `1px solid ${GOLD}` }}
        >
          {/* Quick Look needs an <img> as the link's first child. */}
          <img src={poster || 'data:image/gif;base64,R0lGODlhAQABAAAAACw='} alt="" width={1} height={1} />
          View in AR
        </a>
      )}
    </div>
  );
};

export default ModelViewer;

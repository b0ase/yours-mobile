import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ShieldCheck, X } from 'lucide-react';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { useBackClose } from '../backStack';
import { openBapp } from '../bappFrame/bappFrame';
import { cachedExchangeRate } from '../../utils/wallet';
import { RARITY_COLOR, storeUrl, type Weapon } from './ordnance';

const MUTED = '#98A2B3';

/** Same finish as the games (tokenblaster.lol src/lib/ordnanceGun.ts): several guns share a model, the tint tells them apart. */
const tintGun = (group: THREE.Object3D, color: string | undefined, amount = 0.68) => {
  if (!color) return;
  const c = new THREE.Color(color);
  group.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh) return;
    const tint = (mat: THREE.Material) => {
      const n = mat.clone() as THREE.MeshStandardMaterial;
      if (n.color) n.color.lerp(c, amount);
      if ('metalness' in n) n.metalness = Math.max(n.metalness, 0.7);
      if (n.emissive) n.emissive.lerp(c, 0.12);
      return n;
    };
    m.material = Array.isArray(m.material) ? m.material.map(tint) : tint(m.material);
  });
};

// From tokenblaster.lol src/lib/ordnance.ts (6 Oct 2026): 18 guns now have their own textured model, which wants only a
// light tint; the 4 shared base models (and 2 untextured ones) keep the full finish. Some own models face backwards.
const BASE_MODELS = ['minigun', 'plasmarifle', 'quadplasma', 'sawedoff'];
const FULL_TINT = new Set(['utxo-thumper', 'hashpower-howitzer']);
const FLIPPED = new Set([
  'pnee-shotgun',
  'big-block',
  'satoshi-sidearm',
  'fee-spike',
  'block-reward',
  'bitcoin-schema-sniper',
  'teranode-cannon',
  'nlocktime',
  'p2pkh-pistolero',
]);
const usesBase = (w: Weapon) => BASE_MODELS.some((b) => w.model.endsWith(`/${b}.glb`));
const tintFor = (w: Weapon) => (usesBase(w) || FULL_TINT.has(w.id) ? 0.65 : 0.22);

/** Spinning, draggable model. One WebGL context, only while the cabinet is open; everything is disposed on close. */
const ModelView = ({ weapon, onError }: { weapon: Weapon; onError: () => void }) => {
  const host = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let dead = false;
    const w = el.clientWidth;
    const h = el.clientHeight;
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(w, h);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    el.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    const room = new RoomEnvironment();
    const envTex = pmrem.fromScene(room, 0.04).texture;
    scene.environment = envTex;
    const rim = new THREE.DirectionalLight(RARITY_COLOR[weapon.rarity] ?? '#ffffff', 2.2);
    rim.position.set(-3, 2, -3);
    scene.add(rim, new THREE.AmbientLight('#ffffff', 0.35));

    const camera = new THREE.PerspectiveCamera(35, w / h, 0.01, 100);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.enablePan = false;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 2.4;

    let mixer: THREE.AnimationMixer | null = null;
    const clock = new THREE.Clock();
    let frame = 0;
    const tick = () => {
      frame = requestAnimationFrame(tick);
      mixer?.update(clock.getDelta());
      controls.update();
      renderer.render(scene, camera);
    };

    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    loader.load(
      weapon.model,
      (gltf) => {
        if (dead) return;
        // The minigun is skinned: SkeletonUtils.clone, or the copy keeps following the original's bones.
        const gun = skeletonClone(gltf.scene);
        tintGun(gun, weapon.tint, tintFor(weapon));
        const isMinigun = weapon.model.endsWith('/minigun.glb');
        if (isMinigun) gun.rotation.y += Math.PI / 2; // modelled barrel-first
        if (!usesBase(weapon) && FLIPPED.has(weapon.id)) gun.rotation.y += Math.PI;
        gun.updateMatrixWorld(true);
        const box = new THREE.Box3().setFromObject(gun);
        const radius = box.getBoundingSphere(new THREE.Sphere()).radius;
        gun.position.sub(box.getCenter(new THREE.Vector3()));
        scene.add(gun);
        // Fit the whole gun in the narrower of the two fields of view (phones are tall), with a margin,
        // so it never clips while spinning.
        const vFov = THREE.MathUtils.degToRad(camera.fov);
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
        const dist = (radius / Math.sin(Math.min(vFov, hFov) / 2)) * 1.08;
        camera.position.set(0, dist * 0.18, dist);
        controls.minDistance = dist * 0.4;
        controls.maxDistance = dist * 2;
        controls.target.set(0, 0, 0);
        // The barrel spin belongs to the shared minigun model only.
        const spin = isMinigun ? gltf.animations.find((a) => /rotation/i.test(a.name)) : undefined;
        if (spin) {
          mixer = new THREE.AnimationMixer(gun);
          mixer.clipAction(spin).play();
        }
        setLoading(false);
        tick();
      },
      undefined,
      () => !dead && onError(),
    );

    const onResize = () => {
      const nw = el.clientWidth;
      const nh = el.clientHeight;
      renderer.setSize(nw, nh);
      camera.aspect = nw / nh;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', onResize);

    return () => {
      dead = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      controls.dispose();
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        m.geometry?.dispose();
        (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => mat.dispose());
      });
      envTex.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      renderer.domElement.remove();
    };
  }, [weapon]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={host} className="relative w-full h-full touch-none">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: MUTED }}>
          Loading 3D model…
        </div>
      )}
    </div>
  );
};

const usd = (sats: number) => {
  const rate = cachedExchangeRate();
  return rate > 0 ? `$${((sats / 1e8) * rate).toFixed(2)}` : `${(sats / 1e8).toLocaleString()} BSV`;
};

/**
 * The display cabinet: a 1Sat Ordnance gun as a spinning 3D model (drag to turn, pinch to zoom).
 * `owned` = a genuine issue in this wallet (shows Verified); otherwise it is a catalogue item with a Get button.
 */
export const Cabinet = ({ weapon, owned, onClose }: { weapon: Weapon; owned?: boolean; onClose: () => void }) => {
  useBackClose(true, onClose);
  const [failed, setFailed] = useState(false);
  const glow = RARITY_COLOR[weapon.rarity] ?? '#ffffff';
  return createPortal(
    <div className="fixed inset-0 z-[300] flex flex-col" style={{ background: '#050506' }}>
      <div className="flex items-center gap-2 px-4" style={{ paddingTop: 'max(env(safe-area-inset-top), 14px)' }}>
        <div className="flex-1 min-w-0">
          <div className="text-base font-bold text-white truncate">{weapon.name}</div>
          <div className="text-[11px] font-semibold uppercase tracking-wide" style={{ color: glow }}>
            {weapon.rarity} · 1Sat Ordnance
          </div>
        </div>
        <button type="button" aria-label="Close" onClick={onClose} className="p-2 border-0 bg-transparent">
          <X size={20} color={MUTED} />
        </button>
      </div>
      <div
        className="relative flex-1 min-h-0"
        style={{ background: `radial-gradient(ellipse at 50% 55%, ${glow}22, transparent 65%)` }}
      >
        {failed ? (
          <img src={weapon.image} alt={weapon.name} className="w-full h-full object-contain p-8" />
        ) : (
          <ModelView weapon={weapon} onError={() => setFailed(true)} />
        )}
      </div>
      <div
        className="px-4 pt-2 flex flex-col gap-2"
        style={{ paddingBottom: 'max(env(safe-area-inset-bottom), 16px)' }}
      >
        <p className="m-0 text-sm" style={{ color: '#D0D5DD' }}>
          {weapon.tagline}
        </p>
        <p className="m-0 text-xs leading-relaxed" style={{ color: MUTED }}>
          {weapon.description} Unlocks this gun in Double-O Kweg and the Arena. Edition of {weapon.edition}.
        </p>
        {owned ? (
          <div className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: '#3ddc97' }}>
            <ShieldCheck size={14} /> Verified: issued by tokenblaster.lol
          </div>
        ) : (
          <button
            type="button"
            onClick={() => void openBapp('TokenBlaster', storeUrl(weapon.id))}
            className="w-full rounded-xl py-3 text-sm font-bold border-0"
            style={{ background: 'linear-gradient(135deg, #de973f, #f9dd63)', color: '#1a1300' }}
          >
            Get it · {usd(weapon.priceSats)}
          </button>
        )}
      </div>
    </div>,
    document.body,
  );
};

export default Cabinet;

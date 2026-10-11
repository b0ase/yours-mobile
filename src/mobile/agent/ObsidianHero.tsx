import { useEffect, useRef, useState } from 'react';
import bGlyph from '../brand/bwalletx-glyph.svg';
import { BSPACES_ENABLED, MARKET_ENABLED } from '../storeBuild';

/**
 * Agent b's opening (owner, 11 Oct 2026): a pool of liquid obsidian with the gold b in the middle, which then makes
 * room for what b can do. Each option only fills in the message box; nothing is sent (or paid for) until Send.
 *
 * The pool is a small WebGL shader drawn at reduced resolution (cheap at 60 fps), paused while the tab is hidden.
 * Reduced motion, or no WebGL: one still frame / a plain gradient.
 */

const GOLD = '#F5B800';
const MUTED = '#98A2B3';

type Option = { label: string; prompt: string };

const OPTIONS: Option[] = [
  { label: 'Send BSV', prompt: 'Help me send BSV to someone. Ask me who to and how much.' },
  ...(MARKET_ENABLED
    ? [{ label: 'Buy a token', prompt: 'Help me buy a token. Ask me which one and how much I want to spend.' }]
    : []),
  { label: 'Lock BSV', prompt: 'Help me lock some BSV in a pot. Ask me how much, until when, and what it is for.' },
  ...(BSPACES_ENABLED
    ? [
        {
          label: 'Start a Space',
          prompt: 'Help me start a live Space in one of my rooms. Ask me which room and the topic.',
        },
      ]
    : []),
  { label: 'Fix a problem', prompt: "Something isn't working in my wallet. Help me find out what and fix it." },
];

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;
// Domain-warped noise as a height field, lit like polished volcanic glass: near-black body, soft white sheen,
// and a faint warm glow where the gold b sits.
const FRAG = `precision mediump float;
uniform vec2 r;uniform float t;
float h(vec2 p){return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453);}
float n(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);
return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}
float fbm(vec2 p){float v=0.,a=.5;for(int i=0;i<5;i++){v+=a*n(p);p=p*2.03+vec2(1.7,9.2);a*=.5;}return v;}
float H(vec2 p){vec2 q=vec2(fbm(p+t*.04),fbm(p+vec2(5.2,1.3)-t*.03));return fbm(p+2.2*q);}
void main(){
vec2 uv=(gl_FragCoord.xy-.5*r)/min(r.x,r.y);
vec2 p=uv*1.6;float e=.004;
float c=H(p);vec3 N=normalize(vec3(c-H(p+vec2(e,0)),c-H(p+vec2(0,e)),.012));
vec3 L=normalize(vec3(-.4,.6,.7));
float spec=pow(max(dot(reflect(-L,N),vec3(0,0,1)),0.),38.);
float sheen=pow(max(dot(N,normalize(vec3(.3,.2,1.))),0.),6.);
float d=length(uv);
vec3 col=vec3(.014,.014,.018)+vec3(.09,.095,.115)*sheen+vec3(.7,.71,.76)*spec*.7;
col+=vec3(.96,.72,.0)*.10*exp(-d*d*5.)*(.6+.4*sheen);
col*=smoothstep(1.25,.25,d);
gl_FragColor=vec4(col,1.);}`;

const usePool = (canvas: React.RefObject<HTMLCanvasElement | null>, still: boolean) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    const gl = el.getContext('webgl', {
      antialias: false,
      alpha: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    });
    if (!gl) return setFailed(true);
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return setFailed(true);
    gl.useProgram(prog);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uR = gl.getUniformLocation(prog, 'r');
    const uT = gl.getUniformLocation(prog, 't');
    // Half resolution, capped: the pool is soft, so this is invisible and keeps the GPU cool.
    const size = () => {
      const s = Math.min(window.devicePixelRatio || 1, 1.5) * 0.5;
      el.width = Math.max(1, Math.round(el.clientWidth * s));
      el.height = Math.max(1, Math.round(el.clientHeight * s));
      gl.viewport(0, 0, el.width, el.height);
    };
    size();
    const ro = new ResizeObserver(() => {
      size();
      if (still) draw(8);
    });
    ro.observe(el);
    const start = performance.now();
    const draw = (sec: number) => {
      gl.uniform2f(uR, el.width, el.height);
      gl.uniform1f(uT, sec);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    let raf = 0;
    const loop = () => {
      if (document.visibilityState === 'visible') draw(8 + (performance.now() - start) / 1000);
      raf = requestAnimationFrame(loop);
    };
    // Always paint one frame at once, so the pool is never a black square (e.g. a tab opened in the background).
    draw(8);
    if (!still) raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [canvas, still]);
  return failed;
};

export const ObsidianHero = ({ onPick, compact = false }: { onPick: (prompt: string) => void; compact?: boolean }) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [still] = useState(() => {
    try {
      return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  });
  const failed = usePool(canvas, still);
  // The b alone first, then the options rise in beneath it.
  const [open, setOpen] = useState(still);
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => setOpen(true), 1400);
    return () => clearTimeout(t);
  }, [open]);
  const mark = compact ? 52 : 84;
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      style={{ background: 'radial-gradient(circle at 50% 45%, #15130c 0%, #050506 45%, #010101 80%)' }}
    >
      {!failed && <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />}
      <img
        src={bGlyph}
        alt=""
        width={mark}
        height={mark}
        className="relative"
        style={{
          filter: 'drop-shadow(0 0 24px rgba(245,184,0,.45)) drop-shadow(0 6px 18px rgba(0,0,0,.8))',
          transform: open ? 'translateY(-12px) scale(.92)' : 'none',
          transition: 'transform 900ms cubic-bezier(.2,.7,.2,1)',
        }}
      />
      <div
        className="relative mt-6 flex max-w-md flex-col items-center gap-3 px-6"
        style={{
          opacity: open ? 1 : 0,
          transform: open ? 'none' : 'translateY(10px)',
          transition: 'opacity 900ms ease, transform 900ms cubic-bezier(.2,.7,.2,1)',
          pointerEvents: open ? 'auto' : 'none',
        }}
      >
        <p className="m-0 text-sm" style={{ color: MUTED }}>
          What would you like to do?
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {OPTIONS.map((o) => (
            <button
              key={o.label}
              type="button"
              onClick={() => onPick(o.prompt)}
              className="rounded-full px-4 py-2 text-sm font-semibold"
              style={{
                color: '#F2F2F0',
                background: 'rgba(10,10,12,.55)',
                border: `1px solid ${GOLD}55`,
                backdropFilter: 'blur(6px)',
              }}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};

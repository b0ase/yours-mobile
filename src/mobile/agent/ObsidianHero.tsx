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

type Option = { label: string; prompt: string };

// Opens with "Ask b", then gentle questions (owner, 12 Oct 2026), not commands.
const OPTIONS: Option[] = [
  { label: 'Ask b', prompt: 'Hi b. What can you help me with?' },
  {
    label: 'Would you like to create a savings pot?',
    prompt: 'Help me create a savings pot. Ask me what it is for, how much, and until when.',
  },
  {
    label: 'Is there someone you’d like to send money to?',
    prompt: 'Help me send BSV to someone. Ask me who to and how much.',
  },
  {
    label: 'Shall we set up pocket money for someone?',
    prompt: 'Help me set up a regular payment to someone, like pocket money. Ask me who, how much and how often.',
  },
  ...(MARKET_ENABLED
    ? [
        {
          label: 'Curious about a token?',
          prompt: 'Tell me about a token I might like, then ask if I want to buy some and how much.',
        },
      ]
    : []),
  ...(BSPACES_ENABLED
    ? [
        {
          label: 'Fancy going live in a Space?',
          prompt: 'Help me start a live Space in one of my rooms. Ask me which room and the topic.',
        },
      ]
    : []),
  {
    label: 'Is anything not working as it should?',
    prompt: "Something isn't working in my wallet. Help me find out what and fix it.",
  },
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

/** How long each suggestion floats in the pool, and its fade. */
const LINE_MS = 3600;
const FADE_MS = 900;

/**
 * Ask b (owner, 11 Oct 2026: "pure simplicity"): the obsidian pool, a big gold b in the middle, and one suggestion at
 * a time drifting in and out of the pool. Tapping the line fills the message box; nothing is sent until Send.
 */
export const ObsidianHero = ({
  onPick,
  compact = false,
  extra = [],
}: {
  onPick: (prompt: string) => void;
  compact?: boolean;
  extra?: Option[];
}) => {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [still] = useState(() => {
    try {
      return matchMedia('(prefers-reduced-motion: reduce)').matches;
    } catch {
      return false;
    }
  });
  const failed = usePool(canvas, still);
  const lines = [...OPTIONS, ...extra];
  const [i, setI] = useState(0);
  const [shown, setShown] = useState(false);
  useEffect(() => {
    // Wait a beat with the b alone, then cycle: fade in, hold, fade out, next.
    const t = setTimeout(
      () => {
        if (shown) {
          setShown(false);
          setTimeout(() => setI((n) => (n + 1) % lines.length), FADE_MS);
        } else setShown(true);
      },
      shown ? LINE_MS : i === 0 ? 1400 : 200,
    );
    return () => clearTimeout(t);
  }, [shown, i, lines.length]);
  const line = lines[i % lines.length];
  const mark = compact ? 120 : 176;
  return (
    <div
      className="absolute inset-0 flex flex-col items-center justify-center overflow-hidden"
      style={{ background: 'radial-gradient(circle at 50% 50%, #15130c 0%, #050506 45%, #010101 80%)' }}
    >
      {!failed && <canvas ref={canvas} aria-hidden className="absolute inset-0 h-full w-full" />}
      <img
        src={bGlyph}
        alt="Ask b"
        width={mark}
        height={mark}
        className="relative"
        style={{ filter: 'drop-shadow(0 0 36px rgba(245,184,0,.5)) drop-shadow(0 8px 24px rgba(0,0,0,.85))' }}
      />
      <button
        type="button"
        onClick={() => onPick(line.prompt)}
        aria-live="polite"
        className="relative mt-8 border-0 bg-transparent px-6 text-lg font-light tracking-wide cursor-pointer"
        style={{
          color: '#EDE6D0',
          textShadow: '0 2px 18px rgba(0,0,0,.9)',
          opacity: shown || still ? 1 : 0,
          filter: shown || still ? 'blur(0)' : 'blur(6px)',
          transition: `opacity ${FADE_MS}ms ease, filter ${FADE_MS}ms ease`,
          minHeight: '1.6em',
        }}
      >
        {line.label}
      </button>
    </div>
  );
};

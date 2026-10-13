import { useEffect, useState } from 'react';

/**
 * The obsidian pool (owner, 11-12 Oct 2026: "LOVE this obsidian pool"), on its own: the WebGL canvas behind Ask b
 * (agent/ObsidianHero) and behind the welcome, unlock, create, restore and import screens. Same shader as
 * bwalletx.com/ask-b. Drawn at half resolution and paused while the tab is hidden; reduced motion paints one still
 * frame; no WebGL (or a shader that will not link) shows the static radial gradient instead.
 */

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`;
// Domain-warped noise as a height field, lit like polished volcanic glass: near-black body, soft white sheen,
// and a faint warm glow where the gold b sits. Do not change: bwalletx-site/ask-b.html carries the same shader.
export const FRAG = `precision mediump float;
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

/**
 * The gold pool (owner, 13 Oct 2026, for the Name Store: "our obsidian pool only golden"): the same height field and
 * lighting as FRAG, but a molten-gold body, warm highlights and a dusting of sparkle. A separate shader so the
 * original obsidian stays untouched.
 */
export const GOLD_FRAG = `precision mediump float;
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
vec3 col=vec3(.13,.085,.02)+vec3(.78,.56,.12)*sheen*.55+vec3(1.,.93,.72)*spec*.8;
float dust=pow(h(floor(p*260.)+floor(t*1.5)),120.)*smoothstep(.2,.6,c);
col+=vec3(1.,.9,.6)*dust*.6;
col+=vec3(.96,.72,.0)*.16*exp(-d*d*4.)*(.6+.4*sheen);
col*=smoothstep(1.35,.2,d);
gl_FragColor=vec4(col,1.);}`;

/** The no-WebGL look, and what shows under the canvas before its first frame. */
export const POOL_FALLBACK = 'radial-gradient(circle at 50% 50%, #15130c 0%, #050506 45%, #010101 80%)';
export const GOLD_FALLBACK = 'radial-gradient(circle at 50% 40%, #3a2a08 0%, #170f04 45%, #050403 80%)';

/** The canvas is drawn at this fraction of its CSS size (times DPR, capped at 1.5). */
export const POOL_SCALE = 0.5;

export type PoolMode = 'animated' | 'still' | 'fallback';

/** No WebGL wins over everything; reduced motion gets one still frame. */
export const poolMode = (hasWebGL: boolean, reducedMotion: boolean): PoolMode =>
  !hasWebGL ? 'fallback' : reducedMotion ? 'still' : 'animated';

export const prefersReducedMotion = (): boolean => {
  try {
    return matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
};

/** A text field has focus: the background can hold still while someone types (battery, small screens). */
const typing = () => {
  const el = document.activeElement;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || (el as HTMLElement).isContentEditable);
};

export type PoolOptions = {
  /** Paint one frame only. */
  still: boolean;
  /** Frame cap; 0 = every animation frame. */
  fps?: number;
  /** Hold the current frame while an input or textarea has focus. */
  pauseWhileTyping?: boolean;
  /** Fragment shader; the obsidian pool unless a variant (GOLD_FRAG) is given. */
  frag?: string;
};

/** Runs the pool on a canvas. Returns true when WebGL is unavailable, so the caller shows the gradient. */
export const usePool = (
  canvas: React.RefObject<HTMLCanvasElement | null>,
  { still, fps = 0, pauseWhileTyping = false, frag = FRAG }: PoolOptions,
) => {
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const el = canvas.current;
    if (!el) return;
    let gl: WebGLRenderingContext | null = null;
    try {
      gl = el.getContext('webgl', {
        antialias: false,
        alpha: false,
        powerPreference: 'low-power',
        preserveDrawingBuffer: false,
      });
    } catch {
      gl = null;
    }
    if (!gl) return setFailed(true);
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, frag));
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
      const s = Math.min(window.devicePixelRatio || 1, 1.5) * POOL_SCALE;
      el.width = Math.max(1, Math.round(el.clientWidth * s));
      el.height = Math.max(1, Math.round(el.clientHeight * s));
      gl.viewport(0, 0, el.width, el.height);
    };
    size();
    const start = performance.now();
    let last = 8;
    const draw = (sec: number) => {
      last = sec;
      gl.uniform2f(uR, el.width, el.height);
      gl.uniform1f(uT, sec);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    };
    const ro = new ResizeObserver(() => {
      size();
      draw(last);
    });
    ro.observe(el);
    const gap = fps > 0 ? 1000 / fps : 0;
    let raf = 0;
    let prev = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (document.visibilityState !== 'visible') return;
      if (gap && now - prev < gap - 1) return;
      if (pauseWhileTyping && typing()) return;
      prev = now;
      draw(8 + (performance.now() - start) / 1000);
    };
    // Always paint one frame at once, so the pool is never a black square (e.g. a tab opened in the background).
    draw(8);
    if (!still) raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [canvas, still, fps, pauseWhileTyping, frag]);
  return failed;
};

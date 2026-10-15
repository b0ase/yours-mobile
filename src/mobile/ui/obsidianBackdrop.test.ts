import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FRAG, POOL_SCALE, TINT_FRAG, poolMode } from './obsidianPool';

describe('ObsidianBackdrop', () => {
  test('no WebGL shows the static gradient, whatever the motion setting', () => {
    expect(poolMode(false, false)).toBe('fallback');
    expect(poolMode(false, true)).toBe('fallback');
  });
  test('reduced motion paints one still frame', () => {
    expect(poolMode(true, true)).toBe('still');
  });
  test('otherwise the pool moves', () => {
    expect(poolMode(true, false)).toBe('animated');
  });
  test('same half resolution and the shader the owner approved', () => {
    expect(POOL_SCALE).toBe(0.5);
    expect(FRAG).toContain(
      'float H(vec2 p){vec2 q=vec2(fbm(p+t*.04),fbm(p+vec2(5.2,1.3)-t*.03));return fbm(p+2.2*q);}',
    );
    expect(FRAG).toContain('col+=vec3(.96,.72,.0)*.10*exp(-d*d*5.)*(.6+.4*sheen);');
  });
  test('ObsidianHero draws its pool through the backdrop (one shader, one place)', () => {
    const hero = readFileSync(join(import.meta.dir, '../agent/ObsidianHero.tsx'), 'utf8');
    expect(hero).toContain("from '../ui/ObsidianBackdrop'");
    expect(hero).toContain('<ObsidianBackdrop');
    expect(hero).not.toContain('gl_FragColor');
  });
  test('the themed pool is the original shader with its colours as uniforms', () => {
    expect(TINT_FRAG).not.toBe(FRAG);
    for (const u of ['cB+cS*sheen+cP*spec*.7', 'col+=cG*exp(', 'col=mix(cE,col,smoothstep(1.25,.25,d));'])
      expect(TINT_FRAG).toContain(u);
    // Everything but the colours is untouched.
    const strip = (f: string) => f.split('void main(){')[1]?.split('float d=length(uv);')[0];
    expect(strip(TINT_FRAG)).toBe(strip(FRAG));
  });
});

describe('pool precision (Android 16-bit mediump)', () => {
  test('every pool shader asks for highp when the GPU has it', async () => {
    const { GOLD_FRAG, PRECISION } = await import('./obsidianPool');
    for (const src of [FRAG, GOLD_FRAG, TINT_FRAG]) {
      expect(src.startsWith(PRECISION)).toBe(true);
      expect(src).toContain('precision highp float;');
    }
  });
});

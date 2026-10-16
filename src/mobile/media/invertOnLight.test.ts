import { expect, test } from 'bun:test';
import { invertOnLightClass, invertsOnLight } from './invertOnLight';

test('only artists who opted in (VexVoid) invert on the White theme', () => {
  expect(invertsOnLight('VexVoid')).toBe(true);
  expect(invertOnLightClass('VexVoid')).toBe(' bw-invert-on-light');
  for (const a of ['', null, undefined, 'Someone Else', 'vex']) expect(invertsOnLight(a)).toBe(false);
});

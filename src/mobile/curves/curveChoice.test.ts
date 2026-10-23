import { expect, test } from 'bun:test';
import { curveProblem, presetFor } from './curveChoice';

test('permanent tick required only with a curve', () => {
  expect(curveProblem(presetFor('film', 1e9), false)).toBeTruthy();
  expect(curveProblem(presetFor('film', 1e9), true)).toBeNull();
  expect(curveProblem(null, false)).toBeNull();
});
test('preset follows a smaller token supply', () => {
  expect(presetFor('film', 21_000_000).supply).toBe(21_000_000);
  expect(presetFor('name', 1e9).supply).toBe(100_000);
});

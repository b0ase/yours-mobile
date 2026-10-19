import { describe, expect, test } from 'bun:test';
import { handOff, takeHandOff, tileForFile } from './drop';

describe('tileForFile', () => {
  test('media by browser type', () => {
    expect(tileForFile('image/png', 'a.png')).toBe('art');
    expect(tileForFile('audio/mpeg', 'a.mp3')).toBe('music');
    expect(tileForFile('video/mp4', 'a.mp4')).toBe('video');
  });
  test('3D by extension even with no type', () => {
    expect(tileForFile('', 'ship.glb')).toBe('3d');
    expect(tileForFile('application/octet-stream', 'room.USDZ')).toBe('3d');
    expect(tileForFile('model/gltf+json', 'x')).toBe('3d');
  });
  test('documents and sites', () => {
    expect(tileForFile('application/pdf', 'zine.pdf')).toBe('books');
    expect(tileForFile('', 'notes.md')).toBe('books');
    expect(tileForFile('text/html', 'index.html')).toBe('website');
  });
  test('anything else is not mintable here', () => {
    expect(tileForFile('application/zip', 'a.zip')).toBeNull();
    expect(tileForFile('', 'a.exe')).toBeNull();
  });
});

describe('handOff', () => {
  test('is taken once', () => {
    const f = new File(['x'], 'x.png', { type: 'image/png' });
    handOff(f);
    expect(takeHandOff()).toBe(f);
    expect(takeHandOff()).toBeNull();
  });
});

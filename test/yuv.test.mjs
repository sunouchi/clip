// Unit tests for turning video frames back into the colors of the page.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

class ImageData {
  constructor(data, width, height) {
    Object.assign(this, { data, width, height });
  }
}
const context = vm.createContext({ ImageData, Uint8ClampedArray, Uint32Array, Math, Map });
vm.runInContext(fs.readFileSync(new URL('../extension/yuv.js', import.meta.url), 'utf8'), context);
const { Palette } = context;

const WIDTH = 64;
const HEIGHT = 48;

/** Makes a picture of vertical stripes, 16 pixels wide, of the given colors. */
function picture(colors) {
  const data = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let i = 0; i < WIDTH * HEIGHT; i++) {
    const [r, g, b] = colors[Math.floor((i % WIDTH) / 16) % colors.length];
    data.set([r, g, b, 255], i * 4);
  }
  return new ImageData(data, WIDTH, HEIGHT);
}

/** Films a picture: BT.709, limited range, color at half the resolution. */
function film({ data }, format) {
  const at = (x, y) => data.subarray((y * WIDTH + x) * 4);
  const chromaStride = format === 'NV12' ? WIDTH : WIDTH / 2;
  const u = WIDTH * HEIGHT;
  const v = format === 'NV12' ? u + 1 : u + (WIDTH / 2) * (HEIGHT / 2);
  const step = format === 'NV12' ? 2 : 1;
  const out = new Uint8Array(WIDTH * HEIGHT * 1.5);
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const [r, g, b] = at(x, y);
      out[y * WIDTH + x] = Math.round(16 + 0.1826 * r + 0.6142 * g + 0.062 * b);
      if (x % 2 || y % 2) continue;
      const i = (y / 2) * chromaStride + (x / 2) * step;
      out[u + i] = Math.round(128 - 0.1006 * r - 0.3386 * g + 0.4392 * b);
      out[v + i] = Math.round(128 + 0.4392 * r - 0.3989 * g - 0.0403 * b);
    }
  }
  const layout = [{ offset: 0, stride: WIDTH }, { offset: u, stride: chromaStride }];
  if (format === 'I420') layout.push({ offset: v, stride: chromaStride });
  return { data: out, layout, format, width: WIDTH, height: HEIGHT };
}

function largestDifference(a, b) {
  return a.reduce((most, value, i) => Math.max(most, Math.abs(value - b[i])), 0);
}

const BRAND = [[240, 83, 45], [255, 243, 224], [31, 41, 55], [29, 111, 224]];

for (const format of ['I420', 'NV12']) {
  test(`gets close to the colors of an unknown page (${format})`, () => {
    const original = picture(BRAND);
    const developed = new Palette().develop(film(original, format), 0, HEIGHT, WIDTH);
    assert.ok(largestDifference(developed.data, original.data) <= 3);
  });

  test(`gets flat colors exactly right once it has seen them (${format})`, () => {
    const palette = new Palette();
    palette.learn(film(picture(BRAND), format), picture(BRAND), 0);
    const other = picture([BRAND[2], BRAND[0], BRAND[3], BRAND[1]]);
    const developed = palette.develop(film(other, format), 0, HEIGHT, WIDTH);
    assert.equal(largestDifference(developed.data, other.data), 0);
  });
}

test('develops only the rows and columns asked for', () => {
  const original = picture(BRAND);
  const developed = new Palette().develop(film(original, 'I420'), 10, 20, 32);
  assert.deepEqual([developed.width, developed.height, developed.data.length], [32, 10, 32 * 10 * 4]);
  assert.ok(largestDifference(developed.data.subarray(0, 4), original.data.subarray(0, 4)) <= 3);
});

test('learns from a capture that starts further down than the frame', () => {
  const palette = new Palette();
  const original = picture(BRAND);
  const lower = new ImageData(original.data.slice(16 * WIDTH * 4), WIDTH, HEIGHT - 16);
  palette.learn(film(original, 'I420'), lower, 16);
  const developed = palette.develop(film(original, 'I420'), 0, HEIGHT, WIDTH);
  assert.equal(largestDifference(developed.data, original.data), 0);
});

test('does not learn from a page that has changed in between', () => {
  const palette = new Palette();
  palette.learn(film(picture(BRAND), 'I420'), picture([[0, 255, 0]]), 0);
  const original = picture(BRAND);
  const developed = palette.develop(film(original, 'I420'), 0, HEIGHT, WIDTH);
  assert.ok(largestDifference(developed.data, original.data) <= 3);
});

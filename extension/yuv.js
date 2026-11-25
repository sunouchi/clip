/**
 * Turns video frames of a page back into the colors of the page.
 *
 * Video stores brightness for every pixel but color for every 2 × 2 pixels
 * only, both with fewer steps than RGB has. Converting back gets flat colors
 * wrong by a step or two. But pages use few flat colors, over and over, and
 * some screens are captured exactly as well as filmed. Comparing the two tells
 * which exact color each video color stands for.
 *
 * What cannot be recovered is the edge of colored text, where the video has
 * mixed the colors of neighboring pixels, and fine color noise in photos.
 *
 * A frame is { data, layout, format, width, height }, as VideoFrame.copyTo()
 * leaves it, in I420 or NV12.
 */
class Palette {
  /** Video color (Y, U, V in one number) to RGBA in memory order, or 0 if not known. */
  #colors = new Uint32Array(1 << 24);

  /**
   * Learns from a screen that was both captured and filmed. `image` is the
   * capture (an ImageData); its first row is row `firstRow` of the frame.
   */
  learn(frame, image, firstRow) {
    const { width, height } = image;
    const pixels = new Uint32Array(image.data.buffer, image.data.byteOffset, width * height);
    const { y: lumaAt, u: uAt, v: vAt } = planes(frame);
    const { data } = frame;

    const votes = new Map(); // video color -> Map of exact color -> how often
    for (let row = 4; row < height - 5; row += 2) {
      for (let x = 4; x < width - 5; x += 2) {
        const i = row * width + x;
        const color = pixels[i];
        if (!isFlat(pixels, i, width, color)) continue;
        const y = firstRow + row;
        const key = (data[lumaAt(x, y)] << 16) | (data[uAt(x, y)] << 8) | data[vAt(x, y)];
        let seen = votes.get(key);
        if (!seen) votes.set(key, (seen = new Map()));
        seen.set(color, (seen.get(color) ?? 0) + 1);
      }
    }
    for (const [key, seen] of votes) {
      const [color, count] = [...seen].reduce((best, entry) => (entry[1] > best[1] ? entry : best));
      // The two must be about the same color. If not, the page has changed in between.
      if (count >= 4 && isClose(color, convert(key >> 16, (key >> 8) & 255, key & 255))) {
        this.#colors[key] = color;
      }
    }
  }

  /** Returns rows `from` to `end` of a frame, `width` pixels wide, as ImageData. */
  develop(frame, from, end, width) {
    const { data } = frame;
    const { y: lumaAt, u: uAt, v: vAt, step } = planes(frame);
    const colors = this.#colors;
    const out = new Uint32Array(width * (end - from));
    let o = 0;
    for (let row = from; row < end; row++) {
      const luma = lumaAt(0, row);
      const uRow = uAt(0, row);
      const vRow = vAt(0, row);
      for (let x = 0; x < width; x++) {
        const c = (x >> 1) * step;
        const y = data[luma + x];
        const u = data[uRow + c];
        const v = data[vRow + c];
        out[o++] = colors[(y << 16) | (u << 8) | v] || convert(y, u, v);
      }
    }
    return new ImageData(new Uint8ClampedArray(out.buffer), width, end - from);
  }
}

/** Where the samples of a pixel are in the frame's data. */
function planes({ layout, format }) {
  const [Y, U, V] = layout;
  if (format === 'NV12') {
    return {
      step: 2,
      y: (x, y) => Y.offset + y * Y.stride + x,
      u: (x, y) => U.offset + (y >> 1) * U.stride + (x >> 1) * 2,
      v: (x, y) => U.offset + (y >> 1) * U.stride + (x >> 1) * 2 + 1,
    };
  }
  return {
    step: 1,
    y: (x, y) => Y.offset + y * Y.stride + x,
    u: (x, y) => U.offset + (y >> 1) * U.stride + (x >> 1),
    v: (x, y) => V.offset + (y >> 1) * V.stride + (x >> 1),
  };
}

/** BT.709, limited range, to RGBA in memory order (little endian). */
function convert(y, u, v) {
  const c = 76309 * (y - 16) + 32768;
  const d = u - 128;
  const e = v - 128;
  const r = byte((c + 117489 * e) >> 16);
  const g = byte((c - 13975 * d - 34925 * e) >> 16);
  const b = byte((c + 138438 * d) >> 16);
  return (0xff000000 | (b << 16) | (g << 8) | r) >>> 0;
}

function byte(value) {
  return value < 0 ? 0 : value > 255 ? 255 : value;
}

/** Whether the pixel sits in a patch of one color, clear of its blurred edges. */
function isFlat(pixels, i, width, color) {
  const up = i - 4 * width;
  const down = i + 5 * width;
  return pixels[i - 4] === color && pixels[i + 5] === color
    && pixels[up] === color && pixels[down] === color
    && pixels[up - 4] === color && pixels[up + 5] === color
    && pixels[down - 4] === color && pixels[down + 5] === color
    && pixels[i + 1] === color && pixels[i + width] === color;
}

function isClose(a, b) {
  for (let shift = 0; shift < 24; shift += 8) {
    if (Math.abs(((a >>> shift) & 255) - ((b >>> shift) & 255)) > 12) return false;
  }
  return true;
}

globalThis.Palette = Palette;

// End-to-end tests: load the extension into a real Chromium, capture made-up
// pages, read the image back from the clipboard and check its pixels.
//
// Checking only the image size is not enough. The failures we have actually
// seen (the first screen repeated down the image, the header painted in the
// middle, a zoomed page cut off) all produce an image of the right size.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FOOTER_COLOR, SECTION_COLORS, rulerPage, sectionsPage } from './pages.mjs';

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));
const ORIGIN = 'https://clip.test'; // never resolved: every request is answered below
const DEVICE_SCALE = Number(process.env.CLIP_TEST_DEVICE_SCALE ?? 2); // 2 = Retina, 1 = ordinary display
const TIMEOUT = { timeout: 90_000 };

let context;
let worker;
let profileDir;

before(async () => {
  profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-test-'));
  context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', // the full browser in headless mode; extensions need it
    headless: true,
    viewport: null, // use the real window size; Playwright's own emulation would get in the way
    args: [
      `--disable-extensions-except=${EXTENSION}`,
      `--load-extension=${EXTENSION}`,
      `--force-device-scale-factor=${DEVICE_SCALE}`,
      '--window-size=1280,800',
    ],
  });
  await context.route('**://clip.test/**', (route) => {
    const query = new URL(route.request().url()).searchParams;
    const body = query.has('ruler')
      ? rulerPage(Number(query.get('ruler')))
      : sectionsPage(Number(query.get('sections') ?? 3));
    return route.fulfill({ contentType: 'text/html; charset=utf-8', body });
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
});

after(async () => {
  await context?.close();
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

/** Opens a page, sets its zoom and scroll position, and waits for the layout to be still. */
async function openPage(url, { zoom = 1, scrollY = 0 } = {}) {
  const page = await context.newPage();
  await page.goto(url).catch(() => {}); // chrome:// pages reject goto but still load
  await page.bringToFront();
  // Zoom is remembered per origin, so always set it.
  await worker.evaluate(async (factor) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.setZoom(tab.id, factor);
  }, zoom).catch(() => {});
  if (scrollY) await page.evaluate((y) => window.scrollTo(0, y), scrollY);
  // The debugging bar from an earlier capture takes about five seconds to go
  // away and resizes the viewport when it does. Wait until the height is still.
  let previous = -1;
  for (let i = 0; i < 60; i++) {
    const height = await page.evaluate(() => window.innerHeight).catch(() => 0);
    if (height === previous) break;
    previous = height;
    await page.waitForTimeout(150);
  }
  return page;
}

/** Calls the extension's capture function directly and returns its result or error. */
function capture() {
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    try {
      return { ok: true, ...(await captureFullPageToClipboard(tab)) };
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  });
}

/**
 * Goes through the same path as pressing the toolbar button and returns the
 * badge and tooltip it ends with. chrome.action.onClicked.dispatch() is not a
 * documented API; it is the only way to fire the event without a real click.
 */
function pressToolbarButton() {
  return worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    chrome.action.onClicked.dispatch(tab);
    const startedAt = performance.now();
    while (performance.now() - startedAt < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const badge = await chrome.action.getBadgeText({ tabId: tab.id });
      if (badge) return { badge, title: await chrome.action.getTitle({ tabId: tab.id }) };
    }
    return { badge: '', title: 'timed out' };
  });
}

/** What the sections page looks like before the capture, measured in the page. */
function measureSectionsPage(page) {
  return page.evaluate(() => ({
    cssWidth: document.documentElement.clientWidth,
    cssHeight: document.documentElement.scrollHeight,
    scrollY: Math.round(window.scrollY),
    sectionCenters: [...document.querySelectorAll('section')].map((section) =>
      Math.round(section.getBoundingClientRect().top + window.scrollY + section.offsetHeight / 2)),
  }));
}

/** Reads the PNG on the clipboard and reports what is in it. Runs in the page. */
function inspectClipboardImage(page, expected) {
  return page.evaluate(async (expected) => {
    const [item] = await navigator.clipboard.read();
    const bitmap = await createImageBitmap(await item.getType('image/png'));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const colorAt = (x, y) => {
      const [r, g, b] = context.getImageData(x, y, 1, 1).data;
      return '#' + [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('');
    };
    const scale = bitmap.width / expected.cssWidth; // image pixels per CSS pixel

    // Walk down the left edge and note every place the red header starts.
    const column = context.getImageData(Math.round(4 * scale), 0, 1, bitmap.height).data;
    const headersAtCssY = [];
    let inHeader = false;
    for (let y = 0; y < bitmap.height; y++) {
      const isRed = column[y * 4] > 180 && column[y * 4 + 1] < 70 && column[y * 4 + 2] < 70;
      if (isRed && !inHeader) headersAtCssY.push(Math.round(y / scale));
      inHeader = isRed;
    }
    return {
      types: item.types,
      width: bitmap.width,
      height: bitmap.height,
      scale,
      headersAtCssY,
      bottomColor: colorAt(Math.round(20 * scale), bitmap.height - Math.round(10 * scale)),
      sectionColors: expected.sectionCenters.map((y) => colorAt(Math.round(20 * scale), Math.round(y * scale))),
    };
  }, expected);
}

/** Captures a sections page and asserts that the image shows the whole page, correctly. */
async function assertSectionsPageCaptured(page) {
  const expected = await measureSectionsPage(page);
  const result = await capture();
  assert.equal(result.ok, true, `capture failed: ${result.error}`);
  const image = await inspectClipboardImage(page, expected);

  assert.deepEqual(image.types, ['image/png']);
  assert.deepEqual(image.headersAtCssY, [0], 'the fixed header appears once, at the top');
  assert.equal(image.bottomColor, FOOTER_COLOR, 'the image ends with the footer');
  assert.deepEqual(
    image.sectionColors,
    expected.sectionCenters.map((_, i) => SECTION_COLORS[i % SECTION_COLORS.length]),
    'every section is where it should be',
  );
  assert.equal(result.cssWidth, expected.cssWidth, 'the layout width is unchanged');
  // When zoomed, the viewport height is fractional but Chrome reports the tab
  // size in whole pixels, so anything sized in vh can differ by under a pixel.
  assert.ok(Math.abs(result.cssHeight - expected.cssHeight) <= 1, 'the layout height is unchanged');
  assert.equal(image.width, result.imageWidth);
  assert.equal(image.height, result.imageHeight);
  const scrollY = await page.evaluate(() => Math.round(window.scrollY));
  assert.equal(scrollY, expected.scrollY, 'the scroll position is restored');
  return { result, image };
}

/** Captures a ruler page and asserts that no row is missing, duplicated or out of order. */
async function assertRulerCaptured(rows, zoom) {
  const page = await openPage(`${ORIGIN}/?ruler=${rows}`, { zoom });
  try {
    const result = await capture();
    assert.equal(result.ok, true, `capture failed: ${result.error}`);
    const read = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const bitmap = await createImageBitmap(await item.getType('image/png'));
      const canvas = new OffscreenCanvas(1, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, Math.floor(bitmap.width / 2), 0, 1, bitmap.height, 0, 0, 1, bitmap.height);
      const data = context.getImageData(0, 0, 1, bitmap.height).data;
      const jumps = [];
      const seen = new Set();
      let previous = -1, backwards = 0, run = 0, shortestRun = Infinity, longestRun = 0;
      for (let y = 0; y < bitmap.height; y++) {
        const row = data[y * 4] + data[y * 4 + 1] * 256;
        if (row < previous) backwards++;
        if (row > previous + 1) jumps.push({ imageY: y, from: previous, to: row });
        if (row !== previous) {
          if (previous >= 0) { shortestRun = Math.min(shortestRun, run); longestRun = Math.max(longestRun, run); }
          run = 0;
        }
        run++;
        seen.add(row);
        previous = row;
      }
      return { height: bitmap.height, first: data[0] + data[1] * 256, last: previous, distinct: seen.size,
        backwards, jumps: jumps.slice(0, 5), shortestRun, longestRun };
    });

    assert.equal(read.height, result.imageHeight);
    assert.equal(read.first, 0, 'the image starts at the first row');
    assert.deepEqual(read.jumps, [], 'no rows are skipped, not even at the seams between tiles');
    assert.equal(read.backwards, 0, 'no rows are repeated out of order');
    assert.ok(read.longestRun - read.shortestRun <= 1, 'no row is duplicated at a seam');
    // The last row may be cut when the page ends on a fraction of a pixel,
    // but nothing past the page (which would read as row 65535) may show.
    assert.ok(read.last === rows - 1 || read.last === rows - 2, `the image ends at the last row (got ${read.last})`);
    return result;
  } finally {
    await page.close();
  }
}

// ------------------------------------------------------------------ tests

describe(`full page to clipboard (device scale ${DEVICE_SCALE})`, () => {
  test('captures a short page', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=3`);
    const { result } = await assertSectionsPageCaptured(page);
    assert.equal(result.tiles, 1);
    await page.close();
  });

  test('captures correctly several times in a row, while the debugging bar is still showing', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=3`);
    for (let i = 0; i < 3; i++) await assertSectionsPageCaptured(page);
    await page.close();
  });

  test('stitches a page that is taller than Chrome can render at once', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=30`); // about 24,800 CSS px
    const { result } = await assertSectionsPageCaptured(page);
    assert.ok(result.tiles > 1, 'the page needed more than one tile');
    await page.close();
  });

  test('puts the fixed header at the top and keeps the scroll position when the page is scrolled', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=30`, { scrollY: 5000 });
    await assertSectionsPageCaptured(page);
    await page.close();
  });

  for (const zoom of [1.25, 0.8]) {
    test(`captures the whole page at ${zoom * 100}% zoom`, TIMEOUT, async () => {
      const page = await openPage(`${ORIGIN}/?sections=6`, { zoom });
      await assertSectionsPageCaptured(page);
      await page.close();
    });
  }

  // Below one image pixel per row the ruler cannot tell rows apart, so only
  // use zoom levels that keep a row at least one pixel tall.
  for (const zoom of [1, 1.1, 1.25, 2 / 3].filter((factor) => factor * DEVICE_SCALE >= 1)) {
    test(`joins tiles without losing or repeating a row at ${Math.round(zoom * 100)}% zoom`, TIMEOUT, async () => {
      const result = await assertRulerCaptured(20_000, zoom);
      assert.ok(result.tiles > 1, 'the ruler needed more than one tile');
    });
  }

  test('reports an image that would be too tall instead of producing a broken one', TIMEOUT, async () => {
    const sections = Math.ceil(70_000 / DEVICE_SCALE / 800); // just past the 65,535 px limit
    const page = await openPage(`${ORIGIN}/?sections=${sections}`);
    const result = await capture();
    assert.equal(result.ok, false);
    assert.match(result.error, /too long to fit in one image/);
    await page.close();
  });
});

describe('toolbar button', () => {
  test('shows a check mark and the image size after a capture', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=6`);
    const outcome = await pressToolbarButton();
    assert.equal(outcome.badge, '✓');
    assert.match(outcome.title, /^Clip: copied \d+ × \d+ px in \d+ ms$/);
    await page.close();
  });

  test('explains that a page not served over HTTPS has no clipboard', TIMEOUT, async () => {
    const page = await openPage('http://clip.test/?sections=3');
    const outcome = await pressToolbarButton();
    assert.equal(outcome.badge, '!');
    assert.match(outcome.title, /not served over HTTPS/);
    await page.close();
  });

  test('explains that a browser page cannot be captured', TIMEOUT, async () => {
    const page = await openPage('chrome://version');
    const outcome = await pressToolbarButton();
    assert.equal(outcome.badge, '!');
    assert.match(outcome.title, /could not capture this page/);
    await page.close();
  });
});

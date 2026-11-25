// End-to-end tests: load the extension into a real Chromium, press its toolbar
// button on made-up pages, read the image back from the clipboard and check
// its pixels.
//
// The extension runs exactly as shipped. The button is pressed through the
// DevTools protocol (Extensions.triggerAction), which grants activeTab the way
// a real click does, so these tests also prove that its permissions suffice.
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
import {
  BAR_COLOR, CARD_COLOR, FOOTER_COLOR, HEADER_COLOR, REVEAL_COLOR, SECTION_COLORS, STICKY_COLOR,
  barsPage, growingPage, rulerPage, sectionsPage, trickyPage,
} from './pages.mjs';

const EXTENSION = fileURLToPath(new URL('../extension', import.meta.url));
const ORIGIN = 'https://clip.test'; // never resolved: every request is answered below
const DEVICE_SCALE = Number(process.env.CLIP_TEST_DEVICE_SCALE ?? 2); // 2 = Retina, 1 = ordinary display
const TIMEOUT = { timeout: 90_000 };
const TOAST = '[data-clip-toast]';

let context;
let worker;
let browserSession;
let videoTrouble = []; // what the extension said when it went on without video
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
      '--window-size=1280,801', // 714 px tall inside: an even number, which video needs
      '--enable-unsafe-extension-debugging', // for Extensions.triggerAction
    ],
  });
  await context.route('**://clip.test/**', (route) => {
    const query = new URL(route.request().url()).searchParams;
    let body = sectionsPage(Number(query.get('sections') ?? 3));
    if (query.has('ruler')) body = rulerPage(Number(query.get('ruler')));
    if (query.has('bars')) body = barsPage(Number(query.get('bars')));
    if (query.has('tricky')) body = trickyPage(Number(query.get('footer') ?? 200));
    if (query.has('growing')) body = growingPage(Number(query.get('growing')));
    const headers = { 'content-type': 'text/html; charset=utf-8' };
    if (query.has('csp')) headers['content-security-policy'] = "default-src 'none'; style-src 'sha256-x'; require-trusted-types-for 'script'";
    return route.fulfill({ headers, body });
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: ORIGIN });
  worker = context.serviceWorkers()[0] ?? (await context.waitForEvent('serviceworker'));
  browserSession = await context.browser().newBrowserCDPSession();
  worker.on('console', (message) => {
    if (message.text().includes('without video')) videoTrouble.push(message.text());
  });
  // Note every outcome on its way to the user.
  await worker.evaluate(() => {
    const original = globalThis.report;
    globalThis.report = async (tab, outcome) => {
      await original(tab, outcome);
      globalThis.testOutcome = {
        ...outcome,
        badge: await chrome.action.getBadgeText({ tabId: tab.id }).catch(() => ''),
        tooltip: await chrome.action.getTitle({ tabId: tab.id }).catch(() => ''),
      };
    };
  });
});

after(async () => {
  await context?.close();
  if (profileDir) fs.rmSync(profileDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- helpers

/** Opens a page, sets its zoom and scroll position, and waits until Chrome has it in front. */
async function openPage(url, { zoom = 1, scrollY = 0 } = {}) {
  const page = await context.newPage();
  await page.goto(url).catch(() => {}); // chrome:// pages reject goto but still load
  await page.bringToFront();
  await waitUntil(() => worker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab?.status === 'complete' && tab.id;
  }));
  // Zoom is remembered per origin, so always set it.
  await worker.evaluate(async (factor) => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await chrome.tabs.setZoom(tab.id, factor);
  }, zoom).catch(() => {});
  await waitUntilStill(page); // pages that snap start by moving on their own
  if (scrollY) {
    await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), scrollY);
    await waitUntilStill(page);
  }
  return page;
}

/** Waits until the page has neither resized nor scrolled (or snapped) for a while. */
async function waitUntilStill(page) {
  let previous = '';
  for (let i = 0, still = 0; i < 60 && still < 3; i++) {
    const now = await page.evaluate(() => [innerWidth, innerHeight, scrollY].join()).catch(() => '');
    still = now === previous ? still + 1 : 0;
    previous = now;
    await page.waitForTimeout(100);
  }
}

async function waitUntil(check, timeoutMs = 10_000) {
  const startedAt = Date.now();
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() - startedAt > timeoutMs) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Presses the toolbar button on the page, without waiting for the capture. */
async function press(page) {
  const id = new URL(worker.url()).host;
  const { targetInfos } = await browserSession.send('Target.getTargets', { filter: [{ type: 'tab' }] });
  const target = targetInfos.find(({ url }) => url === page.url());
  assert.ok(target, `no tab for ${page.url()}`);
  await worker.evaluate(() => { globalThis.testOutcome = null; });
  // A tab that has only just come to the front sometimes ignores the press.
  for (let i = 0; i < 5; i++) {
    await browserSession.send('Extensions.triggerAction', { id, targetId: target.targetId });
    const started = await waitUntil(() => worker.evaluate(() => busy || globalThis.testOutcome), 600).catch(() => false);
    if (started) return;
  }
  throw new Error('the press was ignored');
}

const outcome = () => waitUntil(() => worker.evaluate(() => globalThis.testOutcome), 80_000);

/** Presses the toolbar button and returns how the capture went. */
async function capture(page) {
  await press(page);
  return outcome();
}

/** Runs the "capture the visible area" shortcut. Press the button first: only a real press grants activeTab. */
async function captureVisible() {
  await waitUntil(() => worker.evaluate(() => !busy));
  await worker.evaluate(async () => {
    globalThis.testOutcome = null;
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    chrome.commands.onCommand.dispatch('capture-visible', tab);
  });
  return outcome();
}

/** How long captures may wait for Chrome's rate limit: Infinity for exact screens only, 0 for as few as possible. */
function setExactMs(ms) {
  return worker.evaluate((ms) => { limits.exactMs = ms; }, ms);
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

    // Walk down the left edge and note where each run of a color starts and ends.
    const column = context.getImageData(Math.round(4 * scale), 0, 1, bitmap.height).data;
    const runs = [];
    for (let y = 0; y < bitmap.height; y++) {
      const color = '#' + [0, 1, 2].map((i) => column[y * 4 + i].toString(16).padStart(2, '0')).join('');
      const last = runs.at(-1);
      if (last?.color === color) last.end = y + 1;
      else runs.push({ color, start: y, end: y + 1 });
    }
    return {
      types: item.types,
      width: bitmap.width,
      height: bitmap.height,
      scale,
      runs: runs.map(({ color, start, end }) =>
        ({ color, top: Math.round(start / scale), height: Math.round((end - start) / scale) })),
      topRightColor: colorAt(bitmap.width - Math.round(60 * scale), Math.round(30 * scale)),
      bottomColor: colorAt(Math.round(20 * scale), bitmap.height - Math.round(10 * scale)),
      sectionColors: (expected.sectionCenters ?? []).map((y) => colorAt(Math.round(20 * scale), Math.round(y * scale))),
    };
  }, expected);
}

/** The places where a color shows up down the left edge of the image. */
function placesOf(image, color, tolerance = 0) {
  return image.runs.filter((run) => difference(run.color, color) <= tolerance);
}

/** The largest difference between two colors, like '#102030', in any channel. */
function difference(a, b) {
  const channels = (color) => [1, 3, 5].map((i) => parseInt(color.slice(i, i + 2), 16));
  const other = channels(b);
  return Math.max(...channels(a).map((value, i) => Math.abs(value - other[i])));
}

/** Captures a sections page and asserts that the image shows the whole page, correctly. */
async function assertSectionsPageCaptured(page, { readIn = page, tolerance = 0 } = {}) {
  const expected = await measureSectionsPage(page);
  const result = await capture(page);
  assert.equal(result.ok, true, `capture failed: ${result.reason}`);
  assert.equal(result.complete, true, 'the whole page was captured');
  const scrollY = await page.evaluate(() => Math.round(window.scrollY));
  if (readIn !== page) await readIn.bringToFront();
  const image = await inspectClipboardImage(readIn, expected);

  assert.deepEqual(image.types, ['image/png']);
  assert.deepEqual(placesOf(image, HEADER_COLOR).map(({ top }) => top), [0], 'the fixed header appears once, at the top');
  assert.equal(image.topRightColor, HEADER_COLOR, 'the toast of an earlier capture is not in the image');
  assert.equal(image.bottomColor, FOOTER_COLOR, 'the image ends with the footer');
  const wrong = expected.sectionCenters
    .map((_, i) => ({ section: i, is: image.sectionColors[i], shouldBe: SECTION_COLORS[i % SECTION_COLORS.length] }))
    .filter(({ is, shouldBe }) => difference(is, shouldBe) > tolerance);
  assert.deepEqual(wrong, [], 'every section is where it should be');
  assert.equal(image.width, result.width);
  assert.equal(image.height, result.height);
  assert.ok(Math.abs(image.height / image.scale - expected.cssHeight) <= 1,
    `the image is as tall as the page (${image.height / image.scale} for ${expected.cssHeight})`);
  assert.equal(scrollY, expected.scrollY, 'the scroll position is restored');
  return { result, image };
}

/** Everything about the tricky page that a capture could have changed. */
function trickyState(page) {
  return page.evaluate((toast) => {
    const copy = document.documentElement.cloneNode(true);
    copy.querySelectorAll(toast).forEach((element) => element.remove());
    copy.querySelector('.reveal').classList.remove('seen'); // scrolling past it is what sets this
    return { html: copy.outerHTML, scrollY: Math.round(window.scrollY) };
  }, TOAST);
}

function measureTrickyPage(page) {
  return page.evaluate(() => {
    const top = (selector) => Math.round(document.querySelector(selector).getBoundingClientRect().top + scrollY);
    return { cssWidth: document.documentElement.clientWidth, cssHeight: document.documentElement.scrollHeight,
      reveal: top('.reveal'), box: top('.box'), footer: top('footer') };
  });
}

async function assertNothingLeftBehind(page) {
  assert.equal(await page.locator('[data-clip-mark]').count(), 0, 'the mark is gone');
  assert.equal(await worker.evaluate(() => chrome.offscreen.hasDocument()), false, 'the tab is no longer filmed');
}

/** Reads the bars page back from the clipboard, row by row. */
function readBars(page) {
  return page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    const bitmap = await createImageBitmap(await item.getType('image/png'));
    const { width, height } = bitmap;
    const scale = width / document.documentElement.clientWidth;
    const cell = width / 20;
    // The middle of every bar, and more columns where the mark is drawn.
    const columns = Array.from({ length: 20 }, (_, i) => Math.round((i + 0.5) * cell));
    const extra = [];
    for (let x = 30; x < 116; x += 4) {
      const at = Math.round(x * scale);
      const bar = Math.floor(at / cell);
      if (bar < 2 && Math.abs(at - cell) > 4 && Math.abs(at - 2 * cell) > 4) extra.push([at, bar === 0 ? 255 : 0]);
    }
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0);
    const unreadable = [];
    const jumps = [];
    let previous = -1, run = 0, shortest = Infinity, tallest = 0, first = null;
    const STRIP = 2000;
    for (let top = 0; top < height; top += STRIP) {
      const rows = Math.min(STRIP, height - top);
      const { data } = context.getImageData(0, top, width, rows);
      for (let r = 0; r < rows; r++) {
        const at = (x) => data[(r * width + x) * 4];
        const bits = columns.map((x) => (at(x) > 240 ? 1 : at(x) < 15 ? 0 : NaN));
        const ok = bits[0] === 1 && bits[1] === 0 && bits[18] === 0 && bits[19] === 1 && !bits.some(Number.isNaN)
          && extra.every(([x, value]) => Math.abs(at(x) - value) < 15);
        if (!ok) { if (unreadable.length < 5) unreadable.push(top + r); continue; }
        const band = bits.slice(2, 18).reduce((sum, bit) => sum * 2 + bit, 0);
        first ??= band;
        if (band !== previous) {
          if (previous >= 0) {
            shortest = Math.min(shortest, run);
            tallest = Math.max(tallest, run);
            if (band !== previous + 1) jumps.push({ row: top + r, from: previous, to: band });
          }
          run = 0;
        }
        run++;
        previous = band;
      }
    }
    return { first, last: previous, unreadable, jumps: jumps.slice(0, 5), shortest, tallest };
  });
}

/** Captures a ruler page and asserts that no row is missing, duplicated or out of order. */
async function assertRulerCaptured(rows, zoom) {
  const page = await openPage(`${ORIGIN}/?ruler=${rows}`, { zoom });
  try {
    const result = await capture(page);
    assert.equal(result.ok, true, `capture failed: ${result.reason}`);
    const read = await page.evaluate(async () => {
      const [item] = await navigator.clipboard.read();
      const bitmap = await createImageBitmap(await item.getType('image/png'));
      const canvas = new OffscreenCanvas(1, bitmap.height);
      const context = canvas.getContext('2d');
      context.drawImage(bitmap, Math.floor(bitmap.width / 2), 0, 1, bitmap.height, 0, 0, 1, bitmap.height);
      const data = context.getImageData(0, 0, 1, bitmap.height).data;
      const jumps = [];
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
        previous = row;
      }
      return { height: bitmap.height, first: data[0] + data[1] * 256, last: previous,
        backwards, jumps: jumps.slice(0, 5), shortestRun, longestRun };
    });

    assert.equal(read.height, result.height);
    assert.equal(read.first, 0, 'the image starts at the first row');
    assert.deepEqual(read.jumps, [], 'no rows are skipped, not even at the seams between screens');
    assert.equal(read.backwards, 0, 'no rows are repeated out of order');
    assert.ok(read.longestRun - read.shortestRun <= 1,
      `no row is duplicated at a seam (${read.shortestRun} to ${read.longestRun} px per row)`);
    // The last row may be cut when the page ends on a fraction of a pixel,
    // but nothing past the page (which would read as row 65535) may show.
    assert.ok(read.last === rows - 1 || read.last === rows - 2, `the image ends at the last row (got ${read.last})`);
    return result;
  } finally {
    await page.close();
  }
}

// ------------------------------------------------------------------ tests

describe(`exact screens (device scale ${DEVICE_SCALE})`, () => {
  before(() => setExactMs(Infinity));
  after(() => setExactMs(2500));

  test('captures a short page', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=3`);
    await assertSectionsPageCaptured(page);
    await page.close();
  });

  test('captures correctly several times in a row, while the toast is still showing', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=3`);
    for (let i = 0; i < 3; i++) await assertSectionsPageCaptured(page);
    await page.close();
  });

  test('captures a long page', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=15`); // about 12,800 CSS px
    const { result } = await assertSectionsPageCaptured(page);
    assert.ok(result.screens > 10);
    assert.equal(result.filmed, 0);
    await page.close();
  });

  test('starts at the top and keeps the scroll position when the page is scrolled', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=6`, { scrollY: 2000 });
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
    test(`joins screens without losing or repeating a row at ${Math.round(zoom * 100)}% zoom`, TIMEOUT, async () => {
      const result = await assertRulerCaptured(6_000, zoom);
      assert.ok(result.screens > 3, 'the ruler needed several screens');
    });
  }

  test('captures a page that is not served over HTTPS', TIMEOUT, async () => {
    const reader = await openPage(`${ORIGIN}/?sections=1`); // only secure pages can read the clipboard
    const page = await openPage('http://clip.test/?sections=3');
    await assertSectionsPageCaptured(page, { readIn: reader });
    await page.close();
    await reader.close();
  });

  test('captures a page with a strict content security policy', TIMEOUT, async () => {
    const reader = await openPage(`${ORIGIN}/?sections=1`);
    const page = await openPage(`${ORIGIN}/?sections=3&csp`);
    const result = await capture(page);
    assert.equal(result.ok, true, result.reason);
    assert.equal(await page.locator(TOAST).count(), 1, 'the toast shows');
    await page.close();
    await reader.close();
  });

  test('reports an image that would be too tall instead of producing a broken one', TIMEOUT, async () => {
    const sections = Math.ceil(70_000 / DEVICE_SCALE / 800); // just past the 65,535 px limit
    const page = await openPage(`${ORIGIN}/?sections=${sections}`);
    const result = await capture(page);
    assert.equal(result.ok, false);
    assert.match(result.reason, /too long to fit in one image/);
    await page.close();
  });
});

describe(`filmed screens (device scale ${DEVICE_SCALE})`, () => {
  // Filmed screens show the same things in the same places, in colors that can
  // be a step or two off.
  const CLOSE = 3;

  test('leaves short pages exact', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=3`);
    const { result } = await assertSectionsPageCaptured(page);
    assert.equal(result.filmed, 0);
    await page.close();
  });

  test('films what it cannot wait for on a long page, and does not disturb the page', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=15`); // about 12,800 CSS px
    await page.evaluate(() => {
      globalThis.resizes = 0;
      addEventListener('resize', () => globalThis.resizes++);
    });
    const { result } = await assertSectionsPageCaptured(page, { tolerance: CLOSE });
    assert.ok(result.filmed > 5, `${result.filmed} of ${result.screens} screens were filmed. ${videoTrouble.at(-1) ?? ''}`);
    assert.ok(result.filmed < result.screens - 3, 'screens that did not have to wait are exact');
    assert.ok(result.totalMs < (result.screens / 2) * 1000 * 0.6, `it took ${Math.round(result.totalMs)} ms`);
    assert.equal(await page.evaluate(() => globalThis.resizes), 0, 'the page was not resized');
    await assertNothingLeftBehind(page);
    await page.close();
  });

  test('gets every frame it asks for, time after time', TIMEOUT, async () => {
    // Frames used to go missing on a page that kept still, in most captures.
    videoTrouble = [];
    for (let i = 0; i < 5; i++) {
      const page = await openPage(`${ORIGIN}/?sections=15`);
      const result = await capture(page);
      assert.equal(result.ok, true, result.reason);
      assert.ok(result.filmed > 5, `${result.filmed} of ${result.screens} screens were filmed. ${videoTrouble.at(-1) ?? ''}`);
      await page.close();
    }
    assert.deepEqual(videoTrouble, []);
  });

  test('does not film windows of an odd size, which would come out scaled', TIMEOUT, async () => {
    const states = await worker.evaluate(async () => {
      const wanted = [[1281, 714], [1280, 713]].map(([width, height]) => {
        const video = new Video({ id: -1 });
        video.open({ width, height });
        return video.isWanted;
      });
      return wanted;
    });
    assert.deepEqual(states, [false, false]);
  });

  for (const zoom of [1, 1.1, 1.25, 2 / 3]) {
    test(`joins filmed screens without losing or repeating a row at ${Math.round(zoom * 100)}% zoom`, TIMEOUT, async () => {
      await setExactMs(0);
      const bands = 3000;
      const page = await openPage(`${ORIGIN}/?bars=${bands}`, { zoom });
      const result = await capture(page);
      await setExactMs(2500);
      assert.equal(result.ok, true, result.reason);
      assert.ok(result.filmed > 3, `${result.filmed} of ${result.screens} screens were filmed. ${videoTrouble.at(-1) ?? ''}`);
      const read = await readBars(page);
      assert.deepEqual(read.unreadable, [], 'every row reads as a band, so the mark is nowhere in the image');
      assert.equal(read.first, 0);
      assert.ok(read.last === bands - 1 || read.last === bands - 2, `the image ends at the last band (got ${read.last})`);
      assert.deepEqual(read.jumps, [], 'the bands are in order');
      assert.ok(read.tallest - read.shortest <= 1, `no seam (bands are ${read.shortest} to ${read.tallest} px tall)`);
      await page.close();
    });
  }

  test('captures every screen exactly when video is not available', TIMEOUT, async () => {
    await worker.evaluate(() => {
      globalThis.originalStart = chrome.tabCapture.getMediaStreamId;
      chrome.tabCapture.getMediaStreamId = async () => { throw new Error('not today'); };
    });
    const page = await openPage(`${ORIGIN}/?sections=8`);
    const { result } = await assertSectionsPageCaptured(page);
    await worker.evaluate(() => { chrome.tabCapture.getMediaStreamId = globalThis.originalStart; });
    assert.equal(result.filmed, 0);
    await assertNothingLeftBehind(page);
    await page.close();
  });

  test('goes on exactly when the video stops coming', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=8`);
    await press(page);
    await waitUntil(() => worker.evaluate(() => chrome.offscreen.hasDocument()));
    await page.waitForTimeout(900);
    await worker.evaluate(() => chrome.offscreen.closeDocument());
    const expected = await measureSectionsPage(page);
    const result = await outcome();
    assert.equal(result.ok, true, result.reason);
    const image = await inspectClipboardImage(page, expected);
    assert.equal(image.bottomColor, FOOTER_COLOR);
    assert.ok(Math.abs(image.height / image.scale - expected.cssHeight) <= 1);
    await assertNothingLeftBehind(page);
    await page.close();
  });

  test('stops filming when the capture is canceled', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=30`);
    await press(page);
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    const result = await outcome();
    assert.match(result.reason, /Canceled/);
    await assertNothingLeftBehind(page);
    await page.close();
  });

  test('keeps a bar at the bottom whole where the last screen overlaps a filmed one', TIMEOUT, async () => {
    await setExactMs(0);
    // Make the page end 20 px into its last screen, so that most of the 50 px
    // bar is in rows that the screen before has, too.
    let page = await openPage(`${ORIGIN}/?tricky`);
    const footer = await page.evaluate(() => {
      const step = innerHeight - Math.ceil(6 / devicePixelRatio) - 2;
      const withoutFooter = document.documentElement.scrollHeight - 200;
      return Math.ceil((withoutFooter + 100) / step) * step + 20 - withoutFooter;
    });
    await page.close();
    // Have every screen filmed but the first and the last. (Retries come right
    // after one another; those are for the last screen.)
    await worker.evaluate(() => {
      globalThis.originalTry = tryCaptureScreen;
      let calls = 0;
      let last = 0;
      globalThis.tryCaptureScreen = async (tab) => {
        const isRetry = performance.now() - last < 45;
        last = performance.now();
        return calls++ === 0 || isRetry ? globalThis.originalTry(tab) : null;
      };
    });
    page = await openPage(`${ORIGIN}/?tricky&footer=${footer}`);
    const expected = await measureTrickyPage(page);
    const result = await capture(page);
    await worker.evaluate(() => { globalThis.tryCaptureScreen = globalThis.originalTry; });
    await setExactMs(2500);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.filmed, result.screens - 2);
    const image = await inspectClipboardImage(page, expected);
    assert.deepEqual(placesOf(image, BAR_COLOR), [{ color: BAR_COLOR, top: expected.cssHeight - 50, height: 50 }]);
    await page.close();
  });

  test('shows pinned things once and leaves no trace on a page that fights back', TIMEOUT, async () => {
    await setExactMs(0);
    const page = await openPage(`${ORIGIN}/?tricky`, { scrollY: 800 });
    const before = await trickyState(page);
    const expected = await measureTrickyPage(page);
    const result = await capture(page);
    await setExactMs(2500);
    assert.equal(result.ok, true, result.reason);
    assert.ok(result.filmed > 0, 'some of it was filmed');
    const image = await inspectClipboardImage(page, expected);
    const near = (color, top, height) => {
      const places = placesOf(image, color, CLOSE).filter((place) => place.height > 2); // not the blurred edge
      assert.equal(places.length, 1, `${color} appears once (${JSON.stringify(places)})`);
      assert.ok(Math.abs(places[0].top - top) <= 2 && Math.abs(places[0].height - height) <= 3,
        `${color} at ${JSON.stringify(places[0])}, not ${top} (${height})`);
    };
    near(HEADER_COLOR, 0, 60);
    near(STICKY_COLOR, 60, 40);
    near(BAR_COLOR, expected.cssHeight - 50, 50);
    near(REVEAL_COLOR, expected.reveal, 300);
    near(CARD_COLOR, expected.box + 50, 100);
    await waitUntilStill(page);
    assert.deepEqual(await trickyState(page), before, 'the page is as it was');
    await assertNothingLeftBehind(page);
    await page.close();
  });
});

describe('pages that fight back', () => {
  before(() => setExactMs(Infinity));
  after(() => setExactMs(2500));

  test('shows pinned things once, waits for content to appear, and leaves no trace', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?tricky`, { scrollY: 800 }); // where the second section snaps
    const before = await trickyState(page);
    const expected = await measureTrickyPage(page);

    const result = await capture(page);
    assert.equal(result.ok, true, result.reason);
    const image = await inspectClipboardImage(page, expected);
    assert.deepEqual(placesOf(image, HEADER_COLOR), [{ color: HEADER_COLOR, top: 0, height: 60 }], 'header');
    assert.deepEqual(placesOf(image, STICKY_COLOR), [{ color: STICKY_COLOR, top: 60, height: 40 }], 'sticky menu');
    assert.deepEqual(placesOf(image, BAR_COLOR),
      [{ color: BAR_COLOR, top: expected.cssHeight - 50, height: 50 }], 'bottom bar');
    assert.deepEqual(placesOf(image, REVEAL_COLOR),
      [{ color: REVEAL_COLOR, top: expected.reveal, height: 300 }], 'content that fades in');
    assert.deepEqual(placesOf(image, CARD_COLOR),
      [{ color: CARD_COLOR, top: expected.box + 50, height: 100 }], 'fixed inside a transformed box');
    assert.ok(Math.abs(image.height / image.scale - expected.cssHeight) <= 1);
    await waitUntilStill(page);
    assert.deepEqual(await trickyState(page), before, 'the page is as it was');
    await page.close();
  });

  test('follows a page that grows while it is scrolled', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?growing=1`);
    const result = await capture(page);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.complete, true);
    assert.equal(result.height, 3000 * DEVICE_SCALE);
    await page.close();
  });

  test('stops on an endless page and says so', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?growing=1000`);
    const result = await capture(page);
    assert.equal(result.ok, true, result.reason);
    assert.equal(result.complete, false);
    assert.match(result.tooltip, /not the whole page/);
    await page.close();
  });

  test('Esc cancels, and the page goes back to where it was', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=15`, { scrollY: 700 });
    await press(page);
    await page.waitForTimeout(600);
    await page.keyboard.press('Escape');
    const result = await outcome();
    assert.equal(result.ok, false);
    assert.match(result.reason, /Canceled/);
    assert.equal(await page.evaluate(() => Math.round(scrollY)), 700);
    await page.close();
  });

  test('never captures a tab the user has switched to', TIMEOUT, async () => {
    const other = await openPage(`${ORIGIN}/?sections=1`);
    const page = await openPage(`${ORIGIN}/?sections=15`);
    await press(page);
    await page.waitForTimeout(600);
    await other.bringToFront();
    const result = await outcome();
    assert.equal(result.ok, false);
    assert.match(result.reason, /switched to another tab/);
    await page.close();
    await other.close();
  });
});

describe('visible area', () => {
  test('captures exactly what is on screen', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=3`, { scrollY: 900 });
    await capture(page);
    const expected = await page.evaluate(() => ({ cssWidth: innerWidth, cssHeight: innerHeight }));
    const result = await captureVisible();
    assert.equal(result.ok, true, result.reason);
    const image = await inspectClipboardImage(page, expected);
    assert.deepEqual([image.width, image.height], [expected.cssWidth * DEVICE_SCALE, expected.cssHeight * DEVICE_SCALE]);
    assert.deepEqual(placesOf(image, HEADER_COLOR).map(({ top }) => top), [0]);
    assert.equal(image.topRightColor, HEADER_COLOR, 'the toast of the earlier capture is not in the image');
    assert.equal(await page.evaluate(() => Math.round(scrollY)), 900, 'the page did not move');
    await page.close();
  });

  test('works on a browser page, where the full page cannot be captured', TIMEOUT, async () => {
    const page = await openPage('chrome://version');
    const full = await capture(page);
    assert.equal(full.ok, false);
    assert.equal(full.badge, '!');
    assert.match(full.tooltip, /Try capturing the visible area/);
    const visible = await captureVisible();
    assert.equal(visible.ok, true, visible.reason);
    await page.close();
  });
});

describe('telling the user', () => {
  test('shows a toast and a check mark after a capture, and takes both away', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=3`);
    const result = await capture(page);
    assert.equal(result.badge, '✓');
    assert.match(result.tooltip, /^Clip: Copied to the clipboard\. Full page, \d+ × \d+ px$/);
    assert.equal(await page.locator(TOAST).count(), 1);
    await page.waitForTimeout(3500);
    assert.equal(await page.locator(TOAST).count(), 0);
    await page.close();
  });

  test('shows a toast and an exclamation mark when it fails', TIMEOUT, async () => {
    const page = await openPage(`${ORIGIN}/?sections=${Math.ceil(70_000 / DEVICE_SCALE / 800)}`);
    const result = await capture(page);
    assert.equal(result.badge, '!');
    assert.match(result.tooltip, /^Clip: Could not capture this page\. /);
    assert.equal(await page.locator(TOAST).count(), 1);
    await page.close();
  });
});

describe('manifest', () => {
  test('does not use the debugger, and asks for nothing more than it needs', TIMEOUT, async () => {
    const { permissions, host_permissions: hosts } = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.deepEqual(permissions, ['activeTab', 'scripting', 'clipboardWrite', 'contextMenus', 'tabCapture', 'offscreen']);
    assert.equal(hosts, undefined);
  });

  test('registers its shortcuts', TIMEOUT, async () => {
    const commands = await worker.evaluate(() => chrome.commands.getAll());
    const shortcuts = Object.fromEntries(commands.map(({ name, shortcut }) => [name, shortcut]));
    const keys = process.platform === 'darwin' ? ['⇧⌘1', '⇧⌘2'] : ['Ctrl+Shift+1', 'Ctrl+Shift+2'];
    assert.deepEqual(shortcuts, { _execute_action: keys[0], 'capture-visible': keys[1] });
  });
});

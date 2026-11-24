/**
 * Clip: capture the entire page in one shot and copy it to the clipboard.
 *
 * Scroll-and-stitch extensions are slow because Chrome limits
 * tabs.captureVisibleTab() to two calls per second. Clip avoids that limit:
 * it attaches the DevTools protocol to the tab and asks Chrome to render the
 * whole page at once (Page.captureScreenshot with captureBeyondViewport), then
 * writes the PNG to the clipboard from inside the page.
 *
 * Nothing leaves the browser. No network requests, no storage.
 */

const PROTOCOL_VERSION = '1.3';
const BADGE_MS = 1500;
const DEFAULT_TITLE = chrome.runtime.getManifest().action.default_title;

/**
 * Chrome cannot render more than this many device pixels in one go. Past it,
 * the capture silently repeats the top of the page. Taller pages are captured
 * as several tiles and stitched together.
 */
const MAX_TILE_DEVICE_PX = 16384;

/** A canvas cannot be taller than this, so neither can a stitched image. */
const MAX_IMAGE_DEVICE_PX = 65535;

/**
 * Tile heights are multiples of this, so that a tile is a whole number of
 * device pixels on displays scaled in steps of 25% (1.25, 1.5, 1.75 ...).
 */
const TILE_STEP = 4;

/** Tabs with a capture in progress, so a double press does not attach twice. */
const busyTabs = new Set();

chrome.action.onClicked.addListener(async (tab) => {
  if (tab.id === undefined || busyTabs.has(tab.id)) return;
  busyTabs.add(tab.id);
  try {
    const shot = await captureFullPageToClipboard(tab);
    const summary = `${shot.imageWidth} × ${shot.imageHeight} px in ${Math.round(shot.totalMs)} ms`;
    console.info(`[clip] copied ${summary}`, shot);
    await showResult(tab.id, true, `Clip: copied ${summary}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('[clip] capture failed:', reason);
    await showResult(tab.id, false, `Clip: could not capture this page. ${reason}`);
  } finally {
    busyTabs.delete(tab.id);
  }
});

/**
 * Captures the whole page of the given tab and puts it on the clipboard.
 * Returns the size of the page and of the image, and how long each step took.
 */
async function captureFullPageToClipboard(tab) {
  const target = { tabId: tab.id };
  const send = (method, params) => chrome.debugger.sendCommand(target, method, params);
  const startedAt = performance.now();

  await chrome.debugger.attach(target, PROTOCOL_VERSION);
  try {
    await waitForViewportToSettle(send);
    await pinViewport(send, tab);
    const evaluate = await createIsolatedWorld(send);
    const readyAt = performance.now();

    const restoreScroll = await scrollToTop(evaluate);
    let page;
    let tiles;
    try {
      page = await measurePage(send, evaluate, tab);
      tiles = await captureTiles(send, page);
    } finally {
      await restoreScroll();
    }
    const capturedAt = performance.now();

    const png = tiles.length === 1 ? tiles[0] : await stitchTiles(tiles);
    const stitchedAt = performance.now();

    await writePngToClipboard(send, evaluate.contextId, png);
    const copiedAt = performance.now();

    return {
      cssWidth: page.cssWidth,
      cssHeight: page.cssHeight,
      imageWidth: page.imageWidth,
      imageHeight: page.imageHeight,
      tiles: tiles.length,
      settleMs: readyAt - startedAt,
      captureMs: capturedAt - readyAt,
      stitchMs: stitchedAt - capturedAt,
      copyMs: copiedAt - stitchedAt,
      totalMs: copiedAt - startedAt,
    };
  } finally {
    // Detaching also drops the viewport and focus emulation set above.
    await chrome.debugger.detach(target).catch(() => {});
  }
}

/**
 * Waits for the viewport to stop resizing after the debugger attaches.
 *
 * Attaching makes Chrome slide in its "started debugging this browser" bar,
 * which shrinks the viewport over roughly 150 ms. A capture taken while the
 * viewport is still moving comes out corrupted: the first screen is repeated
 * all the way down the image. So poll the viewport height and continue once
 * it has been still for a moment.
 *
 * When the bar is already showing (a capture a few seconds ago, or DevTools
 * attached by something else) nothing moves, and we stop waiting quickly.
 */
async function waitForViewportToSettle(send) {
  const POLL_MS = 8;
  const START_TIMEOUT_MS = 100; // how long to wait for the bar to start moving
  const STILL_MS = 40; // how long the height must stay unchanged
  const GIVE_UP_MS = 800;

  const viewportHeight = async () =>
    (await send('Page.getLayoutMetrics')).cssLayoutViewport.clientHeight;
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  const startedAt = performance.now();
  let lastHeight = await viewportHeight();
  let lastChangeAt = startedAt;
  let moved = false;

  for (;;) {
    await sleep(POLL_MS);
    const now = performance.now();
    const height = await viewportHeight();
    if (height !== lastHeight) {
      moved = true;
      lastHeight = height;
      lastChangeAt = now;
    }
    if (moved && now - lastChangeAt >= STILL_MS) return;
    if (!moved && now - startedAt >= START_TIMEOUT_MS) return;
    if (now - startedAt >= GIVE_UP_MS) return;
  }
}

/**
 * Pins the viewport to the size it had before the debugging bar appeared.
 *
 * The bar makes the viewport shorter, which changes the layout of anything
 * sized in viewport units (a 100vh hero, for example). Pinning the size the
 * tab had when the user pressed the button makes the capture match what they
 * were looking at. tab.width and tab.height are already in CSS pixels, so
 * they need no correction for page zoom.
 */
async function pinViewport(send, tab) {
  if (!tab.width || !tab.height) return;
  await send('Emulation.setDeviceMetricsOverride', {
    width: tab.width,
    height: tab.height,
    deviceScaleFactor: 0, // keep the real device pixel ratio
    mobile: false,
  });
}

/**
 * Creates an isolated world in the page and returns a function that evaluates
 * an expression there. The page's own scripts cannot see or interfere with it.
 */
async function createIsolatedWorld(send) {
  const { frameTree } = await send('Page.getFrameTree');
  const { executionContextId } = await send('Page.createIsolatedWorld', {
    frameId: frameTree.frame.id,
    worldName: 'clip',
  });
  const evaluate = async (expression) => {
    const { result, exceptionDetails } = await send('Runtime.evaluate', {
      expression,
      contextId: executionContextId,
      returnByValue: true,
      awaitPromise: true,
    });
    if (exceptionDetails) throw new Error(describeException(exceptionDetails));
    return result.value;
  };
  evaluate.contextId = executionContextId;
  return evaluate;
}

/**
 * Scrolls the page to the top and returns a function that scrolls back.
 *
 * Fixed and sticky elements are painted where the viewport currently is, so a
 * capture taken halfway down the page would show the site header in the
 * middle of the image. Capturing from the top puts it where readers expect.
 */
async function scrollToTop(evaluate) {
  const [x, y] = await evaluate('[window.scrollX, window.scrollY]');
  if (x === 0 && y === 0) return async () => {};

  // Wait two frames so scroll-driven headers have repainted, but never hang.
  await evaluate(`new Promise((done) => {
    window.scrollTo({ left: 0, top: 0, behavior: 'instant' });
    requestAnimationFrame(() => requestAnimationFrame(() => done(true)));
    setTimeout(() => done(true), 150);
  })`);
  return async () => {
    await evaluate(`window.scrollTo({ left: ${x}, top: ${y}, behavior: 'instant' })`).catch(() => {});
  };
}

/**
 * Measures the whole page.
 *
 * Page.captureScreenshot takes its clip in device-independent pixels, which
 * are CSS pixels multiplied by the page zoom. Passing CSS pixels on a page
 * zoomed to 125% would capture only the top-left 80% of it.
 *
 * The image is sized in whole device pixels, rounded down: when the page ends
 * on a fraction of a pixel (common when zoomed), rounding up would add a
 * one-pixel line of background along the bottom or right edge.
 */
async function measurePage(send, evaluate, tab) {
  const [{ cssContentSize }, devicePixelRatio, zoom] = await Promise.all([
    send('Page.getLayoutMetrics'),
    evaluate('window.devicePixelRatio'),
    chrome.tabs.getZoom(tab.id).catch(() => 1),
  ]);
  // Round away float noise first (a zoom of 0.8 arrives as 0.800000011920929).
  const toDevicePx = (css) => Math.floor(Math.round(css * devicePixelRatio * 100) / 100);
  const deviceScale = Math.round((devicePixelRatio / zoom) * 1000) / 1000;

  const imageWidth = toDevicePx(cssContentSize.width);
  const imageHeight = toDevicePx(cssContentSize.height);
  if (imageHeight > MAX_IMAGE_DEVICE_PX) {
    const pixels = imageHeight.toLocaleString('en-US');
    throw new Error(`The page is too long to fit in one image (${pixels} px tall).`);
  }
  return {
    cssWidth: Math.ceil(cssContentSize.width),
    cssHeight: Math.ceil(cssContentSize.height),
    width: imageWidth / deviceScale, // device-independent pixels
    height: imageHeight / deviceScale,
    deviceScale,
    imageWidth,
    imageHeight,
  };
}

/** Captures the page top to bottom as one or more base64 PNG tiles. */
async function captureTiles(send, page) {
  const tileHeight = Math.max(
    TILE_STEP,
    Math.floor(MAX_TILE_DEVICE_PX / page.deviceScale / TILE_STEP) * TILE_STEP,
  );
  const tiles = [];
  for (let y = 0; y < page.height; y += tileHeight) {
    const { data } = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      optimizeForSpeed: true,
      clip: { x: 0, y, width: page.width, height: Math.min(tileHeight, page.height - y), scale: 1 },
    });
    tiles.push(data);
  }
  return tiles;
}

/** Joins base64 PNG tiles top to bottom and returns one base64 PNG. */
async function stitchTiles(tiles) {
  const bitmaps = await Promise.all(
    tiles.map((tile) => createImageBitmap(new Blob([base64ToBytes(tile)], { type: 'image/png' }))),
  );
  const width = bitmaps[0].width;
  const height = bitmaps.reduce((sum, bitmap) => sum + bitmap.height, 0);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  let y = 0;
  for (const bitmap of bitmaps) {
    context.drawImage(bitmap, 0, y);
    y += bitmap.height;
    bitmap.close();
  }
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

/**
 * Writes a base64 PNG to the clipboard from inside the page.
 *
 * A service worker has no clipboard, so the write has to happen in a document.
 * Focus is emulated because the Clipboard API rejects writes from an
 * unfocused document, for example when the address bar has focus.
 */
async function writePngToClipboard(send, contextId, base64) {
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const { exceptionDetails } = await send('Runtime.callFunctionOn', {
    executionContextId: contextId,
    functionDeclaration: copyPngInPage.toString(),
    arguments: [{ value: base64 }],
    awaitPromise: true,
    userGesture: true,
  });
  if (exceptionDetails) throw new Error(describeException(exceptionDetails));
}

/** Runs inside the page. Must be self-contained: it is sent over as source text. */
async function copyPngInPage(base64) {
  if (!navigator.clipboard || typeof ClipboardItem === 'undefined') {
    throw new Error('The clipboard is not available on this page (it is not served over HTTPS).');
  }
  let bytes;
  if (typeof Uint8Array.fromBase64 === 'function') {
    bytes = Uint8Array.fromBase64(base64);
  } else {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'image/png' });
  await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
}

function base64ToBytes(base64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function describeException(details) {
  const description = details.exception?.description ?? details.text ?? 'Unknown error';
  return description.replace(/^Error: /, '').split('\n')[0];
}

/** Flashes a badge on the toolbar icon and puts the outcome in its tooltip. */
async function showResult(tabId, ok, title) {
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: ok ? '#1a7f37' : '#cf222e' });
    await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    await chrome.action.setBadgeText({ tabId, text: ok ? '✓' : '!' });
    await chrome.action.setTitle({ tabId, title });
  } catch {
    return; // The tab was closed while we were capturing.
  }
  setTimeout(() => {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    if (ok) chrome.action.setTitle({ tabId, title: DEFAULT_TITLE }).catch(() => {});
  }, BADGE_MS);
}

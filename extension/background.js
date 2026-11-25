/**
 * Clip: capture the entire page and copy it to the clipboard with one press.
 *
 * The page is scrolled from top to bottom, captured one screen at a time with
 * tabs.captureVisibleTab() and joined into one PNG. Chrome allows two such
 * captures per second, so the work between them is arranged to never be what
 * we are waiting for.
 *
 * Rendering the whole page at once through chrome.debugger is several times
 * faster, and an earlier version did that. But Chrome then shows a "started
 * debugging this browser" bar on every capture, and extensions cannot hide it.
 *
 * Nothing leaves the browser. No network requests, no storage.
 */

const DEFAULT_TITLE = chrome.runtime.getManifest().action.default_title;
const BADGE_MS = 2500;

/** Limits of a canvas in Chrome, and so of a joined image. */
const MAX_IMAGE_SIDE = 65535;
const MAX_IMAGE_AREA = 16384 * 16384;

/** How soon to try again when Chrome says we are capturing too fast. */
const QUOTA_RETRY_MS = 25;

/**
 * Rows, in CSS pixels, left off the bottom of every screen but the last and
 * taken from the next one instead. Keeps seams clean when the viewport ends on
 * a fraction of a pixel, as it does on a zoomed page.
 */
const SEAM_MARGIN = 2;

/**
 * Pages can grow while we scroll (lazy images, endless feeds). Follow them up
 * to this many times the height they had at the start, then stop.
 */
const MAX_GROWTH = 1.5;

/** Captures share one rate limit, so run one at a time. */
let busy = false;

chrome.action.onClicked.addListener((tab) => run(tab, 'full'));

chrome.commands.onCommand.addListener((command, tab) => {
  if (command === 'capture-visible') run(tab, 'visible');
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: 'full', title: 'Capture the full page', contexts: ['action'] });
    chrome.contextMenus.create({ id: 'visible', title: 'Capture the visible area', contexts: ['action'] });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => run(tab, info.menuItemId));

/** Captures the tab, puts the image on the clipboard and tells the user how it went. */
async function run(tab, mode) {
  if (tab?.id === undefined || busy) return;
  busy = true;
  const startedAt = performance.now();
  try {
    const shot = mode === 'visible' ? await captureVisibleArea(tab) : await captureFullPage(tab);
    const capturedAt = performance.now();
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': shot.png })]);
    const totalMs = performance.now() - startedAt;
    const stats = { mode, ...shot, png: undefined, thumbnail: undefined, copyMs: totalMs - (capturedAt - startedAt), totalMs };
    console.info(`[clip] copied ${shot.width} × ${shot.height} px in ${Math.round(totalMs)} ms`, stats);
    await report(tab, { ok: true, ...stats, thumbnail: shot.thumbnail });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    console.warn('[clip] capture failed:', reason);
    await report(tab, { ok: false, mode, reason });
  } finally {
    busy = false;
  }
}

// --------------------------------------------------------------- capturing

/** Captures what is visible in the tab right now. */
async function captureVisibleArea(tab) {
  // Chrome's own pages can be captured like this but not scripted, so there
  // is no earlier toast to clear on them.
  await injectPageScript(tab).then(() => callPage(tab, 'clearToast')).catch(() => {});
  const png = await captureScreen(tab);
  const bitmap = await createImageBitmap(png);
  const { width, height } = bitmap;
  const thumbnail = await makeThumbnail(bitmap, width, height);
  bitmap.close();
  return { png, thumbnail, width, height, screens: 1, complete: true };
}

/** Scrolls through the page and captures all of it. */
async function captureFullPage(tab) {
  await injectPageScript(tab);
  const page = await callPage(tab, 'prepare');
  try {
    checkImageSize(page.width * page.scale, page.height * page.scale);
    const image = new TallImage();
    const maxHeight = page.height * MAX_GROWTH;
    let screens = 0;
    let y = 0;
    let complete = true;
    let drawing = Promise.resolve();

    for (;;) {
      const view = await callPage(tab, 'scrollTo', y);
      const screenshot = await captureScreen(tab);
      screens++;

      // Decode and draw while the next screen is being scrolled into place.
      const bottom = image.plan(view);
      if (bottom === null) {
        complete = false; // the page would not scroll any further
        break;
      }
      const previous = drawing;
      drawing = (async () => {
        await previous;
        await image.draw(screenshot, view);
      })();
      drawing.catch(() => {}); // reported by the await below

      showProgress(tab, bottom / view.pageHeight);
      if (view.atBottom) break;
      if (bottom >= maxHeight) {
        complete = false; // an endless page
        break;
      }
      y = Math.floor(bottom) - 1;
    }
    await drawing;

    // Put the page back before encoding; encoding a long image takes a while.
    await callPage(tab, 'restore');
    const { canvas, width, height } = image.finish();
    const [png, thumbnail] = await Promise.all([
      canvas.convertToBlob({ type: 'image/png' }),
      makeThumbnail(canvas, width, height),
    ]);
    return { png, thumbnail, width, height, screens, complete };
  } finally {
    await callPage(tab, 'restore').catch(() => {}); // does nothing the second time
  }
}

/** Takes one PNG of the visible part of the tab, waiting for Chrome's rate limit if needed. */
async function captureScreen(tab) {
  for (;;) {
    await requireActive(tab);
    let dataUrl;
    try {
      dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
    } catch (error) {
      if (!String(error?.message).includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) throw error;
      await new Promise((resolve) => setTimeout(resolve, QUOTA_RETRY_MS));
      continue;
    }
    await requireActive(tab);
    const bytes = base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1));
    return new Blob([bytes], { type: 'image/png' });
  }
}

/**
 * captureVisibleTab() captures whichever tab is in front. Make sure that is
 * still the one we were asked to capture.
 */
async function requireActive(tab) {
  const now = await chrome.tabs.get(tab.id).catch(() => null);
  if (!now) throw new Error('The tab was closed.');
  if (!now.active || now.windowId !== tab.windowId) throw new Error('You switched to another tab.');
}

/** How tall an image of this width can be. */
function maxImageHeight(width) {
  return Math.min(MAX_IMAGE_SIDE, Math.floor(MAX_IMAGE_AREA / width));
}

function checkImageSize(width, height) {
  if (height > maxImageHeight(width)) {
    const pixels = Math.round(height).toLocaleString('en-US');
    throw new Error(`The page is too long to fit in one image (${pixels} px tall).`);
  }
}

/**
 * Joins screens, top to bottom, into one image.
 *
 * plan() decides which rows of a screen are new; draw() paints them. They are
 * separate so that scrolling can go on while screens are still being decoded.
 */
class TallImage {
  #canvas = null;
  #context = null;
  #rows = 0; // image rows spoken for so far

  /**
   * Returns how far down the page the image reaches with this screen, in CSS
   * pixels, or null if the screen shows nothing new.
   */
  plan(view) {
    const top = Math.round(view.scrollY * view.scale);
    const visible = Math.round(view.viewportHeight * view.scale);
    const margin = view.atBottom ? 0 : Math.ceil(SEAM_MARGIN * view.scale);
    const end = top + visible - margin;
    if (end <= this.#rows) return null;
    // Draw the last screen in full, over the rows it shares with the one
    // before it: only there are things pinned to the bottom of the window shown.
    const from = view.atBottom ? Math.min(top, this.#rows) : this.#rows;
    view.rows = { top, from: Math.max(from, top), end };
    this.#rows = end;
    return end / view.scale;
  }

  async draw(png, view) {
    const bitmap = await createImageBitmap(png);
    const { top, from, end } = view.rows;
    const width = Math.min(bitmap.width, Math.round(view.viewportWidth * view.scale));
    this.#fit(width, end, Math.round(view.pageHeight * view.scale));
    this.#context.drawImage(bitmap, 0, from - top, width, end - from, 0, from, width, end - from);
    bitmap.close();
  }

  /** Returns the finished image, cut to the rows that were captured. */
  finish() {
    return this.#resize(this.#rows);
  }

  /** Makes sure the canvas reaches down to `end`, with room for the rest of the page if possible. */
  #fit(width, end, pageEnd) {
    checkImageSize(width, end);
    const height = Math.min(maxImageHeight(width), Math.max(end, pageEnd));
    if (!this.#canvas) {
      this.#canvas = new OffscreenCanvas(width, height);
      this.#context = this.#canvas.getContext('2d', { alpha: false });
    } else if (end > this.#canvas.height) {
      this.#resize(height);
    }
  }

  #resize(height) {
    if (height !== this.#canvas.height) {
      const resized = new OffscreenCanvas(this.#canvas.width, height);
      const context = resized.getContext('2d', { alpha: false });
      context.drawImage(this.#canvas, 0, 0);
      this.#canvas = resized;
      this.#context = context;
    }
    return { canvas: this.#canvas, width: this.#canvas.width, height: this.#canvas.height };
  }
}

/** A small picture of the image for the toast, as base64 PNG. Tall images are cut at the bottom. */
async function makeThumbnail(source, width, height) {
  const WIDTH = 128;
  const HEIGHT = 160;
  // Show the whole page if that leaves it wide enough to recognize.
  const scale = Math.max(Math.min(WIDTH / width, HEIGHT / height), 56 / width);
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.min(HEIGHT, Math.round(height * scale)));
  const canvas = new OffscreenCanvas(w, h);
  const context = canvas.getContext('2d');
  context.imageSmoothingQuality = 'high';
  context.drawImage(source, 0, 0, width, h / scale, 0, 0, w, h);
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

// ------------------------------------------------------- talking to the page

async function injectPageScript(tab) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['page.js'] });
  } catch {
    throw new Error('Chrome does not let extensions scroll this page. Try capturing the visible area.');
  }
}

/** Calls a function that page.js defined in the page's isolated world. */
async function callPage(tab, name, ...args) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: (name, args) => globalThis.clipPage.call(name, args),
    args: [name, args],
  });
  // Chrome swallows exceptions thrown by injected code, so page.js returns them.
  if (!result) throw new Error('The page went away.');
  if (result.error) throw new Error(result.error);
  return result.value;
}

// --------------------------------------------------------- telling the user

function showProgress(tab, fraction) {
  const percent = Math.min(99, Math.round(fraction * 100));
  chrome.action.setBadgeBackgroundColor({ tabId: tab.id, color: '#57606a' }).catch(() => {});
  chrome.action.setBadgeTextColor({ tabId: tab.id, color: '#ffffff' }).catch(() => {});
  chrome.action.setBadgeText({ tabId: tab.id, text: `${percent}%` }).catch(() => {});
}

/** Says how the capture went: a toast in the page, and a badge and tooltip on the button. */
async function report(tab, outcome) {
  const tabId = tab.id;
  const size = `${outcome.width} × ${outcome.height} px`;
  const what = outcome.mode === 'visible' ? 'Visible area' : 'Full page';
  const toast = outcome.ok
    ? {
        ok: true,
        title: outcome.complete ? 'Copied to the clipboard' : 'Copied, but not the whole page',
        detail: outcome.complete ? `${what}, ${size}` : `The rest could not be scrolled to. ${size}`,
        thumbnail: outcome.thumbnail,
      }
    : { ok: false, title: 'Could not capture this page', detail: outcome.reason };

  // No toast on pages that cannot be scripted. The badge is all there is.
  const toasted = callPage(tab, 'showToast', toast).catch(() => {});
  try {
    await chrome.action.setBadgeBackgroundColor({ tabId, color: outcome.ok ? '#1a7f37' : '#cf222e' });
    await chrome.action.setBadgeTextColor({ tabId, color: '#ffffff' });
    await chrome.action.setBadgeText({ tabId, text: outcome.ok ? '✓' : '!' });
    await chrome.action.setTitle({ tabId, title: `Clip: ${toast.title}. ${toast.detail}` });
  } catch {
    return; // The tab was closed while we were capturing.
  }
  await toasted;
  setTimeout(() => {
    if (busy) return; // another capture is using the badge
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    if (outcome.ok) chrome.action.setTitle({ tabId, title: DEFAULT_TITLE }).catch(() => {});
  }, BADGE_MS);
}

// ------------------------------------------------------------------- base64

function base64ToBytes(base64) {
  if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(base64);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function bytesToBase64(bytes) {
  if (typeof bytes.toBase64 === 'function') return bytes.toBase64();
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

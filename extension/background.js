/**
 * Clip: capture the entire page and copy it to the clipboard with one press.
 *
 * The page is scrolled from top to bottom and joined from screens into one
 * PNG. Screens come from tabs.captureVisibleTab(), which is exact but limited
 * to two per second. On long pages, screens that would have to wait for that
 * limit are filmed through tabCapture instead, and their colors corrected with
 * what the exact screens show (see yuv.js).
 *
 * Rendering the whole page at once through chrome.debugger is faster still,
 * and version 0.1 did that. But Chrome then shows a "started debugging this
 * browser" bar on every capture, and extensions cannot hide it.
 *
 * Nothing leaves the browser. No network requests, no storage.
 */

importScripts('yuv.js');

const DEFAULT_TITLE = chrome.runtime.getManifest().action.default_title;
const BADGE_MS = 2500;

/** Limits of a canvas in Chrome, and so of a joined image. */
const MAX_IMAGE_SIDE = 65535;
const MAX_IMAGE_AREA = 16384 * 16384;

/** How soon to try again when Chrome says we are capturing too fast. */
const QUOTA_RETRY_MS = 25;

/**
 * As long as a capture can be done within this time, wait for Chrome's rate
 * limit and capture screens exactly. That is enough for about six screens. On
 * longer pages, the screens there is no time to wait for are filmed.
 */
const limits = { exactMs: 2500 };

/** The longest wait for the rate limit, and how long filming a screen takes. */
const QUOTA_WAIT_MS = 1000;
const FILM_MS = 120;

/** How long to wait for video to start, and for a frame, before going on without. */
const VIDEO_START_MS = 2000;
const VIDEO_FRAME_MS = 1000;

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
  return { png, thumbnail, width, height, screens: 1, filmed: 0, complete: true };
}

/** Scrolls through the page and captures all of it. */
async function captureFullPage(tab) {
  const startedAt = performance.now();
  const fitsInTime = (ms) => performance.now() - startedAt + ms <= limits.exactMs;
  await injectPageScript(tab);
  const page = await callPage(tab, 'prepare');
  try {
    checkImageSize(page.width * page.scale, page.height * page.scale);
    const image = new TallImage();
    const maxHeight = page.height * MAX_GROWTH;
    const video = new Video(tab);
    let y = 0;
    let complete = true;
    let drawing = Promise.resolve();

    try {
      for (;;) {
        const view = await callPage(tab, 'scrollTo', y);
        const bottom = image.plan(view);
        if (bottom === null) {
          complete = false; // the page would not scroll any further
          break;
        }

        // The last screen is always exact: it is drawn in full, so the mark
        // that tells frames apart would show.
        const screensLeft = Math.ceil((view.pageHeight - bottom) / (view.viewportHeight - view.seam));
        let png = await tryCaptureScreen(tab);
        if (!png && fitsInTime(QUOTA_WAIT_MS + screensLeft * FILM_MS)) png = await captureScreen(tab);
        let frame = null;
        if (!view.atBottom && (png ? video.isOpen : video.isWanted)) frame = await video.film(view);
        if (!png && !frame) png = await captureScreen(tab);

        if (png) {
          // Decode and draw while the next screen is being scrolled into place.
          const previous = drawing;
          drawing = (async () => {
            await previous;
            await image.draw(png, view);
          })();
          drawing.catch(() => {}); // reported by the await below
        }
        if (frame) image.addFrame(frame, view, { exact: Boolean(png) });

        const allExactMs = (screensLeft / 2) * QUOTA_WAIT_MS;
        if (y === 0 && !fitsInTime(allExactMs)) video.open(await pngSize(png));

        showProgress(tab, bottom / view.pageHeight);
        if (view.atBottom) break;
        if (bottom >= maxHeight) {
          complete = false; // an endless page
          break;
        }
        y = Math.floor(bottom) - 1;
      }
    } finally {
      await video.close();
    }
    await drawing;

    // Put the page back before encoding; encoding a long image takes a while.
    await callPage(tab, 'restore');
    const { canvas, width, height, screens, filmed } = image.finish();
    const [png, thumbnail] = await Promise.all([
      canvas.convertToBlob({ type: 'image/png' }),
      makeThumbnail(canvas, width, height),
    ]);
    return { png, thumbnail, width, height, screens, filmed, complete };
  } finally {
    await callPage(tab, 'restore').catch(() => {}); // does nothing the second time
  }
}

/** Takes one PNG of the visible part of the tab, waiting for Chrome's rate limit if needed. */
async function captureScreen(tab) {
  for (;;) {
    const png = await tryCaptureScreen(tab);
    if (png) return png;
    await sleep(QUOTA_RETRY_MS);
  }
}

/** Takes one PNG of the visible part of the tab, or returns null if Chrome's rate limit is in the way. */
async function tryCaptureScreen(tab) {
  await requireActive(tab);
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' });
  } catch (error) {
    if (String(error?.message).includes('MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND')) return null;
    throw error;
  }
  await requireActive(tab);
  const bytes = base64ToBytes(dataUrl.slice(dataUrl.indexOf(',') + 1));
  return new Blob([bytes], { type: 'image/png' });
}

/** Reads the size of a PNG from its header. */
async function pngSize(png) {
  const header = new DataView(await png.slice(0, 24).arrayBuffer());
  return { width: header.getUint32(16), height: header.getUint32(20) };
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
 * Films the tab, for screens that cannot be captured right away.
 *
 * Only ever a help: if video cannot be started or a frame does not come, it
 * closes, and every screen is captured exactly, just more slowly.
 */
class Video {
  #tab;
  #opening = null;
  #state = 'unused'; // then 'opening', 'open' and 'closed'
  #mark = 0;

  constructor(tab) {
    this.#tab = tab;
  }

  get isOpen() {
    return this.#state === 'open';
  }

  get isWanted() {
    return this.#state === 'opening' || this.#state === 'open';
  }

  /** Starts filming at exactly the size of the screens, in the background. */
  open({ width, height }) {
    if (width % 2 || height % 2) return; // video comes in even sizes only
    this.#state = 'opening';
    this.#opening = within(VIDEO_START_MS, this.#start(width, height)).then(
      () => { if (this.#state === 'opening') this.#state = 'open'; },
      (error) => this.#giveUp(error),
    );
  }

  async #start(width, height) {
    await closeOffscreenDocument();
    await chrome.offscreen.createDocument({
      url: 'video.html',
      reasons: ['USER_MEDIA'],
      justification: 'Film the tab while it is scrolled, to capture long pages quickly.',
    });
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: this.#tab.id });
    await this.#send('start', { streamId, width, height });
    if (this.#state !== 'opening') await closeOffscreenDocument(); // started too late
  }

  /** Returns a frame of what is on screen now, or null. */
  async film(view) {
    // While we wait, nothing moves but the mark. Without it, the first frame
    // may never come.
    if (this.#state === 'opening') await callPage(this.#tab, 'showMark', 0);
    await this.#opening;
    if (!this.isOpen) return null;
    this.#mark = (this.#mark % 255) + 1;
    const mark = this.#mark;
    const { left, cell, cells, height } = await callPage(this.#tab, 'showMark', mark);
    const { scale, viewportHeight } = view;
    const channel = new BroadcastChannel('clip-video');
    try {
      const arrival = new Promise((resolve) => {
        channel.onmessage = ({ data }) => { if (data.mark === mark) resolve(data.frame); };
      });
      await this.#send('grab', {
        mark,
        left: left * scale,
        cell: cell * scale,
        cells,
        row: Math.round((viewportHeight - height / 2) * scale),
      });
      return await within(VIDEO_FRAME_MS, arrival);
    } catch (error) {
      this.#giveUp(error);
      return null;
    } finally {
      channel.close();
    }
  }

  async close() {
    if (this.#state === 'unused') return;
    this.#state = 'closed';
    await this.#opening;
    await closeOffscreenDocument();
  }

  #giveUp(error) {
    console.warn('[clip] going on without video:', error.message);
    this.#state = 'closed';
  }

  async #send(type, message) {
    const { error } = await chrome.runtime.sendMessage({ target: 'video', type, ...message });
    if (error) throw new Error(error);
  }
}

async function closeOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) await chrome.offscreen.closeDocument().catch(() => {});
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
  #screens = 0;
  #lastScreen = Infinity; // the first row of the last screen, once there is one
  #filmed = []; // frames to be developed into the image
  #samples = []; // frames of screens that were captured exactly, too

  /**
   * Returns how far down the page the image reaches with this screen, in CSS
   * pixels, or null if the screen shows nothing new.
   */
  plan(view) {
    const top = Math.round(view.scrollY * view.scale);
    const visible = Math.round(view.viewportHeight * view.scale);
    const margin = view.atBottom ? 0 : Math.ceil(view.seam * view.scale);
    const end = top + visible - margin;
    if (end <= this.#rows) return null;
    // Draw the last screen in full, over the rows it shares with the one
    // before it: only there are things pinned to the bottom of the window shown.
    const from = view.atBottom ? Math.min(top, this.#rows) : this.#rows;
    view.rows = { top, from: Math.max(from, top), end };
    if (view.atBottom) this.#lastScreen = view.rows.from;
    this.#rows = end;
    this.#screens++;
    return end / view.scale;
  }

  /** Adds a video frame, either of a new screen or of one that was also captured exactly. */
  addFrame(frame, view, { exact }) {
    (exact ? this.#samples : this.#filmed).push({ frame, view });
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
    const filmed = this.#filmed.length;
    this.#developFrames();
    return { ...this.#resize(this.#rows), screens: this.#screens, filmed };
  }

  /** Paints the filmed screens, last, with everything the exact ones have to tell. */
  #developFrames() {
    if (this.#filmed.length === 0) return;
    const palette = new Palette();
    const width = this.#canvas.width;
    for (const { frame, view } of this.#samples) {
      const { top, from, end } = this.#rowsOf(view);
      if (end > from) palette.learn(frame, this.#context.getImageData(0, from, width, end - from), from - top);
    }
    for (const { frame, view } of this.#filmed) {
      const { top, from, end } = this.#rowsOf(view);
      if (end <= from) continue;
      this.#fit(width, end, Math.round(view.pageHeight * view.scale));
      this.#context.putImageData(palette.develop(frame, from - top, end - top, width), 0, from);
    }
    this.#samples = [];
    this.#filmed = [];
  }

  /** The rows of a screen, short of those the last screen was drawn over. */
  #rowsOf({ rows: { top, from, end } }) {
    return { top, from, end: Math.min(end, this.#lastScreen) };
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

// ------------------------------------------------------------------- helpers

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Settles like the promise, or rejects if that takes too long. */
function within(ms, promise) {
  let timer;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
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
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

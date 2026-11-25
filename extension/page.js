/**
 * The part of Clip that runs inside the page being captured, in the
 * extension's isolated world: the page's own scripts cannot see it.
 *
 * It scrolls the page, keeps it presentable while it is captured, puts
 * everything back afterwards, and shows the toast.
 *
 * Injected again for every capture, so it replaces whatever an earlier
 * version of the extension left behind.
 */
(() => {
  const TOAST_ATTRIBUTE = 'data-clip-toast';
  const MARK_ATTRIBUTE = 'data-clip-mark';
  const MARK_CELLS = 10; // a white one, a black one and eight for the number
  const SCROLL_KEYS = new Set([
    ' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown', 'Home', 'End',
  ]);

  /** What has to be undone after a capture; null when there is none in progress. */
  let session = null;

  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

  /** Waits until the page has been painted, but never hangs if it is not being painted. */
  const nextPaint = () => new Promise((done) => {
    requestAnimationFrame(() => requestAnimationFrame(() => done()));
    setTimeout(done, 150);
  });

  const scroller = () => document.scrollingElement ?? document.documentElement;

  // ------------------------------------------------------------- capturing

  async function prepare() {
    restore(); // in case an earlier capture was cut short
    await clearToast();
    if (window.visualViewport && Math.abs(window.visualViewport.scale - 1) > 0.01) {
      throw new Error('The page is pinch-zoomed. Zoom back out and try again.');
    }

    session = {
      x: window.scrollX,
      y: window.scrollY,
      styles: [], // [element, property, value, priority], oldest first
      fixed: new Map(), // element -> 'first' | 'last' | 'always'
      hidden: new Set(),
      settled: new WeakSet(), // sticky elements already dealt with
      canceled: false,
      input: new AbortController(),
    };
    holdStill();

    const root = document.documentElement;
    for (const element of [root, document.body]) {
      if (!element) continue;
      setStyle(element, 'scroll-snap-type', 'none');
      setStyle(element, 'overflow-anchor', 'none');
    }
    // Overlay scrollbars (the macOS default) fade in when the page scrolls and
    // would be in the picture. Ordinary scrollbars take up room, so hiding
    // them would change the layout; those are cut off the image instead.
    if (window.innerWidth === scroller().clientWidth) setStyle(root, 'scrollbar-width', 'none');

    return {
      width: scroller().clientWidth,
      height: scroller().scrollHeight,
      scale: window.devicePixelRatio,
    };
  }

  /** Scrolls to a position, waits for the page to look right there, and describes the view. */
  async function scrollTo(y) {
    throwIfCanceled();
    hideMark();
    jumpTo(y);
    await nextPaint();
    tidyPinnedElements(y === 0);
    finishTransitions();
    await waitForImages(300);
    await nextPaint();
    throwIfCanceled();
    return describeView();
  }

  function describeView() {
    const root = scroller();
    return {
      scrollY: window.scrollY,
      viewportWidth: root.clientWidth, // without scrollbars
      viewportHeight: root.clientHeight,
      pageHeight: root.scrollHeight,
      scale: window.devicePixelRatio,
      seam: markHeight() + 2,
      atBottom: isAtBottom(),
    };
  }

  // ------------------------------------------------------------------ mark

  /**
   * Draws a number, as black and white cells, along the bottom edge of the
   * window. A video frame that shows it was filmed after everything that came
   * before, scrolling included. The rows it covers are taken from the next
   * screen, so it never ends up in the image.
   *
   * After the number comes a cell that never stands still. Chrome sends a frame
   * when something on the page has changed, and now and then misses a change;
   * on a page that then keeps still, the frame we wait for would never come.
   */
  function showMark(mark) {
    throwIfCanceled();
    hideMark();
    const cell = Math.max(8, Math.ceil(16 / window.devicePixelRatio));
    const left = 32; // clear of the window's rounded corner
    const height = markHeight();
    const host = css(document.createElement('div'), {
      all: 'initial', display: 'flex', position: 'fixed', inset: 'auto', left: `${left}px`, bottom: '0',
      width: `${cell * (MARK_CELLS + 1)}px`, height: `${height}px`, margin: '0', padding: '0', border: '0',
      overflow: 'hidden', 'pointer-events': 'none', 'z-index': '2147483647',
    });
    host.setAttribute(MARK_ATTRIBUTE, '');
    host.popover = 'manual';
    const shadow = host.attachShadow({ mode: 'closed' }); // out of reach of the page's styles
    const addCell = (color) => {
      const element = css(document.createElement('div'), { width: `${cell}px`, height: `${height}px`, background: color });
      shadow.append(element);
      return element;
    };
    for (let i = 0; i < MARK_CELLS; i++) {
      const light = i === 0 || (i > 1 && (mark >> (MARK_CELLS - 1 - i)) & 1);
      addCell(light ? '#fff' : '#000');
    }
    addCell('#000').animate({ opacity: [0, 1] }, { duration: 500, iterations: Infinity, direction: 'alternate' });
    document.documentElement.append(host);
    try {
      host.showPopover();
    } catch {
      // The z-index has to do.
    }
    return { left, cell, cells: MARK_CELLS, height };
  }

  function hideMark() {
    for (const mark of document.querySelectorAll(`[${MARK_ATTRIBUTE}]`)) mark.remove();
  }

  function markHeight() {
    return Math.ceil(6 / window.devicePixelRatio);
  }

  function isAtBottom() {
    const root = scroller();
    return window.scrollY + root.clientHeight >= root.scrollHeight - 1;
  }

  function jumpTo(y) {
    window.scrollTo({ left: 0, top: y, behavior: 'instant' });
  }

  function restore() {
    hideMark();
    if (!session) return;
    const { x, y, styles, input } = session;
    session = null;
    input.abort();
    // Put transitions back last, so that nothing fades back into view.
    const undo = styles.reverse();
    for (const entry of undo) if (entry[1] !== 'transition') putBack(entry);
    void document.documentElement.offsetHeight;
    for (const entry of undo) if (entry[1] === 'transition') putBack(entry);
    window.scrollTo({ left: x, top: y, behavior: 'instant' });
  }

  function putBack([element, property, value, priority]) {
    if (value) element.style.setProperty(property, value, priority);
    else element.style.removeProperty(property);
    if (element.getAttribute('style') === '') element.removeAttribute('style');
  }

  function setStyle(element, property, value) {
    const { style } = element;
    session.styles.push([element, property, style.getPropertyValue(property), style.getPropertyPriority(property)]);
    style.setProperty(property, value, 'important');
  }

  /** Keeps the user from scrolling while we do. Esc cancels the capture. */
  function holdStill() {
    const options = { capture: true, passive: false, signal: session.input.signal };
    const block = (event) => event.preventDefault();
    window.addEventListener('wheel', block, options);
    window.addEventListener('touchmove', block, options);
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        if (session) session.canceled = true;
        event.preventDefault();
        event.stopImmediatePropagation();
      } else if (SCROLL_KEYS.has(event.key)) {
        event.preventDefault();
      }
    }, options);
  }

  function throwIfCanceled() {
    if (!session) throw new Error('The capture was interrupted.');
    if (session.canceled) throw new Error('Canceled.');
  }

  // ------------------------------------------------ headers, bars, backdrops

  /**
   * Elements that stay put while the page scrolls would show up again on every
   * screen. Show each of them once: things pinned to the top of the window on
   * the first screen, things pinned to the bottom on the last one.
   *
   * Runs on every screen, because pages often pin their header only once they
   * have been scrolled.
   */
  function tidyPinnedElements(isFirst) {
    const isLast = isAtBottom();
    const found = [];
    for (const element of everyElement(document)) {
      const { position } = getComputedStyle(element);
      if (position === 'fixed' && !session.fixed.has(element)) found.push(element);
      else if (position === 'sticky' && !session.settled.has(element)) unstick(element);
    }
    for (const element of keepPinnedToWindow(found)) {
      session.fixed.set(element, whenToShow(element));
    }
    for (const [element, when] of session.fixed) {
      const show = when === 'always' || (isFirst && isLast) || (when === 'first' ? isFirst : isLast);
      if (show) reveal(element);
      else hide(element);
    }
  }

  /** Elements of the document, including those inside shadow roots. */
  function* everyElement(root) {
    for (const element of root.querySelectorAll('*')) {
      yield element;
      const shadow = element.shadowRoot;
      if (shadow) yield* everyElement(shadow);
    }
  }

  /**
   * position: fixed inside a transformed element scrolls along with it.
   * Nudge the page and keep only the elements that did not move.
   */
  function keepPinnedToWindow(elements) {
    if (elements.length === 0) return elements;
    const y = window.scrollY;
    const before = elements.map((element) => element.getBoundingClientRect().top);
    jumpTo(isAtBottom() ? y - 10 : y + 10);
    const moved = window.scrollY - y;
    const pinned = elements.filter((element, i) =>
      moved === 0 || Math.abs(element.getBoundingClientRect().top - before[i]) < Math.abs(moved) / 2);
    jumpTo(y);
    return pinned;
  }

  function whenToShow(element) {
    const rect = element.getBoundingClientRect();
    const coversWindow = rect.width >= window.innerWidth * 0.9 && rect.height >= window.innerHeight * 0.9;
    if (coversWindow) return Number(getComputedStyle(element).zIndex) < 0 ? 'always' : 'first';
    return rect.top + rect.height / 2 < window.innerHeight / 2 ? 'first' : 'last';
  }

  function hide(element) {
    if (session.hidden.has(element)) return;
    session.hidden.add(element);
    setStyle(element, 'transition', 'none');
    setStyle(element, 'opacity', '0'); // unlike visibility, children cannot override it
  }

  function reveal(element) {
    if (!session.hidden.delete(element)) return;
    const index = session.styles.findLastIndex(([target, property]) => target === element && property === 'opacity');
    putBack(session.styles.splice(index, 1)[0]);
  }

  /** Puts an element that sticks to the window back in its place in the page. */
  function unstick(element) {
    session.settled.add(element);
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      if (parent === document.body || parent === document.documentElement) break;
      const { overflowY } = getComputedStyle(parent);
      if (overflowY !== 'visible' && overflowY !== 'clip') return; // sticks to an inner scroller
    }
    setStyle(element, 'position', 'relative');
    for (const side of ['top', 'right', 'bottom', 'left']) setStyle(element, side, 'auto');
  }

  // --------------------------------------------------------- waiting for it

  /** Content that fades or slides in as it is scrolled to would be caught halfway. */
  function finishTransitions() {
    for (const animation of document.getAnimations()) {
      if (!(animation instanceof CSSTransition)) continue;
      try {
        animation.finish();
      } catch {
        // Cannot be finished. Leave it alone.
      }
    }
  }

  async function waitForImages(limitMs) {
    const loading = [...document.images].filter((image) => {
      if (image.complete) return false;
      const { top, bottom } = image.getBoundingClientRect();
      return bottom > 0 && top < window.innerHeight;
    });
    if (loading.length === 0) return;
    await Promise.race([
      Promise.all(loading.map((image) => image.decode().catch(() => {}))),
      sleep(limitMs),
    ]);
  }

  // ----------------------------------------------------------------- toast

  /** Removes a toast that is still showing, so that it is not in the next capture. */
  async function clearToast() {
    const toasts = document.querySelectorAll(`[${TOAST_ATTRIBUTE}]`);
    if (toasts.length === 0) return;
    for (const toast of toasts) toast.remove();
    await nextPaint();
  }

  /**
   * Shows how the capture went. A success comes with a flash across the page,
   * like a camera, and a thumbnail of what was captured.
   *
   * Styled through the CSSOM and the Web Animations API only: a page's content
   * security policy can block style sheets.
   */
  async function showToast({ ok, title, detail, thumbnail }) {
    for (const old of document.querySelectorAll(`[${TOAST_ATTRIBUTE}]`)) old.remove();
    const calm = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const host = document.createElement('div');
    host.setAttribute(TOAST_ATTRIBUTE, '');
    host.setAttribute('role', 'status');
    host.popover = 'manual'; // the top layer, above dialogs and everything else
    css(host, {
      all: 'initial', display: 'block', position: 'fixed', inset: '0', width: '100vw', height: '100vh',
      margin: '0', padding: '0', border: '0', background: 'transparent', overflow: 'hidden',
      'pointer-events': 'none', 'z-index': '2147483647',
    });
    const shadow = host.attachShadow({ mode: 'closed' });

    const card = css(document.createElement('div'), {
      position: 'absolute', top: '16px', right: '16px', 'max-width': '340px', 'box-sizing': 'border-box',
      display: 'flex', 'align-items': 'center', gap: '14px', padding: '12px 18px 12px 12px',
      'border-radius': '14px', background: 'rgba(24, 24, 27, 0.96)', color: '#fff',
      border: `1px solid ${ok ? 'rgba(255, 255, 255, 0.16)' : '#ff7b72'}`,
      'box-shadow': '0 12px 40px rgba(0, 0, 0, 0.35)',
      font: '13px/1.4 system-ui, -apple-system, sans-serif',
    });
    if (thumbnail) card.append(await drawThumbnail(thumbnail));
    card.append(drawMark(ok));

    const text = document.createElement('div');
    const heading = css(document.createElement('div'), { 'font-weight': '600', 'font-size': '14px' });
    heading.textContent = title;
    const small = css(document.createElement('div'), { color: 'rgba(255, 255, 255, 0.72)', 'margin-top': '2px' });
    small.textContent = detail;
    text.append(heading, small);
    card.append(text);

    if (ok && !calm) {
      const flash = css(document.createElement('div'), { position: 'absolute', inset: '0', background: '#fff', opacity: '0' });
      shadow.append(flash);
      flash.animate({ opacity: [0.75, 0] }, { duration: 420, easing: 'ease-out' });
    }
    shadow.append(card);
    document.documentElement.append(host);
    try {
      host.showPopover();
    } catch {
      // Still visible without the top layer, thanks to the z-index.
    }

    const slide = calm ? ['none', 'none'] : ['translateY(-12px) scale(0.96)', 'none'];
    card.animate({ opacity: [0, 1], transform: slide }, { duration: 180, easing: 'cubic-bezier(0.2, 0.9, 0.3, 1.2)' });

    // Stay longer when there is something to read. Not awaited: the capture is done.
    sleep(ok ? 2600 : 7000)
      .then(() => card.animate({ opacity: [1, 0] }, { duration: 220, fill: 'forwards' }).finished)
      .catch(() => {})
      .then(() => host.remove());
  }

  /** Drawn on a canvas, because a page's content security policy can block data: images. */
  async function drawThumbnail(base64) {
    const binary = atob(base64);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/png' }));
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    return css(canvas, {
      width: `${bitmap.width / 2}px`, height: `${bitmap.height / 2}px`, flex: 'none',
      'border-radius': '6px', 'box-shadow': '0 0 0 1px rgba(255, 255, 255, 0.25)',
    });
  }

  function drawMark(ok) {
    const mark = css(document.createElement('div'), {
      width: '24px', height: '24px', 'border-radius': '50%', flex: 'none', display: 'flex',
      'align-items': 'center', 'justify-content': 'center', color: '#fff',
      background: ok ? '#2da44e' : '#cf222e', font: 'bold 15px/1 system-ui, sans-serif',
    });
    mark.textContent = ok ? '✓' : '!';
    return mark;
  }

  function css(element, properties) {
    for (const [name, value] of Object.entries(properties)) element.style.setProperty(name, value, 'important');
    return element;
  }

  // ------------------------------------------------------------- entry point

  const functions = { prepare, scrollTo, showMark, restore, clearToast, showToast };

  globalThis.clipPage = {
    /** Chrome swallows exceptions thrown by injected code, so return them instead. */
    async call(name, args) {
      try {
        return { value: await functions[name](...args) };
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
})();

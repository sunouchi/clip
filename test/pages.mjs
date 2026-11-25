// Made-up pages used by the tests. Never test against real sites or real
// screens: captures can contain private information.

export const SECTION_COLORS = ['#e3f2fd', '#fff3e0', '#e8f5e9', '#fce4ec', '#ede7f6'];
export const HEADER_COLOR = '#c62828';
export const FOOTER_COLOR = '#111111';

/**
 * A page with the things that usually go wrong in full-page captures:
 * a fixed header (should appear once, at the top), a block sized in viewport
 * units (should keep the height the user saw), numbered sections in known
 * colors (should all be in place) and a dark footer (should be the last thing
 * in the image).
 */
export function sectionsPage(count, sectionHeight = 800) {
  const sections = Array.from({ length: count }, (_, i) =>
    `<section style="height:${sectionHeight}px;background:${SECTION_COLORS[i % SECTION_COLORS.length]}">${i + 1}</section>`,
  ).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Clip test page (${count} sections)</title>
<style>
  html, body { margin: 0 }
  header { position: fixed; top: 0; left: 0; right: 0; height: 60px; z-index: 10; background: ${HEADER_COLOR};
           color: #fff; font: bold 24px system-ui; display: flex; align-items: center; padding-left: 24px }
  main { padding-top: 60px }
  .hero { height: 100vh; background: repeating-linear-gradient(45deg, #fafafa, #fafafa 20px, #ddd 20px, #ddd 40px) }
  .hero, section { display: flex; align-items: center; justify-content: center; font: bold 120px system-ui }
  footer { height: 100px; background: ${FOOTER_COLOR}; color: #fff; font: bold 40px system-ui;
           display: flex; align-items: center; justify-content: center }
</style></head>
<body>
<header>FIXED HEADER</header>
<main><div class="hero">100vh</div>
${sections}
</main>
<footer>END</footer>
</body></html>`;
}

/**
 * A ruler: every CSS pixel row carries its own row number as a color
 * (red = low byte, green = high byte). Reading the rows back from a capture
 * shows exactly which rows are missing, duplicated or out of order, which is
 * how we check the seams between stitched tiles.
 */
export function rulerPage(rows) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Clip ruler (${rows} rows)</title>
<style>
  html, body { margin: 0 }
  canvas { display: block; width: 100%; height: ${rows}px; image-rendering: pixelated }
</style></head>
<body><canvas width="1" height="${rows}"></canvas>
<script>
  const context = document.querySelector('canvas').getContext('2d');
  const image = context.createImageData(1, ${rows});
  for (let y = 0; y < ${rows}; y++) {
    image.data[y * 4] = y & 255;
    image.data[y * 4 + 1] = (y >> 8) & 255;
    image.data[y * 4 + 2] = 128;
    image.data[y * 4 + 3] = 255;
  }
  context.putImageData(image, 0, 0);
</script>
</body></html>`;
}

export const BAR_COLOR = '#00695c';
export const STICKY_COLOR = '#6a1b9a';
export const REVEAL_COLOR = '#ef6c00';
export const CARD_COLOR = '#1565c0';

/**
 * A page that fights back: smooth scrolling, scroll snapping, a header that
 * JavaScript pins only after scrolling, a sticky menu, a bar fixed to the
 * bottom whose styles are all animated, content that fades in as it is
 * scrolled to, and a "fixed" card inside a transformed box, which is not
 * really fixed and has to stay in the picture.
 */
export function trickyPage(footerHeight = 200) {
  const sections = Array.from({ length: 5 }, (_, i) =>
    `<section style="background:${SECTION_COLORS[i]}">${i + 1}</section>`).join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Clip tricky page</title>
<style>
  html { scroll-behavior: smooth; scroll-snap-type: y mandatory }
  html, body { margin: 0 }
  header { position: absolute; top: 0; left: 0; right: 0; height: 60px; z-index: 10; background: ${HEADER_COLOR} }
  header.pinned { position: fixed }
  main { padding-top: 60px }
  nav { position: sticky; top: 60px; height: 40px; z-index: 5; background: ${STICKY_COLOR} }
  section { height: 700px; scroll-snap-align: start; display: flex; align-items: center; justify-content: center;
            font: bold 120px system-ui }
  .reveal { height: 300px; background: ${REVEAL_COLOR}; opacity: 0; transition: opacity 2s }
  .reveal.seen { opacity: 1 }
  .box { height: 200px; transform: translateZ(0); background: #fff }
  .card { position: fixed; top: 50px; left: 0; width: 200px; height: 100px; background: ${CARD_COLOR} }
  .bar { position: fixed; bottom: 0; left: 0; right: 0; height: 50px; z-index: 10; background: ${BAR_COLOR};
         transition: all 3s }
  footer { height: ${footerHeight}px; background: ${FOOTER_COLOR} }
</style></head>
<body>
<header></header>
<main><nav></nav>
${sections}
<div class="reveal"></div>
<div class="box"><div class="card"></div></div>
</main>
<footer></footer>
<div class="bar"></div>
<script>
  const header = document.querySelector('header');
  addEventListener('scroll', () => header.classList.toggle('pinned', scrollY > 100));
  new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) entry.target.classList.add('seen');
  })).observe(document.querySelector('.reveal'));
</script>
</body></html>`;
}

/** A page that gets longer every time its end is reached, up to a limit. */
export function growingPage(steps) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Clip growing page</title>
<style>html, body { margin: 0 } div { height: 1000px }</style></head>
<body><div style="background:${SECTION_COLORS[0]}"></div><div style="background:${SECTION_COLORS[1]}"></div>
<script>
  let left = ${steps};
  addEventListener('scroll', () => {
    if (left <= 0 || scrollY + innerHeight < document.documentElement.scrollHeight - 50) return;
    left--;
    const block = document.createElement('div');
    block.style.background = '${SECTION_COLORS[2]}';
    document.body.append(block);
  });
</script>
</body></html>`;
}

/**
 * A ruler in black and white: every band of four CSS pixels carries its number
 * as bars. Video keeps black and white exact, so this is how we check the
 * seams between filmed screens. The first two of the twenty bars are always
 * white and black, and lie where the mark that tells frames apart is drawn.
 */
export function barsPage(bands) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Clip bars (${bands} bands)</title>
<style>
  html, body { margin: 0 }
  canvas { display: block; width: 100%; height: ${bands * 4}px; image-rendering: pixelated }
</style></head>
<body><canvas width="20" height="${bands}"></canvas>
<script>
  const context = document.querySelector('canvas').getContext('2d');
  const image = context.createImageData(20, ${bands});
  for (let band = 0; band < ${bands}; band++) {
    const bars = [1, 0, ...Array.from({ length: 16 }, (_, i) => (band >> (15 - i)) & 1), 0, 1];
    bars.forEach((light, i) => image.data.set([light * 255, light * 255, light * 255, 255], (band * 20 + i) * 4));
  }
  context.putImageData(image, 0, 0);
</script>
</body></html>`;
}

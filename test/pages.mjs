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

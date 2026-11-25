/**
 * Films the tab being captured. Runs in an offscreen document, because a
 * service worker cannot receive video.
 *
 * The frames go to the service worker and nowhere else. Nothing is recorded.
 */

const channel = new BroadcastChannel('clip-video');

let latest = null; // the newest frame
let wanted = null; // the request waiting for its frame
let queue = Promise.resolve(); // one thing at a time, so that frames are not closed while in use

const handlers = {
  async start({ streamId, width, height }) {
    const size = { minWidth: width, maxWidth: width, minHeight: height, maxHeight: height };
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId, maxFrameRate: 60, ...size },
      },
    });
    const reader = new MediaStreamTrackProcessor({ track: stream.getVideoTracks()[0] }).readable.getReader();
    const first = await reader.read();
    if (first.done) throw new Error('the video ended');
    const { format, codedWidth, codedHeight, visibleRect } = first.value;
    if (visibleRect.width !== width || visibleRect.height !== height || codedWidth !== width || codedHeight !== height) {
      throw new Error(`the video is ${visibleRect.width} × ${visibleRect.height}, not ${width} × ${height}`);
    }
    if (format !== 'I420' && format !== 'NV12') throw new Error(`the video is in ${format}`);
    latest = first.value;
    watch(reader);
  },

  /** Sends the first frame that shows the given mark. The service worker gives up if none comes. */
  async grab(request) {
    wanted = request;
    await run(deliver);
  },
};

async function watch(reader) {
  for (;;) {
    const { value: frame, done } = await reader.read();
    if (done) return;
    await run(() => {
      latest.close();
      latest = frame;
      return deliver();
    });
  }
}

function run(task) {
  queue = queue.then(task).catch((error) => console.warn('[clip]', error));
  return queue;
}

async function deliver() {
  if (!wanted || (await readMark(latest, wanted)) !== wanted.mark) return;
  const { mark } = wanted;
  wanted = null;
  const data = new Uint8Array(latest.allocationSize());
  const layout = await latest.copyTo(data);
  const { format, codedWidth: width, codedHeight: height } = latest;
  channel.postMessage({ mark, frame: { data, layout, format, width, height } });
}

/** Reads the mark that page.js drew: a white cell, a black cell, then eight cells of a number. */
async function readMark(frame, { left, row, cell, cells }) {
  const x = Math.floor(left / 2) * 2;
  const y = Math.floor(row / 2) * 2;
  const width = Math.ceil((cell * cells + 2) / 2) * 2;
  const rect = { x, y, width, height: 2 };
  const data = new Uint8Array(frame.allocationSize({ rect }));
  const [luma] = await frame.copyTo(data, { rect });
  const isLight = (i) => data[luma.offset + Math.round(left - x + (i + 0.5) * cell)] > 126;
  if (!isLight(0) || isLight(1)) return 0;
  let mark = 0;
  for (let i = 2; i < cells; i++) mark = mark * 2 + (isLight(i) ? 1 : 0);
  return mark;
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (message.target !== 'video') return false;
  handlers[message.type](message).then(
    () => reply({}),
    (error) => reply({ error: String(error?.message ?? error) }),
  );
  return true;
});

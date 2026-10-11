// Does the slow squaring for the locked-away password (see lib/timelock.js) off the settings page's main
// thread, so the page stays usable while it runs. The page stops it by ending the worker.
//
//   { type: 'measure' }                    → { type: 'rate', rate }
//   { type: 'run', n, x, done, steps }     → { type: 'progress', x, done, rate } about every half second,
//                                            then { type: 'finished', x }
import { measureRate, square } from './lib/timelock.js';

const BATCH = 1000;
const REPORT_EVERY_MS = 500;

async function run({ n, x, done, steps }) {
  let since = performance.now();
  let doneSince = done;
  while (done < steps) {
    const count = Math.min(BATCH, steps - done);
    x = square(x, n, count);
    done += count;
    const now = performance.now();
    if (now - since >= REPORT_EVERY_MS || done === steps) {
      postMessage({ type: 'progress', x, done, rate: Math.round(((done - doneSince) / (now - since)) * 1000) });
      since = now;
      doneSince = done;
      // Let the message go out before carrying on.
      await new Promise((resume) => setTimeout(resume, 0));
    }
  }
  postMessage({ type: 'finished', x });
}

onmessage = ({ data }) => {
  if (data.type === 'measure') postMessage({ type: 'rate', rate: measureRate(data.ms) });
  if (data.type === 'run') run(data);
};

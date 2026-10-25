// What the locked-away password's page (lockbox.html) and the settings page share: where the box and the
// unlocking progress are kept, how long a wait reads, and the one line that says where things stand.
import { isBox } from './timelock.js';

export const BOX = 'lockbox'; // the sealed box (lib/timelock.js)
export const PROGRESS = 'lockboxProgress'; // { n, x, done }: the box being worked on, the number reached so far, steps done

const plural = (count, word) => `${count} ${word}${count === 1 ? '' : 's'}`;

/** "45 seconds", "12 minutes", "3 hours 20 minutes", "2 days": a wait in words. */
export function duration(seconds) {
  seconds = Math.max(1, Math.round(seconds));
  if (seconds < 60) return plural(seconds, 'second');
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return plural(minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return [plural(hours, 'hour'), minutes % 60 ? plural(minutes % 60, 'minute') : ''].filter(Boolean).join(' ');
  const days = Math.floor(hours / 24);
  return [plural(days, 'day'), hours % 24 ? plural(hours % 24, 'hour') : ''].filter(Boolean).join(' ');
}

/** The stored box and the progress made on it, if any: { box, progress }, each null when there is none. */
export async function loadBox(store) {
  const { [BOX]: box, [PROGRESS]: progress } = await store.get([BOX, PROGRESS]);
  if (!isBox(box)) return { box: null, progress: null };
  // Progress only counts for the box it was made on.
  return { box, progress: progress?.n === box.n ? progress : null };
}

/** One line on where things stand, for the settings page. */
export function describeBox({ box, progress }) {
  if (!box) return 'No password is locked away.';
  const since = new Date(box.lockedAt).toLocaleDateString(undefined, { dateStyle: 'medium' });
  if (progress) return `A password is locked away (since ${since}); unlocking it is ${Math.floor((progress.done / box.steps) * 100)}% done.`;
  return `A password is locked away (since ${since}); getting it back takes about ${duration(box.steps / box.rate)}.`;
}

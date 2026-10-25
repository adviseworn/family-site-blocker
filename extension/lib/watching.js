// When the add-on was watching, and when it wasn't: the answer to "has Family Site Blocker ever been
// switched off?" (#69). Firefox keeps no history of an add-on being switched off and on, and nothing else
// on the computer answers it well, so the add-on keeps its own account, in the extension's storage under
// WATCHING:
//
//   { since, atLeast?, periods: [{ from, to }, …], off: [{ from, to, pages }, …] }
//
// `since` is when the add-on first started watching in this browser profile: the moment it was installed
// (background.js, runtime.onInstalled) or, in a profile that had a version from before this was kept
// (1.7.0), the earliest try that version noted as it happened, which proves it was running then; such a
// `since` is marked `atLeast`, because the add-on may well have been installed earlier.
//
// `periods` are the stretches of time the background script is known to have been running, oldest first:
// it notes the time when it starts, on every page load it sees, and once a minute (an alarm). A note within
// GAP_MS of the last one extends the current stretch; a longer silence ends it, and the next note starts a
// new one. Between two stretches the add-on wasn't noting anything: the browser was closed, the computer
// was asleep, or the add-on was off (switched off, in Firefox's Troubleshoot Mode, or removed and put back
// again). The browser's own history tells those apart: pages visited inside the silence mean the browser was
// in use while the add-on wasn't running. Such a silence goes into `off` with how many pages the history
// held from it; a silence with nothing in it is closed up, the two stretches around it becoming one, so
// `periods` stays short however often the browser is closed or the computer sleeps.
//
// A visit found in the browser's history (lib/attempts.js, from: 'history') is then one of four things:
// from before the add-on was installed; from a time the add-on was off; from a time it was running, which
// means the site wasn't on a list yet (a listed site's page load is noted as it happens, and taken out of
// the history); or from after it was installed but before this version kept track, when either may be true.
//
// Pure functions, shared by background.js and the record pages, and tested in test/blocker.test.mjs.

export const WATCHING = 'watching';
export const BEAT_EVERY_MINUTES = 1; // the alarm's period
export const GAP_MS = 150_000; // 2.5 minutes of silence, two missed beats and some slack, ends a stretch
export const WRITE_EVERY_MS = 20_000; // a stretch's end is written this often at most, so page loads don't each write
export const MAX_PERIODS = 1000; // only reached if a thousand silences held pages; a few tens of kilobytes
export const MAX_OFF = 1000;

/** A well-formed state from whatever is stored, with nothing lost. */
export function normalize(state) {
  const periods = Array.isArray(state?.periods) ? state.periods.filter(wellFormed).map(({ from, to }) => ({ from, to })) : [];
  const off = Array.isArray(state?.off) ? state.off.filter(wellFormed).map(({ from, to, pages }) => ({ from, to, pages: Number.isFinite(pages) ? pages : 0 })) : [];
  return {
    ...(Number.isFinite(state?.since) ? { since: state.since } : {}),
    ...(state?.atLeast ? { atLeast: true } : {}),
    periods,
    off,
  };
}

const wellFormed = (span) => span && Number.isFinite(span.from) && Number.isFinite(span.to) && span.from <= span.to;

/**
 * Notes when the add-on first started watching, unless that is known already. `atLeast` says the time is
 * the earliest the add-on is known to have been running (the first try an earlier version noted), not when
 * it was installed.
 */
export function started(state, at, { atLeast = false } = {}) {
  const base = normalize(state);
  if (base.since !== undefined || !Number.isFinite(at)) return base;
  return { ...base, since: at, ...(atLeast ? { atLeast: true } : {}) };
}

/** The earliest try an earlier version noted as it happened (not from the history), or null. */
export function earliestLiveTry(attempts) {
  let earliest = null;
  for (const attempt of Array.isArray(attempts) ? attempts : []) {
    if (attempt.from === 'history' || !Number.isFinite(attempt.at)) continue;
    if (earliest === null || attempt.at < earliest) earliest = attempt.at;
  }
  return earliest;
}

/**
 * Notes that the add-on is running now. Returns the new state and whether it is worth writing: a new
 * stretch always is; a stretch that merely grew is written every WRITE_EVERY_MS, so the stored end of
 * the current stretch is at most that far behind.
 */
export function beat(state, now) {
  const base = normalize(state);
  if (!Number.isFinite(now)) return { state: base, changed: false };
  const last = base.periods[base.periods.length - 1];
  if (last && now - last.to <= GAP_MS) {
    if (now <= last.to) return { state: base, changed: false }; // a clock set back, or the same moment
    const periods = [...base.periods.slice(0, -1), { from: last.from, to: now }];
    return { state: { ...base, periods }, changed: now - last.to >= WRITE_EVERY_MS };
  }
  const periods = [...base.periods, { from: now, to: now }];
  return { state: { ...base, periods: periods.slice(Math.max(0, periods.length - MAX_PERIODS)) }, changed: true };
}

/** The silences between the stretches the add-on was running, oldest first: [{ from, to }]. */
export function gapsOf(state) {
  const { periods } = normalize(state);
  const gaps = [];
  for (let i = 1; i < periods.length; i += 1) {
    if (periods[i].from > periods[i - 1].to) gaps.push({ from: periods[i - 1].to, to: periods[i].from });
  }
  return gaps;
}

/**
 * Takes in what the browser's history held for each silence, { from, to, pages, listed }: `pages` the pages
 * the history holds from it, `listed` the visits to listed sites the record holds from it (the add-on takes
 * those out of the history once they are in the record). A silence with either is noted in `off`, or its
 * note brought up to date; one with neither is closed up, unless it was noted before (the history has been
 * cleared since, which is no reason to forget it). Findings for silences the state no longer has are
 * ignored. Returns the new state, or the same object when nothing changed.
 */
export function noteGaps(state, findings) {
  const base = normalize(state);
  let { periods, off } = base;
  let changed = false;
  for (const finding of Array.isArray(findings) ? findings : []) {
    if (!wellFormed(finding)) continue;
    const i = periods.findIndex((period, index) => index > 0 && periods[index - 1].to === finding.from && period.from === finding.to);
    if (i < 0) continue;
    const pages = Number.isFinite(finding.pages) ? finding.pages : 0;
    const listed = Number.isFinite(finding.listed) ? finding.listed : 0;
    const known = off.findIndex((entry) => entry.from === finding.from && entry.to === finding.to);
    if (pages + listed > 0) {
      if (known >= 0 && off[known].pages === pages) continue;
      const entry = { from: finding.from, to: finding.to, pages };
      off = known >= 0 ? [...off.slice(0, known), entry, ...off.slice(known + 1)] : [...off, entry].sort((a, b) => a.from - b.from);
      changed = true;
    } else if (known < 0) {
      // Nothing happened in it: the browser was closed or the computer asleep. Close it up.
      periods = [...periods.slice(0, i - 1), { from: periods[i - 1].from, to: periods[i].to }, ...periods.slice(i + 1)];
      changed = true;
    }
  }
  if (!changed) return state === undefined ? base : state;
  return { ...base, periods, off: off.slice(Math.max(0, off.length - MAX_OFF)) };
}

/**
 * Whether the add-on was running at a moment: true inside a stretch, false in a silence, null when
 * nothing is known about that moment (before this version kept track, or no state at all). The moments
 * right after the last stretch's end count as in it, for as long as beat() would still extend it: that
 * end is written at most once a minute, and a visit found in the history a moment ago must not read as
 * one from a time the add-on was off.
 */
export function wasRunning(state, at) {
  const { periods } = normalize(state);
  if (!periods.length || !Number.isFinite(at) || at < periods[0].from) return null;
  const last = periods[periods.length - 1];
  if (at > last.to) return at - last.to <= GAP_MS;
  return periods.some((period) => at >= period.from && at <= period.to);
}

/**
 * What a visit found in the browser's history says, given when the add-on was watching:
 *   'before'   from before the add-on was installed (or, with `atLeast`, before it is known to have run);
 *   'off'      from a time the add-on wasn't running, after this version started keeping track;
 *   'unlisted' from a time the add-on was running: it noted no try, so the site wasn't on a list yet;
 *   'unseen'   from after the add-on was installed but before this version kept track of when it ran,
 *              when it may have been off, or the site may not have been listed yet.
 */
export function kindOfVisit(state, at) {
  const base = normalize(state);
  if (base.since === undefined || !Number.isFinite(at) || at < base.since) return 'before';
  const running = wasRunning(base, at);
  if (running === true) return 'unlisted';
  if (running === false) return 'off';
  return 'unseen';
}

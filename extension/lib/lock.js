// The lock line of the settings page's board: whether anything stops the person at the keyboard switching
// the add-on off, and, under the Firefox lock, which copy of the lock's profile is installed.
//
// Firefox reports an add-on a policy requires (the lock's Extensions policy) as installed by an
// administrator that can't be switched off: management.getSelf() gives installType "admin" with
// mayDisable false (its source strips the permission to disable from such an add-on), and needs no
// permission. Either report says a lock is on (#69), not which copy: the profile changes whenever the
// built-in list does, and installing a new copy takes the administrator password, so a Mac can sit on an
// old one. So the profile also carries a stamp, through Firefox's 3rdparty policy, which hands values to
// one add-on as its managed storage (browser.storage.managed): the version of the add-on it was built
// with, how many entries Firefox's own copy of the list has and, from DIGEST_FROM, a digest of that copy
// and the lock's other settings (scripts/firefox-lock.mjs writes the same stamp into
// extension/rules/lock.json, the add-on's own copy, so it knows which profile belongs to its version). The
// copies are compared by the digest, so a profile from an older version is fine while nothing in it has
// changed (#78), and a profile from before the digest by its version, against the version the add-on's
// own list and settings date from (sameSince in its own copy). Only a policy can write managed storage,
// so the stamp can be trusted; and Firefox reads policies when it starts, so the line describes the lock
// as of Firefox's last start.

/** The key under which the profile's 3rdparty policy sets the stamp, and the add-on reads it. */
export const STAMP = 'lock';
/** The first version whose profile carries the stamp: a lock without one is a copy from before it. */
export const STAMP_FROM = '1.8.0';
/** The first version whose stamp carries the digest: a stamp without one is compared by its version. */
export const DIGEST_FROM = '1.15.0';
/** The add-on's own copy of the stamp, in its package (the build writes it). */
export const STAMP_FILE = 'rules/lock.json';

/** Compares two dotted version numbers: negative when a is older, 0 when the same, positive when newer. */
export function compareVersions(a, b) {
  const parse = (version) => String(version).split('.').map((part) => Number.parseInt(part, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (x[i] ?? 0) - (y[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

const isVersion = (value) => typeof value === 'string' && /^\d+(\.\d+)*$/.test(value);

/** Whether a value is a stamp as the profile writes it. */
export const isStamp = (value) =>
  value != null && typeof value === 'object' && isVersion(value.version) && Number.isInteger(value.entries) && value.entries >= 0;

/** Whether a stamp carries the digest (from DIGEST_FROM), as the build writes it. */
export const hasDigest = (stamp) => isStamp(stamp) && typeof stamp.digest === 'string' && /^[0-9a-f]+$/.test(stamp.digest);

/**
 * The stamp the installed profile carries, from the add-on's managed storage, or null: when there is no
 * policy or manifest giving the add-on any (Firefox rejects the call then), or what is there isn't a stamp.
 */
export async function managedStamp(storage) {
  try {
    const stored = await storage.managed.get(STAMP);
    return isStamp(stored?.[STAMP]) ? stored[STAMP] : null;
  } catch {
    return null;
  }
}

/**
 * The add-on's own copy of the stamp, the one its version's profile carries (STAMP_FILE), or null when it
 * can't be read. `runtime` is the browser's runtime API, for the file's address; `fetcher` fetches it.
 */
export async function ownStamp(runtime, fetcher = globalThis.fetch) {
  try {
    const stamp = await (await fetcher(runtime.getURL(STAMP_FILE))).json();
    return isStamp(stamp) ? stamp : null;
  } catch {
    return null;
  }
}

/**
 * Whether the profile a stamp comes from carries the same list and settings as the add-on's own version's
 * (`own`, the add-on's own copy of the stamp): true, false, or null when it can't be told, as without the
 * own copy. A stamp with a digest is compared by it. One from before the digest is the same when its
 * version is from when the add-on's own list and settings were first what they are (sameSince) or later,
 * and it has as many entries.
 */
export function sameSettings(stamp, own) {
  if (!isStamp(stamp) || !isStamp(own)) return null;
  // Any digest at all is compared, so a malformed one can't pass for a copy from before the digest.
  if (typeof stamp.digest === 'string') return typeof own.digest === 'string' ? stamp.digest === own.digest : null;
  if (!isVersion(own.sameSince)) return null;
  return stamp.entries === own.entries && compareVersions(stamp.version, own.sameSince) >= 0;
}

// Firefox's own copy of the list is counted in entries: an entry is a site, or a whole top-level domain.
const entries = (n) => (n === 1 ? '1 entry' : `${n.toLocaleString('en-US')} entries`);
const link = (anchor, text) => ({ anchor, text });
// The README headings the links go to, as GitHub makes anchors of them (test/readme.test.mjs checks that they exist).
const KEEP_IT_INSTALLED = 'keep-it-installed-after-firefox-quits';
const LOCK_IT = 'lock-it-so-nobody-can-switch-it-off-firefox-on-a-mac';

const IN_FORCE = 'The Firefox lock is in force: Firefox installed the add-on itself and gives no way to switch it off or remove it.';

/**
 * Whether the browser reports the add-on as locked: installed by policy (installType "admin"), or with no way
 * to switch it off (mayDisable false). Firefox reports both under the lock; either is enough.
 */
export const locked = ({ installType, mayDisable }) => installType === 'admin' || mayDisable === false;

const CATCH_UP = "Install the current profile so Firefox's own list and the lock's other settings catch up. ";

/**
 * What the lock line says and how it is marked. `installType` and `mayDisable` are management.getSelf()'s;
 * `stamp` the installed profile's (managedStamp), or null; `own` the add-on's version; `ownStamp` the
 * add-on's own copy of the stamp (ownStamp), or null; `firefox` whether this is Firefox. Returns
 * { state: 'ok' | 'todo', parts }, the parts being strings and { anchor, text } links into the README.
 */
export function describeLock({ installType, mayDisable, stamp = null, own, ownStamp = null, firefox }) {
  const byPolicy = locked({ installType, mayDisable });
  if (byPolicy && firefox) {
    if (!stamp) {
      return {
        state: 'todo',
        parts: [
          `${IN_FORCE} The lock installed is a copy from before version ${STAMP_FROM}, so this page can't say which; installing the current profile gives Firefox the current list, and says so here. `,
          link(LOCK_IT, 'How to install it'),
          '.',
        ],
      };
    }
    const age = compareVersions(stamp.version, own);
    // A copy from another version is fine while its list and settings are this version's (#78); without
    // a way to tell (no own copy of the stamp), the version has to say.
    const same = sameSettings(stamp, ownStamp);
    if (same === true && age !== 0) {
      return { state: 'ok', parts: [`${IN_FORCE} The lock installed is the copy from version ${stamp.version}, with the same list and settings as this version's (${own}): ${entries(stamp.entries)} in Firefox's own list.`] };
    }
    if (age < 0) {
      return {
        state: 'todo',
        parts: [
          `The Firefox lock is in force, but it's an older copy: from version ${stamp.version}, with ${entries(stamp.entries)} in Firefox's own list, while this is version ${own}. ${CATCH_UP}`,
          link(LOCK_IT, 'How to install it'),
          '.',
        ],
      };
    }
    if (age > 0) {
      return { state: 'ok', parts: [`${IN_FORCE} The lock installed is the copy from version ${stamp.version}, newer than this add-on (${own}), which updates itself.`] };
    }
    if (same === false) {
      // Stamped with this version, but built from another list or other settings (a local build, say).
      return {
        state: 'todo',
        parts: [
          `The Firefox lock is in force, but the copy installed isn't this version's (${own}): its list or settings differ, with ${entries(stamp.entries)} in Firefox's own list. ${CATCH_UP}`,
          link(LOCK_IT, 'How to install it'),
          '.',
        ],
      };
    }
    return { state: 'ok', parts: [`${IN_FORCE} The lock installed is this version's copy (${own}), with ${entries(stamp.entries)} in Firefox's own list.`] };
  }
  if (byPolicy) {
    return { state: 'ok', parts: ['Installed by policy: the browser gives no way to switch the add-on off or remove it.'] };
  }
  if (firefox && installType === 'development') {
    return {
      state: 'todo',
      parts: ['Loaded temporarily: Firefox removes the add-on when it quits, and anyone can switch it off before then. ', link(KEEP_IT_INSTALLED, 'How to keep it installed, and lock it'), '.'],
    };
  }
  if (firefox) {
    return {
      state: 'todo',
      parts: ['Not under the Firefox lock: anyone who opens the Add-ons Manager can switch the add-on off or remove it. ', link(LOCK_IT, 'How to lock it, on a Mac'), '.'],
    };
  }
  return {
    state: 'todo',
    parts: ['Anyone who can open the extensions page can switch the add-on off or remove it; the lock covers Firefox only. ', link('limits', 'What to do about that'), '.'],
  };
}

/** Whether the lock line describes the Firefox lock in force (so its other settings, private windows off among them, are too). */
export const lockInForce = ({ installType, mayDisable, firefox }) => firefox && locked({ installType, mayDisable });

/** The parts of a line as plain text, for tests and messages. */
export const textOf = (parts) => parts.map((part) => (typeof part === 'string' ? part : part.text)).join('');

#!/usr/bin/env node
// npm run mac-installer: builds the installer package that puts the launch agent closing Firefox's Option
// key into /Library/LaunchAgents (see scripts/firefox-lock.mjs, launchAgent()). The agent on its own takes
// two Terminal lines and an administrator's password to install; the package is double-clicked like the
// lock's profile and asks for the same password, and its postinstall script also loads the agent for every
// account logged in at that moment, so the key is closed at once rather than at the next login.
//
// Needs a Mac: pkgbuild makes the component package from a folder laid out like the disk, and productbuild
// wraps it with a title and the text Installer shows. The package is unsigned (signing needs an Apple
// Developer ID), so macOS asks, once, to open it anyway under Privacy & Security. The Sign with Mozilla
// workflow builds it on GitHub's Mac and attaches it to each release (.github/workflows/mac-installer.yml),
// and the Mac tests install it and check what it did (test/mac-installer.e2e.mjs).
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { AGENT_LABEL, SAFE_MODE_KEY_VARIABLE, launchAgent } from './firefox-lock.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const VERSION = JSON.parse(readFileSync(join(ROOT, 'extension', 'manifest.json'), 'utf8')).version;
export const DIST_DIR = join(ROOT, 'dist', 'mac');
export const PKG_IDENTIFIER = AGENT_LABEL; // the receipt's name, for pkgutil
export const AGENT_INSTALLED_PATH = `/Library/LaunchAgents/${AGENT_LABEL}.plist`;
export const pkgName = (version = VERSION) => `family-site-blocker-firefox-troubleshoot-key-${version}.pkg`;
export const TITLE = "Family Site Blocker: close Firefox's Option key";

/**
 * Runs as root once the file is in place. Loads the agent for every account logged in now (which runs it
 * and sets the variable in that account's session), so no logout is needed; from the next login each
 * account's own launchd does it. Nothing here can fail the install: the file is what matters.
 */
export const postinstall = () => `#!/bin/sh
# Family Site Blocker: close Firefox's Option key. Runs after ${AGENT_INSTALLED_PATH} is in place.
PLIST="${AGENT_INSTALLED_PATH}"
chown root:wheel "$PLIST"
chmod 644 "$PLIST"
# Every account logged in right now has a launchd session of its own (gui/<uid>); the others get the agent at login.
for uid in $(dscl . -list /Users UniqueID | awk '$2 >= 500 { print $2 }'); do
  launchctl print "gui/$uid" >/dev/null 2>&1 || continue
  launchctl bootout "gui/$uid/${AGENT_LABEL}" 2>/dev/null
  launchctl bootstrap "gui/$uid" "$PLIST" 2>/dev/null
  launchctl asuser "$uid" launchctl setenv ${SAFE_MODE_KEY_VARIABLE} 1 2>/dev/null
done
exit 0
`;

/** What Installer shows first. */
export const welcome = () => `This installs a small launch agent for every account on this Mac. At each login it sets the variable ${SAFE_MODE_KEY_VARIABLE}, which makes Firefox ignore the Option key held while it opens, so Troubleshoot Mode, where no add-on runs, can't be started that way. It changes nothing else.

It takes effect at once for the accounts logged in now, and at login for the others.

Troubleshoot Mode can still be started from Terminal (open -a Firefox --args --safe-mode); Screen Time's App Restrictions can keep Terminal out. The agent is listed under System Settings > General > Login Items & Extensions, where an account may be able to switch it off. To remove it, delete ${AGENT_INSTALLED_PATH} and log out and in.
`;

/** What Installer shows at the end. */
export const conclusion = () => `The Option key is closed: holding it while Firefox opens now just opens Firefox. Accounts not logged in now get it at their next login.
`;

/** The distribution file productbuild wraps the component package with: one choice, no customizing. */
export const distribution = (version = VERSION) => `<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>${TITLE}</title>
  <welcome file="welcome.txt" mime-type="text/plain"/>
  <conclusion file="conclusion.txt" mime-type="text/plain"/>
  <options customize="never" rootVolumeOnly="true" hostArchitectures="x86_64,arm64"/>
  <domains enable_localSystem="true"/>
  <choices-outline>
    <line choice="default">
      <line choice="agent"/>
    </line>
  </choices-outline>
  <choice id="default"/>
  <choice id="agent" visible="false">
    <pkg-ref id="${PKG_IDENTIFIER}"/>
  </choice>
  <pkg-ref id="${PKG_IDENTIFIER}" version="${version}" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
`;

/**
 * Builds the package into `out` (dist/mac): lays the agent out as it sits on disk, adds the postinstall
 * script and the texts, then runs pkgbuild and productbuild. Returns the package's path.
 */
export function buildInstaller({ version = VERSION, out = DIST_DIR } = {}) {
  if (process.platform !== 'darwin') throw new Error('Building the installer package needs a Mac (pkgbuild and productbuild).');
  rmSync(out, { recursive: true, force: true });
  const root = join(out, 'root');
  const scripts = join(out, 'scripts');
  const resources = join(out, 'resources');
  mkdirSync(join(root, 'Library', 'LaunchAgents'), { recursive: true });
  mkdirSync(scripts, { recursive: true });
  mkdirSync(resources, { recursive: true });
  writeFileSync(join(root, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`), launchAgent());
  writeFileSync(join(scripts, 'postinstall'), postinstall());
  chmodSync(join(scripts, 'postinstall'), 0o755);
  writeFileSync(join(resources, 'welcome.txt'), welcome());
  writeFileSync(join(resources, 'conclusion.txt'), conclusion());
  writeFileSync(join(out, 'Distribution.xml'), distribution(version));
  const component = join(out, 'component.pkg');
  execFileSync('pkgbuild', ['--root', root, '--scripts', scripts, '--identifier', PKG_IDENTIFIER, '--version', version, '--install-location', '/', '--ownership', 'recommended', component], { stdio: 'inherit' });
  const pkg = join(out, pkgName(version));
  execFileSync('productbuild', ['--distribution', join(out, 'Distribution.xml'), '--package-path', out, '--resources', resources, pkg], { stdio: 'inherit' });
  for (const made of [root, scripts, resources, component, join(out, 'Distribution.xml')]) rmSync(made, { recursive: true, force: true });
  return pkg;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const pkg = buildInstaller();
    console.log(`Wrote ${relative(process.cwd(), pkg)}: double-click to install the launch agent that closes Firefox's Option key (unsigned: allow it once under Privacy & Security).`);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

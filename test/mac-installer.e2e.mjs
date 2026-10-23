// The installer package for the launch agent that closes Firefox's Option key (scripts/mac-installer.mjs):
// builds it, installs it the way Installer does (installer -pkg), checks what it left on the Mac, and takes
// it away again. Run with: npm run test:mac-installer
//
// Installing changes the Mac for every account (/Library/LaunchAgents) and needs sudo, so like the lock
// tests this only runs on a Mac in CI (GitHub's), with sudo that asks for no password.
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { AGENT_LABEL, SAFE_MODE_KEY_VARIABLE, launchAgent } from '../scripts/firefox-lock.mjs';
import { AGENT_INSTALLED_PATH, PKG_IDENTIFIER, VERSION, buildInstaller, pkgName } from '../scripts/mac-installer.mjs';

const test = (name, fn) => it(name, { timeout: 60_000 }, fn);
const run = (command, args) => spawnSync(command, args, { encoding: 'utf8' });
const sudo = (...args) => assert.equal(spawnSync('sudo', ['-n', ...args], { stdio: 'inherit' }).status, 0, args.join(' '));

function whyNot() {
  if (process.platform !== 'darwin') return 'needs a Mac';
  if (!process.env.CI) return 'installing changes this Mac for every account, so it only runs in CI';
  if (spawnSync('sudo', ['-n', 'true']).status === 0) return false;
  return 'needs sudo without a password';
}

describe('the installer package for the launch agent that closes the Option key', { skip: whyNot() }, () => {
  const uid = process.getuid();
  let pkg;

  before(() => {
    assert.ok(!existsSync(AGENT_INSTALLED_PATH), `${AGENT_INSTALLED_PATH} is there before the test`);
    pkg = buildInstaller();
    sudo('installer', '-pkg', pkg, '-target', '/');
  }, { timeout: 180_000 });

  after(() => {
    spawnSync('launchctl', ['bootout', `gui/${uid}/${AGENT_LABEL}`]);
    spawnSync('launchctl', ['unsetenv', SAFE_MODE_KEY_VARIABLE]);
    sudo('rm', '-f', AGENT_INSTALLED_PATH);
    sudo('pkgutil', '--forget', PKG_IDENTIFIER);
  }, { timeout: 60_000 });

  test('the package is named after the version and Installer accepted it', () => {
    assert.ok(pkg.endsWith(`/${pkgName(VERSION)}`), pkg);
    assert.ok(statSync(pkg).size > 1000, 'a real package');
    const receipt = run('pkgutil', ['--pkg-info', PKG_IDENTIFIER]);
    assert.equal(receipt.status, 0, receipt.stderr);
    assert.match(receipt.stdout, new RegExp(`version: ${VERSION.replace(/\\./g, '\\.')}`));
  });

  test('the agent is in /Library/LaunchAgents, owned by root, readable by all, as written by the build', () => {
    assert.equal(readFileSync(AGENT_INSTALLED_PATH, 'utf8'), launchAgent());
    const stat = statSync(AGENT_INSTALLED_PATH);
    assert.equal(stat.uid, 0, 'owned by root');
    assert.equal(stat.mode & 0o777, 0o644);
    const lint = run('plutil', ['-lint', AGENT_INSTALLED_PATH]);
    assert.equal(lint.status, 0, lint.stdout + lint.stderr);
  });

  test("the postinstall script closed the key for the account logged in now, without a logout", () => {
    // Only an account with a window session (loginwindow) gets it now; the others at their next login.
    const session = run('launchctl', ['print', `gui/${uid}`]);
    if (session.status !== 0) {
      console.log(`# no window session for uid ${uid} on this machine; the variable is set at login instead`);
      return;
    }
    const value = run('launchctl', ['getenv', SAFE_MODE_KEY_VARIABLE]);
    assert.equal(value.stdout.trim(), '1', `${SAFE_MODE_KEY_VARIABLE} in this account's session`);
    const loaded = run('launchctl', ['print', `gui/${uid}/${AGENT_LABEL}`]);
    assert.equal(loaded.status, 0, 'the agent is loaded in this account');
  });
});

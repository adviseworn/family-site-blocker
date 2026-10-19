// Helpers for the Firefox tests: find Firefox, start it with a throwaway profile, and drive it over
// Marionette, the automation protocol built into Firefox. No extra packages are needed.
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { packageFirefox } from '../../scripts/package-firefox.mjs';
import { EXTENSION_DIR } from './browser.mjs';

const KNOWN_LOCATIONS = [
  '/Applications/Firefox.app/Contents/MacOS/firefox',
  'C:\\Program Files\\Mozilla Firefox\\firefox.exe',
  '/usr/lib/firefox/firefox',
  '/usr/bin/firefox',
  '/usr/bin/firefox-esr',
];

/** The Firefox to test with: $FIREFOX, or the usual install location on macOS, Windows or Linux. */
export function findFirefox() {
  if (process.env.FIREFOX) return process.env.FIREFOX;
  return KNOWN_LOCATIONS.find((path) => existsSync(path)) ?? null;
}

class Marionette {
  #buffer = Buffer.alloc(0);
  #waiting = new Map();
  #next = 1;
  #greet;

  constructor(socket) {
    this.socket = socket;
    this.greeting = new Promise((resolve) => (this.#greet = resolve));
    socket.on('data', (chunk) => this.#read(chunk));
    // If Firefox goes away, fail whatever is still waiting for an answer instead of waiting forever.
    socket.on('close', () => {
      for (const waiter of this.#waiting.values()) waiter.reject(new Error('Firefox closed the automation connection'));
      this.#waiting.clear();
    });
  }

  // Messages are framed as "<byte length>:<JSON>". Replies are [1, id, error, result].
  #read(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    for (;;) {
      const colon = this.#buffer.indexOf(0x3a);
      if (colon < 0) return;
      const length = Number(this.#buffer.subarray(0, colon).toString());
      if (this.#buffer.length < colon + 1 + length) return;
      const message = JSON.parse(this.#buffer.subarray(colon + 1, colon + 1 + length).toString());
      this.#buffer = this.#buffer.subarray(colon + 1 + length);
      if (!Array.isArray(message)) {
        this.#greet(message);
        continue;
      }
      const [, id, error, result] = message;
      const waiter = this.#waiting.get(id);
      this.#waiting.delete(id);
      if (error) waiter?.reject(new Error(`${error.error}: ${error.message}`));
      else waiter?.resolve(result && typeof result === 'object' && !Array.isArray(result) && 'value' in result ? result.value : result);
    }
  }

  send(command, parameters = {}) {
    if (this.socket.destroyed) return Promise.reject(new Error(`Firefox's automation connection is closed (${command})`));
    const id = this.#next++;
    const json = JSON.stringify([0, id, command, parameters]);
    const answer = new Promise((resolve, reject) => this.#waiting.set(id, { resolve, reject }));
    this.socket.write(`${Buffer.byteLength(json)}:${json}`);
    return answer;
  }
}

async function connect(port) {
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    try {
      const socket = await new Promise((resolve, reject) => {
        const attempt = net.connect(port, '127.0.0.1');
        attempt.once('connect', () => resolve(attempt));
        attempt.once('error', reject);
      });
      const client = new Marionette(socket);
      await client.greeting;
      return client;
    } catch {
      await new Promise((done) => setTimeout(done, 250));
    }
  }
  throw new Error('Firefox did not start its automation port');
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Starts Firefox (headless) with every request sent to the stub internet. With { extension: true } the
 * extension is loaded as a temporary add-on, exactly like "Load Temporary Add-on…" in about:debugging:
 * the zip that npm run package:firefox makes (the file Mozilla signs), or with { packaged: false } the
 * extension folder itself, as the README's "Try it" steps load it. A throwaway profile is used, unless
 * { profile } names a folder to use (and keep) instead, so a later start can pick up where this one left off.
 * With { troubleshootMode: true } Firefox starts in Troubleshoot Mode (--safe-mode), as holding Option (⌥)
 * while it opens does on a Mac; the automation accepts the "Open Firefox in Troubleshoot Mode?" question.
 * { prefs } adds to or changes the settings the profile starts with.
 */
export async function launchFirefox(stub, { extension = true, extensionDir = EXTENSION_DIR, packaged = true, profile: keep, troubleshootMode = false, prefs: extraPrefs = {} } = {}) {
  const binary = findFirefox();
  const profile = keep ?? mkdtempSync(join(tmpdir(), 'family-site-blocker-firefox-'));
  const marionettePort = 20000 + Math.floor(Math.random() * 20000);
  const prefs = {
    'network.proxy.type': 1,
    'network.proxy.http': '127.0.0.1',
    'network.proxy.http_port': stub.port,
    'network.proxy.ssl': '127.0.0.1',
    'network.proxy.ssl_port': stub.port,
    'network.proxy.no_proxies_on': '',
    'network.proxy.allow_hijacking_localhost': true,
    'network.proxy.share_proxy_settings': false,
    'marionette.port': marionettePort,
    'dom.security.https_first': false,
    'dom.security.https_only_mode': false,
    // Big sites (bing.com, yahoo.com, youtube.com) are on Firefox's built-in HTTPS-only list; the stand-in
    // internet speaks plain http, so that list is switched off for the tests.
    'network.stricttransportsecurity.preloadlist': false,
    'browser.shell.checkDefaultBrowser': false,
    'browser.startup.page': 0,
    'browser.startup.homepage_override.mstone': 'ignore',
    'browser.aboutwelcome.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
    'app.update.disabledForTesting': true,
    'extensions.update.enabled': false,
    'network.captive-portal-service.enabled': false,
    'network.connectivity-service.enabled': false,
    'browser.safebrowsing.malware.enabled': false,
    'browser.safebrowsing.phishing.enabled': false,
    ...extraPrefs,
  };
  writeFileSync(
    join(profile, 'user.js'),
    Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`).join('\n'),
  );
  const headless = process.env.HEADFUL !== '1';
  const args = ['-no-remote', '-profile', profile, '-marionette', ...(headless ? ['-headless'] : []), ...(troubleshootMode ? ['--safe-mode'] : [])];
  const env = {
    ...process.env,
    LD_LIBRARY_PATH: dirname(binary),
    // Newer Firefox only lets automation read extension pages (like the block page) with this set.
    MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1',
    ...(headless ? { MOZ_HEADLESS: '1' } : {}),
  };
  const process_ = spawn(binary, args, { env, stdio: 'ignore' });

  const fx = await connect(marionettePort);
  const session = await fx.send('WebDriver:NewSession', {});
  const version = session.capabilities.browserVersion;

  let addonId = null;
  if (extension) {
    // Work from a copy, so Firefox never writes into ./extension.
    const copy = join(profile, 'extension-under-test');
    cpSync(extensionDir, copy, { recursive: true });
    const manifest = JSON.parse(readFileSync(join(copy, 'manifest.json'), 'utf8'));
    const minimum = manifest.browser_specific_settings?.gecko?.strict_min_version;
    if (minimum && parseFloat(version) < parseFloat(minimum)) {
      if (process.env.ALLOW_OLD_FIREFOX !== '1') {
        throw new Error(`Firefox ${version} is older than the add-on's minimum (${minimum}). Set ALLOW_OLD_FIREFOX=1 to test anyway.`);
      }
      manifest.browser_specific_settings.gecko.strict_min_version = '121.0';
      writeFileSync(join(copy, 'manifest.json'), JSON.stringify(manifest, null, 2));
    }
    const path = packaged ? packageFirefox({ extensionDir: copy, outDir: join(profile, 'package') }).zip : copy;
    addonId = await fx.send('Addon:Install', { path, temporary: true });
    await sleep(1000);
  }

  const currentUrl = () => fx.send('WebDriver:GetCurrentURL');
  const run = (script, ...args) => fx.send('WebDriver:ExecuteScript', { script, args });

  return {
    fx,
    version,
    addonId,
    run,
    currentUrl,
    /**
     * Runs a script inside Firefox itself (chrome context: Services, Cc/Ci, the browser window), for what no
     * page can see, such as the address bar. The script gets its arguments as `arguments` and must call
     * the last one, `done(result)`, when finished.
     */
    async inFirefox(script, ...args) {
      await fx.send('Marionette:SetContext', { value: 'chrome' });
      try {
        return await fx.send('WebDriver:ExecuteAsyncScript', { script, args });
      } finally {
        await fx.send('Marionette:SetContext', { value: 'content' });
      }
    },
    /** What Firefox granted the add-on: website access patterns and whether it runs in private windows. */
    async grants() {
      await fx.send('Marionette:SetContext', { value: 'chrome' });
      try {
        return await run(
          `const policy = WebExtensionPolicy.getByID(arguments[0]);
           return { origins: policy.allowedOrigins.patterns.map((p) => p.pattern), privateWindows: policy.privateBrowsingAllowed };`,
          addonId,
        );
      } finally {
        await fx.send('Marionette:SetContext', { value: 'content' });
      }
    },
    /** The background key of the manifest as Firefox read it, and the warnings and errors it reported. */
    async manifestReport() {
      await fx.send('Marionette:SetContext', { value: 'chrome' });
      try {
        return await run(
          `const { manifest, warnings, errors } = WebExtensionPolicy.getByID(arguments[0]).extension;
           return { background: manifest.background, warnings, errors };`,
          addonId,
        );
      } finally {
        await fx.send('Marionette:SetContext', { value: 'content' });
      }
    },
    /** Tabs that are open, with their addresses. */
    async tabs() {
      const result = [];
      for (const handle of await fx.send('WebDriver:GetWindowHandles')) {
        await fx.send('WebDriver:SwitchToWindow', { handle });
        result.push({ handle, url: await currentUrl() });
      }
      return result;
    },
    async newTab() {
      const { handle } = await fx.send('WebDriver:NewWindow', { type: 'tab' });
      await fx.send('WebDriver:SwitchToWindow', { handle });
      return handle;
    },
    async waitForUrl(test, ms = 8000) {
      const until = Date.now() + ms;
      let url = await currentUrl();
      while (!test(url) && Date.now() < until) {
        await sleep(150);
        url = await currentUrl();
      }
      return url;
    },
    /**
     * Opens an address in the current tab and reports where the person ended up: the add-on's "blocked page",
     * Firefox's own "blocked by Firefox" page (from the WebsiteFilter policy), "site loaded" or "other".
     */
    async visit(url) {
      let error = null;
      try {
        await fx.send('WebDriver:Navigate', { url });
      } catch (e) {
        error = e.message;
      }
      const finalUrl = await currentUrl();
      const text = await run('return document.body ? document.body.innerText : ""').catch(() => '');
      // Firefox's error pages keep the address the person asked for; the page itself says what happened.
      const documentUri = await run('return document.documentURI').catch(() => '');
      let outcome = 'other';
      if (/^moz-extension:\/\/[0-9a-f-]+\/blocked\.html$/.test(finalUrl)) outcome = 'blocked page';
      else if (String(documentUri).startsWith('about:neterror?e=blockedByPolicy')) outcome = 'blocked by Firefox';
      else if (text.includes('SITE LOADED')) outcome = 'site loaded';
      return { url, finalUrl, documentUri, text, error, outcome };
    },
    async close() {
      const running = process_.exitCode === null && process_.signalCode === null;
      const exited = new Promise((done) => (running ? process_.once('exit', done) : done()));
      await fx.send('Marionette:Quit', { flags: ['eForceQuit'] }).catch(() => {});
      fx.socket.destroy();
      // Let Firefox finish shutting down (it saves the profile then) before making sure it's gone.
      await Promise.race([exited, sleep(keep ? 30_000 : 3_000)]);
      process_.kill();
      await sleep(300);
      if (!keep) rmSync(profile, { recursive: true, force: true });
    },
  };
}

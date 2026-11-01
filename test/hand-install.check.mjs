// A one-off check of the path the suites don't cover: the signed add-on installed by hand in Firefox, as
// about:addons's "Install Add-on From File…" does (not temporarily, not under the lock), then the test case.
// Run with:  FIREFOX=/path/to/firefox SIGNED_XPI=path/to/signed.xpi node test/hand-install.check.mjs
import { resolve } from 'node:path';
import { startStubInternet } from './helpers/browser.mjs';
import { launchFirefox } from './helpers/firefox.mjs';

const XPI = resolve(process.env.SIGNED_XPI ?? '');
const ID = 'family-site-blocker@parental-controls.local';
const SITE = 'exampleadultsite.com';
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const out = {};

const stub = await startStubInternet();
const browser = await launchFirefox(stub, { extension: false });
out.firefox = browser.version;

const chrome = async (script, ...args) => {
  await browser.fx.send('Marionette:SetContext', { value: 'chrome' });
  try {
    return await browser.fx.send('WebDriver:ExecuteAsyncScript', {
      script: `
        const done = arguments[arguments.length - 1];
        const { AddonManager } = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
        const { ExtensionPermissions } = ChromeUtils.importESModule("resource://gre/modules/ExtensionPermissions.sys.mjs");
        (async () => { ${script} })().then(done, (error) => done({ error: String(error) }));`,
      args,
    });
  } finally {
    await browser.fx.send('Marionette:SetContext', { value: 'content' });
  }
};
const addonInfo = () =>
  chrome(
    `const a = await AddonManager.getAddonByID(arguments[0]);
     const p = WebExtensionPolicy.getByID(arguments[0]);
     return a && {
       version: a.version, active: a.isActive, temporary: a.temporarilyInstalled, signed: a.signedState === AddonManager.SIGNEDSTATE_SIGNED,
       origins: p ? p.allowedOrigins.patterns.map((x) => x.pattern) : null, privateWindows: p ? p.privateBrowsingAllowed : null,
       host: p ? p.mozExtensionHostname : null,
     };`,
    ID,
  );
const granted = () => chrome('return await ExtensionPermissions.get(arguments[0]);', ID);
const asyncInPage = (script, ...args) => browser.fx.send('WebDriver:ExecuteAsyncScript', { script, args });

try {
  // 1. Installed by hand, not temporarily.
  out.install = await browser.fx.send('Addon:Install', { path: XPI, temporary: false });
  let info = null;
  for (let i = 0; i < 80 && !(info = await addonInfo())?.active; i++) await sleep(250);
  out.addon = info;
  out.granted = await granted();
  await sleep(2000);
  out.tabsAfterInstall = await browser.tabs();
  await browser.newTab();

  // 2. The test case, as installed.
  stub.clear();
  out.visit = { ...(await browser.visit(`http://${SITE}/`)), reached: stub.reached(SITE) };
  stub.clear();
  out.visitHttps = { ...(await browser.visit(`https://${SITE}/`)), reached: stub.reached(SITE) };

  // 3. The settings page's board.
  const host = info?.host;
  if (host) {
    await browser.fx.send('WebDriver:Navigate', { url: `moz-extension://${host}/options.html` });
    let board = null;
    for (let i = 0; i < 50; i++) {
      board = await browser.run(`return {
        version: document.getElementById('version').textContent,
        summary: document.getElementById('summary').textContent,
        accessShown: !document.getElementById('access').hidden,
        privateStatus: document.getElementById('private-status').textContent,
        lockShown: !document.getElementById('lock').hidden,
        lockStatus: document.getElementById('lock-status').textContent,
        lockMark: document.getElementById('lock').className,
        checkNote: document.getElementById('check-note').textContent,
        attempts: document.getElementById('attempts-summary').textContent,
      }`);
      if (board.checkNote && board.privateStatus !== 'Checking…' && !board.attempts.startsWith('Loading')) break;
      await sleep(200);
    }
    out.board = board;

    // 4. Probes, as dynamic rules added from the settings page (which runs with the add-on's privileges): a
    //    plain block of a page load, and a redirect of one, to see which of the two Firefox applies as things stand.
    out.probeRules = await asyncInPage(`
      const done = arguments[arguments.length - 1];
      try {
        const api = window.wrappedJSObject.browser;
        api.declarativeNetRequest.updateDynamicRules({ removeRuleIds: [5000, 5001], addRules: [
          { id: 5000, priority: 1, action: { type: 'block' }, condition: { requestDomains: ['blockprobe.test'], resourceTypes: ['main_frame'] } },
          { id: 5001, priority: 1, action: { type: 'redirect', redirect: { extensionPath: '/blocked.html' } }, condition: { requestDomains: ['redirectprobe.test'], resourceTypes: ['main_frame'] } },
        ] }).then(() => done('added'), (e) => done('failed: ' + e.message));
      } catch (e) { done('threw: ' + e.message); }`);
    if (out.probeRules === 'added') {
      await sleep(500);
      stub.clear();
      out.blockProbe = { ...(await browser.visit('http://blockprobe.test/')), reached: stub.reached('blockprobe.test') };
      stub.clear();
      out.redirectProbe = { ...(await browser.visit('http://redirectprobe.test/')), reached: stub.reached('redirectprobe.test') };
    }

    // 5. Website access given, as about:addons → Permissions does; then the test case again.
    if (!(info.origins ?? []).includes('<all_urls>')) {
      out.grant = await chrome(
        `const ext = WebExtensionPolicy.getByID(arguments[0]).extension;
         await ExtensionPermissions.add(arguments[0], { permissions: [], origins: ['<all_urls>'] }, ext);
         return WebExtensionPolicy.getByID(arguments[0]).allowedOrigins.patterns.map((x) => x.pattern);`,
        ID,
      );
      await sleep(1000);
      stub.clear();
      out.visitAfterGrant = { ...(await browser.visit(`http://${SITE}/`)), reached: stub.reached(SITE) };
      if (out.probeRules === 'added') {
        stub.clear();
        out.redirectProbeAfterGrant = { ...(await browser.visit('http://redirectprobe.test/')), reached: stub.reached('redirectprobe.test') };
      }
      await browser.fx.send('WebDriver:Navigate', { url: `moz-extension://${host}/options.html` });
      await sleep(1500);
      out.boardAfterGrant = await browser.run(`return { accessShown: !document.getElementById('access').hidden, attempts: document.getElementById('attempts-summary').textContent }`);
    }
  }
} catch (error) {
  out.error = String(error?.stack ?? error);
} finally {
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
  await stub.close();
}

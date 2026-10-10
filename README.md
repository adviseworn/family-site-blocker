# Family Site Blocker

A browser extension for Chrome, Edge, Brave and Firefox that blocks websites on a list. It starts with `exampleadultsite.com` (the test case) and 19 large adult sites, and you can add your own.

**Test case:** navigate to `exampleadultsite.com`. **Expected:** the website is blocked. With the extension loaded, you land on a "This site is blocked" page and nothing is fetched from the site.

## Try it

You need Chrome, Edge, Brave or Firefox on a computer. Phones, tablets, Safari and browsers built into other apps can't load this extension. First, unzip `family-site-blocker.zip`.

### Chrome, Edge or Brave

1. Open the extensions page. Click the address bar at the top of the browser window, type `chrome://extensions` and press Enter (in Edge, `edge://extensions`). Or open the browser menu (**⋮** in Chrome, **⋯** in Edge), choose **Extensions**, then **Manage Extensions** if a submenu opens. Type the address rather than clicking it as a link: browsers don't let links open this page.
2. Turn on the **Developer mode** switch (top right in Chrome). A **Load unpacked** button appears.
3. Click **Load unpacked** and choose the `extension` folder inside the unzipped `family-site-blocker` folder. The extension's settings page opens.
4. In a normal (not Incognito) window, type `exampleadultsite.com` in the address bar and press Enter. You should see "This site is blocked".
5. Click **Details** under Family Site Blocker and turn on **Allow in Incognito**. Browsers switch extensions off in private windows unless you do this, and the settings page tells you when it is still off.

If `chrome://extensions` comes up blank, you're probably not in Chrome, Edge or Brave. Firefox has its own steps below.

### Firefox

1. Click the address bar, type `about:debugging#/runtime/this-firefox` and press Enter. Or open the menu (**☰**), choose **Extensions and Themes**, click the gear (**⚙**) and choose **Debug Add-ons**.
2. Click **Load Temporary Add-on…** and choose the `manifest.json` file inside the `extension` folder of the unzipped `family-site-blocker` folder. The extension's settings page opens.
3. If the settings page shows a **Website access** section, click **Allow access** and confirm. Without that access, sites on the list still open.
4. In a normal (not private) window, type `exampleadultsite.com` in the address bar and press Enter. You should see "This site is blocked". If Firefox is set to never remember history, every window is private, so do step 5 first.
5. For private windows, type `about:addons` in the address bar, choose Family Site Blocker and set **Run in Private Windows** to **Allow**. Firefox leaves this off for new add-ons, and the settings page tells you when it is still off.

Firefox removes temporary add-ons when it quits, and the sites you added on the settings page go with them. After restarting Firefox, load it again, re-enter your sites and check the private windows setting. To install it permanently, it has to be signed by Mozilla first. Signing is free on addons.mozilla.org, the add-on can stay unlisted, and its manifest already declares that it collects no data, which signing requires.

### Settings page

To open it later, click the puzzle-piece **Extensions** button in the toolbar and choose **Family Site Blocker** (in Chrome you can pin it there to keep its icon in view). In Chrome, Edge and Brave it also checks six addresses against the browser's own rule matcher and shows Passed or Failed for each. Firefox doesn't let extensions run that check, so use the **Open exampleadultsite.com** button there instead.

## What it blocks

- The listed domain and every subdomain (`www.`, `m.`, `cdn.`…), on any scheme and port, however the address is written (upper case, trailing dot, `user:pw@`, full-width letters).
- The same site reached indirectly: a link, a popup, a redirect, a form post, a frame inside another page.
- Anything an allowed page tries to load from the site: images, scripts, styles, frames, `fetch`, XHR, WebSockets. These fail silently.
- Lookalikes are left alone: `notexampleadultsite.com`, `exampleadultsite.com.example.org`, `exampleadultsite.co`.

It blocks by domain. It can't block one page of a site, and it doesn't read page content, so an adult site that isn't on the list isn't blocked.

## Adding sites

- **Your blocked sites** on the settings page: one site per line, saved straight away. Pasted addresses are cleaned up (`https://www.Example.com/a?b` becomes `example.com`) and hosts-file lines (`0.0.0.0 example.com`) work too.
- **The built-in list** lives in `blocklists/*.txt`. For wider coverage, save a community list (hosts-file format or one domain per line) as another `.txt` file there, run `npm run build`, then reload the extension. Large lists are fine in Chromium: 400,000 domains in the built-in list and 300,000 pasted into the settings page both worked in testing. The settings page can't remove built-in sites.

## Tests

```
npm test                  # fast checks, no install needed
npm install               # once, for the Chromium tests
npx playwright install chromium    # once, if Playwright has no browser yet
npm run test:browser      # 39 tests in a real Chromium
npm run test:firefox      # 18 tests in the Firefox installed on this computer
```

`npm run test:browser` loads the extension the way "Load unpacked" does and drives it like a person would. `npm run test:firefox` does the same in Firefox, loading it the way "Load Temporary Add-on…" does. It finds Firefox in its usual place on macOS, Windows or Linux, or uses the one in `FIREFOX`, and is skipped if there is none.

No real website is contacted: every request goes to a small local server instead, so a request that never reaches that server was stopped by the browser. In both suites the first group is the test case itself, with a control that shows the site loading when the extension isn't installed. Set `HEADFUL=1` to watch the browser, or `EXTENSION_DIR=/path/to/build` to test a different build.

## Limits

- It is a browser extension. Safari, other browser profiles and apps are not covered. In Firefox it stays installed only until Firefox quits, unless Mozilla signs it.
- Anyone who can open the extensions page can turn it off or remove it, and the settings page has no PIN. On a child's device, combine it with account or system controls. An administrator can also force-install the extension and turn off private windows with managed policies: `ExtensionInstallForcelist` and `IncognitoModeAvailability` in Chrome and Edge, `ExtensionSettings` and `DisablePrivateBrowsing` in Firefox. That needs the extension packaged or published (signed, for Firefox).
- Reaching a site by its IP address, through a proxy or VPN, or through a translation or cache service is not covered unless that address is on the list too.

## Files

| Path | What it is |
| --- | --- |
| `extension/` | The extension. Load this folder. |
| `extension/rules/adult.json` | The built-in rules, generated from `blocklists/`. Don't edit by hand. |
| `extension/lib/` | Domain cleanup and rule building, shared with the build script. |
| `blocklists/` | The built-in list, as plain text. |
| `scripts/build-rules.mjs` | `npm run build`: turns `blocklists/` into `adult.json`. |
| `test/` | Fast checks (`blocker.test.mjs`) and the real-browser tests (`browser.e2e.mjs` for Chromium, `firefox.e2e.mjs` for Firefox). |

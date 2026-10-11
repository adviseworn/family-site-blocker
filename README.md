# Family Site Blocker

A browser extension for Chrome, Edge, Brave and Firefox that blocks websites on a list. It starts with `exampleadultsite.com` (the test case) and 19 large adult sites, and you can add your own.

**Test case:** navigate to `exampleadultsite.com`. **Expected:** the website is blocked. With the extension loaded, you land on a "This site is blocked" page and nothing is fetched from the site.

## Try it

You need Chrome, Edge, Brave or Firefox on a computer. Phones, tablets, Safari and browsers built into other apps can't load this extension.

First, get the files onto your computer. On this repository's GitHub page, click **Code**, then **Download ZIP**, and unzip the download. If someone sent you `family-site-blocker.zip`, unzip that instead.

### Chrome, Edge or Brave

1. Open the extensions page. Click the address bar at the top of the browser window, type `chrome://extensions` and press Enter (in Edge, `edge://extensions`). Or open the browser menu (**⋮** in Chrome, **⋯** in Edge), choose **Extensions**, then **Manage Extensions** if a submenu opens. Type the address rather than clicking it as a link: browsers don't let links open this page.
2. Turn on the **Developer mode** switch (top right in Chrome). A **Load unpacked** button appears.
3. Click **Load unpacked** and choose the `extension` folder inside the unzipped folder. The extension's settings page opens.
4. In a normal (not Incognito) window, type `exampleadultsite.com` in the address bar and press Enter. You should see "This site is blocked".
5. Click **Details** under Family Site Blocker and turn on **Allow in Incognito**. Browsers switch extensions off in private windows unless you do this, and the settings page tells you when it is still off.

If `chrome://extensions` comes up blank, you're probably not in Chrome, Edge or Brave. Firefox has its own steps below.

### Firefox

Firefox only keeps add-ons that Mozilla has signed. You can try this one straight away, but it stays loaded only until Firefox quits. To keep it after a restart, have Mozilla sign it first (see "Keep it installed" below).

**Try it (until Firefox quits)**

1. Click the address bar, type `about:debugging#/runtime/this-firefox` and press Enter. Or open the menu (**☰**), choose **Extensions and Themes**, click the gear (**⚙**) and choose **Debug Add-ons**.
2. Click **Load Temporary Add-on…** and choose the `manifest.json` file inside the `extension` folder of the unzipped folder. The extension's settings page opens.
3. If the settings page shows a **Website access** section, click **Allow access** and confirm. Without that access, sites on the list still open.
4. In a normal (not private) window, type `exampleadultsite.com` in the address bar and press Enter. You should see "This site is blocked". If Firefox is set to never remember history, every window is private, so do step 5 first.
5. For private windows, type `about:addons` in the address bar, choose Family Site Blocker and set **Run in Private Windows** to **Allow**. Firefox leaves this off for new add-ons, and the settings page tells you when it is still off.

When Firefox quits, it removes the add-on and the sites you added on the settings page.

**Keep it installed after Firefox quits**

Signing is free, and the add-on can stay unlisted, so it isn't published on Mozilla's site. GitHub can do steps 1 to 6 for you, or you can do them by hand.

To let GitHub do it, first save an API key from Mozilla in this repository, once. Signed in at [addons.mozilla.org/developers/addon/api/key](https://addons.mozilla.org/developers/addon/api/key/), generate credentials. Then on GitHub, open **Settings → Secrets and variables → Actions** and add two repository secrets: `AMO_JWT_ISSUER` with the "JWT issuer", and `AMO_JWT_SECRET` with the "JWT secret". For each version, open the **Actions** tab, choose **Sign with Mozilla** and click **Run workflow**. It uploads the add-on, waits for Mozilla to sign it, checks that the signed file holds exactly what was uploaded, and publishes a release named after the version with the signed `.xpi` and the Mac zip from step 6. If Mozilla already has that version, for example because you uploaded it by hand, it downloads the signed file instead. Download them from the repository's **Releases** page and carry on from step 7.

By hand:

1. Get the upload file: run `npm run package:firefox`, which writes `dist/family-site-blocker-firefox.zip`, or use the `family-site-blocker-firefox.zip` you were sent. Don't compress the `extension` folder yourself. Mozilla needs `manifest.json` at the top of the zip, and Finder's **Compress** puts it inside a folder. The zip's copy of `manifest.json` also leaves out the `service_worker` line, which only Chrome, Edge and Brave use.
2. Sign in at [addons.mozilla.org/developers](https://addons.mozilla.org/developers/) with a Mozilla account and choose **Submit a New Add-on**.
3. When asked how to distribute it, choose **On your own**, then upload the zip. Mozilla runs the same check as `.github/workflows/firefox-package.yml`, which finds no errors or warnings in this zip.
4. When asked whether you need to submit source code, choose **No**: the add-on's code isn't minified or compiled.
5. Submit the version. Mozilla signs it automatically. When it's ready, download the signed `.xpi` file from the version's page. Mozilla names it with a code plus the version number, like `a138dee9ad3f4f03aa63-1.1.1.xpi`, and Finder shows it with a blank document icon.
6. On a Mac, give it a clear name and the add-on's gate icon. Run `npm run package:signed --` followed by the path to the `.xpi`, for example `npm run package:signed -- ~/Downloads/a138dee9ad3f4f03aa63-1.1.1.xpi` (dragging the file into Terminal types its path). It checks that the file is Family Site Blocker, signed by Mozilla, and writes `dist/family-site-blocker-1.1.1.zip`. Double-click that zip in Finder to get `family-site-blocker-1.1.1.xpi` with the gate icon. It's the same signed file, so it installs the same way. To give it to another Mac, send the zip: the `.xpi` on its own arrives without the icon.

   Without Node, you can do this by hand. Rename the file, then open `extension/icons/icon128.png` in Preview and choose **Edit → Select All**, then **Edit → Copy**. Select the `.xpi`, choose **File → Get Info**, click the small icon at the top of the window and choose **Edit → Paste**. Neither the name nor the icon affects Mozilla's signature, and Firefox shows the add-on as Family Site Blocker either way.
7. In Firefox, remove the temporary copy if it's still loaded (on `about:debugging#/runtime/this-firefox`). Then open `about:addons`, click the gear (**⚙**), choose **Install Add-on From File…**, pick the `.xpi` and click **Add**. Tick **Allow this extension to run in Private Windows** if Firefox offers it.

   Double-clicking the `.xpi` in Finder won't work at first: macOS doesn't link `.xpi` files to Firefox, so it says no application is set to open it. To change that, select the file, choose **File → Get Info**, set **Open with** to Firefox and click **Change All…**. If Firefox isn't listed, choose **Other…**, set **Enable** to **All Applications** and pick Firefox. From then on, double-clicking a `.xpi` opens Firefox, which asks whether to add it.
8. Quit Firefox, open it again and visit `exampleadultsite.com`. It's still blocked, and sites you add on the settings page now stay too.

For a later version, raise `version` in `extension/manifest.json`, then run **Sign with Mozilla** again, or run `npm run package:firefox`, upload the new zip on the same add-on's page and carry on from step 5.

**Lock it, so nobody can switch it off (Firefox on a Mac)**

On its own, the add-on can be switched off or removed in the Add-ons Manager by anyone using Firefox. The Firefox lock stops that. Firefox installs the add-on itself and gives no way to switch it off, remove it or take away its access to websites. The lock also turns off private windows (add-ons don't run there unless someone allows it), Troubleshoot Mode, `about:config` and Refresh Firefox, which could otherwise get round it. It applies to every account on the Mac, yours included.

The lock works alongside another blocker that sets Firefox's settings too, such as Plucky. Both blockers' settings stay in force (**Limits** below has the one exception).

You need the signed `.xpi` and an administrator account. The person it's for should have a Standard account (**System Settings → Users & Groups**), so they can't remove the lock.

1. Put the signed add-on where Firefox looks for it. In Finder, choose **Go → Go to Folder…**, type `/Users/Shared` and press Return. Make a folder there named `Family Site Blocker`, copy the signed `.xpi` into it and rename the copy `family-site-blocker.xpi`. Other accounts can read that folder but not change it.
2. Double-click `mac/family-site-blocker-firefox.mobileconfig`. macOS says the profile was downloaded. That doesn't install it yet.
3. Open **System Settings → General → Device Management**. If **Family Site Blocker for Firefox** is already listed as installed from an earlier copy, select it, click the minus button (**−**) and enter your password, so the new copy replaces it. Then double-click the downloaded **Family Site Blocker for Firefox** and click **Install…**. macOS asks for the name and password of an administrator account. If your own account is one (**Users & Groups** shows "Admin" under your name), that's your login password. Otherwise, someone with an administrator account can type theirs here.
4. Quit Firefox (**Firefox → Quit Firefox**, or ⌘Q; closing its windows isn't enough) and open it again. Firefox only reads the lock when it starts, so until then the add-on can still be switched off. To check that the lock is on, type `about:policies` in the address bar. The **Active** tab lists `Extensions`, with `family-site-blocker@parental-controls.local` under **Locked**, and `DisablePrivateBrowsing`. Settings from other programs are listed there too: Plucky's include `ExtensionSettings`, with its own add-ons.
5. Open the Add-ons Manager. Family Site Blocker has no on/off switch any more, and its **⋯** menu says **Can't Be Removed**. If it had been switched off before, Firefox normally switches it back on when the lock installs it. If it's still off (for example because a different version had been installed by hand), it shows a switch to turn it on. Turn it on once, and the switch disappears for good.

Firefox installs the add-on from that folder once in each Firefox profile, so it doesn't pick up a newer file there by itself. For a new version, install the new signed `.xpi` in Firefox as in step 7 above, in each account that uses Firefox. The lock lets it update and stays on. Also put the new file in the folder as `family-site-blocker.xpi`, for Firefox profiles made later. To take the lock off, select the profile in **Device Management**, click the minus button (**−**) and enter your password.

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
npm run test:firefox      # 22 tests in the Firefox installed on this computer
```

`npm run test:browser` loads the extension the way "Load unpacked" does and drives it like a person would. `npm run test:firefox` does the same in Firefox. It builds the zip that `npm run package:firefox` makes, loads it the way "Load Temporary Add-on…" does, and then checks that the `extension` folder itself loads too. It finds Firefox in its usual place on macOS, Windows or Linux, or uses the one in `FIREFOX`, and is skipped if there is none.

On GitHub, every push runs all three suites on a GitHub-hosted Mac (`.github/workflows/macos.yml`). The run lists the macOS, Chromium and Firefox versions and each suite's totals, and fails if any test was skipped.

The Firefox lock has its own tests, which need a signed `.xpi`: `SIGNED_XPI=path/to/signed.xpi npm run test:firefox-lock`. They put the lock in force, check that Firefox installs the add-on and won't let it be switched off, and take the lock away again. With `OTHER_XPI` set to another program's signed add-on (GitHub uses LeechBlock NG, a site blocker), they also put the lock next to another blocker's settings, made like Plucky's, and check that both blockers stay installed and locked. With `OLDER_XPI` set to an earlier signed version of this add-on, they check what happens when that version was installed by hand and switched off before the lock, and that a newer version still installs over a locked one. On a Mac they only run on GitHub (**Firefox lock check** in the Actions tab), because the lock covers every account on the computer.

No real website is contacted: every request goes to a small local server instead, so a request that never reaches that server was stopped by the browser. In both suites the first group is the test case itself, with a control that shows the site loading when the extension isn't installed. Set `HEADFUL=1` to watch the browser, or `EXTENSION_DIR=/path/to/build` to test a different build.

## Limits

- It is a browser extension. Safari, other browser profiles and apps are not covered. In Firefox it stays installed only until Firefox quits, unless Mozilla signs it.
- Without a lock, anyone who can open the extensions page can turn it off or remove it, and the settings page has no PIN. Firefox on a Mac has the lock above. In Chrome and Edge, an administrator can force-install the extension with the `ExtensionInstallForcelist` policy and turn off Incognito with `IncognitoModeAvailability`, which needs the extension packaged and published. The lock only covers Firefox, so on a child's account, keep other browsers out with account or system controls.
- Sites added on the settings page are kept in the Firefox profile, so deleting the profile folder loses them (the add-on comes back by itself under the lock). For sites that must stay blocked whatever happens, add them to the built-in list.
- The lock installs the add-on once in each Firefox profile. If someone deletes the add-on's file from inside their Firefox profile folder while Firefox is closed, Firefox doesn't put it back: it's missing from the Add-ons Manager until you install it again from the folder.
- Firefox takes each of its settings from one place. The lock leaves out the one other blockers use for their own add-ons (`ExtensionSettings`), so theirs keep working, and its other settings are the same as Plucky's. If another program sets `Preferences` differently, Firefox uses the lock's (which keeps add-ons' blocking switched on) instead of that program's.
- Reaching a site by its IP address, through a proxy or VPN, or through a translation or cache service is not covered unless that address is on the list too.

## Files

| Path | What it is |
| --- | --- |
| `extension/` | The extension. Load this folder. |
| `extension/rules/adult.json` | The built-in rules, generated from `blocklists/`. Don't edit by hand. |
| `extension/lib/` | Domain cleanup and rule building, shared with the build script. |
| `blocklists/` | The built-in list, as plain text. |
| `scripts/build-rules.mjs` | `npm run build`: turns `blocklists/` into `adult.json`. |
| `scripts/package-firefox.mjs` | `npm run package:firefox`: makes the zip to upload to Mozilla, with Firefox's copy of `manifest.json`. |
| `scripts/package-signed.mjs` | `npm run package:signed`: puts the signed `.xpi` from Mozilla in a zip that gives it a clear name and the gate icon in Finder. |
| `assets/finder-icon.icns` | The gate icon for Finder. `npm run icons` makes it along with the extension's icons. |
| `test/` | Fast checks (`*.test.mjs`) and the real-browser tests (`browser.e2e.mjs` for Chromium, `firefox.e2e.mjs` for Firefox, `firefox-lock.e2e.mjs` for the Firefox lock). |
| `mac/family-site-blocker-firefox.mobileconfig` | The Firefox lock for a Mac, as a configuration profile. `npm run firefox-lock` makes it from `scripts/firefox-lock.mjs`. |
| `.github/workflows/firefox-lock.yml` | **Firefox lock check**: tests the lock with the latest signed release on a GitHub-hosted Mac, on its own and next to another blocker's settings. It fetches version 1.1.1 from Mozilla with the API key that **Sign with Mozilla** uses. Started by hand from the Actions tab. |
| `.github/workflows/macos.yml` | Runs all the tests on a Mac at GitHub after every push. |
| `.github/workflows/firefox-package.yml` | Builds the Firefox zip and checks it with Mozilla's add-on linter after every push. |
| `.github/workflows/sign-firefox.yml` | **Sign with Mozilla**: gets the add-on signed and publishes the signed files as a release. Started by hand from the Actions tab. |
| `scripts/check-signed.mjs` | Checks that a signed `.xpi` holds exactly the files that were uploaded, plus Mozilla's signature. |
| `scripts/amo-signed.mjs` | Downloads a version Mozilla has already signed, for **Sign with Mozilla**. Tested against a stand-in for Mozilla's API (`test/amo.test.mjs`). |

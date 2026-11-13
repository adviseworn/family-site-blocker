# Family Site Blocker for Android

A small web browser for Android phones with the Family Site Blocker add-on built in. On a phone, no browser
can keep an add-on switched on: Firefox for Android has no enterprise policies, Chrome runs no add-ons, Edge
runs only Microsoft's list. So the add-on gets its own browser. The add-on is part of the app's package and has
no off switch. The app also has its own lock (see "The lock" below), so it holds itself on without Family Link
or anyone else's help.

## What it is made of

- Mozilla's [GeckoView](https://mozilla.github.io/geckoview/) engine and
  [Android Components](https://github.com/mozilla-firefox/firefox/tree/main/mobile/android/android-components):
  the same engine and building blocks as Firefox for Android, pinned to one Firefox release
  (`android-components` in `gradle/libs.versions.toml`, 159.0.1 at the time of writing).
- The add-on from `../extension`, copied into the APK's assets at build time by the `copyExtension` task with
  Firefox's manifest (the `background.service_worker` line Chrome needs is left out, as
  `scripts/package-firefox.mjs` does). Gecko installs it as a built-in extension from
  `resource://android/assets/extensions/family-site-blocker/`; built-in extensions need no Mozilla signature
  and never show up in an add-on manager.
- [uBlock Origin](https://github.com/gorhill/uBlock), which blocks the advertisements, built in the same way
  beside the add-on and left as Mozilla's add-on site hands it out (see "Ad blocking" below).
- The app's own code (`app/src/main/java`): one activity, the browser screen (toolbar, page, menu), a tabs grid,
  downloads, prompts, site permissions, find in page, the long-press menu and the default-browser request.

Nothing in the app can switch the add-on off: no about:config, no add-on installs from web pages, no remote
debugging, no private tabs (where add-ons do not run), no add-on manager. The menu's Settings, Every try and
Is it working? items open the add-on's own pages. uBlock Origin has no off switch either, and no settings.

## The lock

The app can hold itself on, with nothing outside it (no Family Link, no second person holding a key). The
menu's Lock page (`lock/LockFragment`) asks for three things the phone grants and a wait:

- an **accessibility service** (`lock/LockAccessibilityService`), the lock's watch, which Android tells which
  window has come to the front and when something on it changes. While the lock is on it turns three things
  away. Another browser (every app that takes web links in general, found at runtime by `lock/Browsers`) is
  covered by a lock screen (`lock/LockScreenActivity`) that offers this browser and the home screen. The
  lock screen hides a browser that fills the screen. A window of one that it does not hide gets a cover of
  the watch's own where it lies, for as long as it is there: in the other half when two apps are side by
  side, in a bubble (from Android 17 the home screen's menu opens any app as one), in a free window on a
  second screen, or floating over the other apps. Each look goes through the windows on every screen for
  that (`Guard.showing`), and Home follows when the lock screen has not hidden the window
  (`Guard.againstWhatShows`). A cover leaves the navigation bar free (`Guard.coverArea`). Android lists a
  window, with where it lies, only when its opening has come to rest, and a bubble's page was on show for
  that long on the test phone. So a plain cover goes over the whole screen at a window's first sign: its
  own word that it is there, Android's record of app use naming it, or a look that finds it in front. The
  watch draws that cover before it does anything else, and the list then takes it to where the window lies
  or takes it off because the lock screen has hidden the window (`Guard.unlistedCoverStays`). The watch
  cannot close a window that an app floats over the others: its cover stays until the app takes the window
  away. From Android 12 on such a window does not show at all while the lock is on (see the switch that lets
  another browser display over other apps, below). A screen of Settings or the installer that names Family
  Site Blocker alongside a way to undo the lock (uninstall, force stop, clear storage, the accessibility or
  administrator switch, its usage access) is closed and then covered, so that Settings itself opens as usual
  the next time. And Security & privacy is closed (see below). The watch reads the words on a screen only in
  Settings, the installer and the permission controller, and only to tell the screens named here: one with
  the app's name and one of those actions, Security & privacy and the screens that lead round the lock by
  their titles, and the switch that lets another browser display over other apps by that browser's name. Of
  a tap it reads the row tapped, in those apps, in Settings' search and on the home screen, to tell one that
  opens Security & privacy. Of every other window it asks only which app it belongs to and where it lies;
- the **device administrator** role (`lock/LockAdminReceiver`, no policies), which makes Android send an
  uninstall through a screen the watch then turns away. Android lists no operations for it, and it keeps an
  administrator's own description off that screen (the text has no height in Settings' layout; it shows
  only in the list of device admin apps). So the Lock page says what the role is for, and the same sentence
  goes along as the explanation Android does show on the screen that activates it;
- **usage access**, on Android 14 and later (`lock/Front`): Android's record of which screen was brought to
  the front last, which is how the watch knows of a screen Android hides from it. Android 16 and later call
  it "App usage data"; the Lock page and the record use the phone's name for it (`Words.usageAccessName`),
  and the watch knows its screen by both.

The rules the watch goes by are in `lock/Guard`. They need no phone, so `GuardTest` pins them on the words of
the screens themselves.

**A screen is not always heard from.** Settings' newer pages (the list of all apps, each app's App info, the
pages under Special app access: one window, `SpaActivity`) tell a service of their changes only if it was
running when the page was made. A page that was open while the watch started again, as it does when the app
is updated, then goes from page to page without a word: seen on the Android 15 test phone, where the app's
own App info opened unread. So while a guarded app's screen is in front, the watch looks at it steadily,
whatever it says (`lookSteadily`, `Guard.steadyLookIn`: four times a second, a phone whose looks are slow less
often). The same pages show two at once while one changes into the other, the app's row in the list beside
another app's Force stop, and a phone that draws the change shows them together for longer than a test phone
does. The rules tell the app's row from its own page (`Guard.names`): the watch notes which texts stand in
a row of those lists, something that can be tapped and is drawn by Compose (`Guard.isRow`), and a name there
leads to a page and is not the page's heading. Settings' older pages are each a window of their own, and
what can be tapped there is not always a row: the heading of the page that clears an app's storage leads to
its App info. The rules also tell the word "Disabled" under an app in the list from a Disable button, and
the browser a switch is for from one that the list only names (`Guard.letsDisplayOver`).

**The page that clears the app's storage is told by what it lists.** Settings, Storage, Apps leads to it
without passing App info, and Android 17 keeps its two buttons from the watch, so "Clear storage" is not
there to go by. A screen that names the app and has both "App size" and "User data" on it is that page
(`Guard.storagePage`). Android greys Clear storage out while the app is a device administrator, and not
before.

**Security & privacy stays closed while the lock is on.** Android's Safety Center shows an alert, "Review app
with full device access", for every accessibility service that is not declared a tool for people with
disabilities, and the alert's Remove access button switches the service off at one tap, with no question
asked. Where the alert is drawn depends on the Android:

- Android 14, 15 and the first Android 16 draw the Safety Center in the permission controller and hide it
  from such a service: its screens guard themselves against taps passed through an overlay, and Android
  treats what they show as sensitive, so the watch gets no event from them and reads nothing on them. There
  the watch goes by the record of app use and closes the Safety Center by its class, whichever of its pages
  is opened (`Guard.isSecurityAndPrivacy`).
- Later releases of Android 16 and Android 17 draw it in Settings itself (`safetycenter/ui` in AOSP's
  Settings) and show the watch what is on it. Opened from Settings' first page or from its search it is a
  plain `SubSettings`, so the watch tells it by its title (`Guard.isSecurityAndPrivacyScreen`): "Security &
  privacy" and "Privacy controls", the two pages that show the alert, are closed on sight, before the alert
  has been drawn. A tap on what opens one of them (the row in Settings, a result of its search or of the
  home screen's) puts the shield up at once, so that the page comes up under it and is never there to tap.
  The other pages under Security & privacy can still be found through Settings' search. One of them, More
  security & privacy, has a row "Accessibility usage" that opens the permission controller's list of the
  apps with full access, Remove access and all: that list is closed by its class, and a tap on the row puts
  the shield up too. Opened another way (a notification, quick settings, another app) Security & privacy
  has a class of its own and is closed by that. Should the alert ever be on a screen that was not told by
  its title, the screen is turned away for what the alert says.

A plain shield is held over the screen for the moment the closing takes. A screen is closed with Back and
then covered by the lock screen, so that Settings opens as usual the next time. The record of app use names
a screen as soon as Android starts to bring it forward, when the focus is still on the window it was
opened from; Back sent then would close that one and leave the hidden screen on top of Settings. So for a
screen told by the record, Back waits until the focus has passed to the screen's own window
(`Guard.waitsForItsWindow`), and the lock screen waits until the record shows that the screen has closed
(`Guard.coverFollows`). The titles are English, like the other words the watch goes by. Declaring the
service a tool for people with disabilities (`isAccessibilityTool`) would make the alert go away, but it
would not be true, and Google Play checks it.

Android 17 keeps more than Security & privacy from such a service: the rows of the list of device admin
apps, and the buttons of the administrator's own screen. The list is left open, since nothing on it can be
told; the administrator's screen is closed as it opens, told by the app's sentence or by Android's "This
admin app is active".

The accessibility shortcut (both volume keys, or the accessibility button) switches a service off as well
once it has been set to it. The Lock page then shows Not yet, and says how to clear the shortcut.

**Screens that lead round the lock stay closed too** (`Guard.wayRound`). None of them undoes the lock; each
opens a way past it:

- **Developer options**, where USB debugging is switched on. Through it a computer can stop the app
  (`adb shell am force-stop`), and Android then switches the watch off.
- **Users**, where a guest or another user is added and switched to. The watch and the administrator belong
  to the user who set them up, so the lock is not there for anyone else.
- **The setting up of a Private space.** The watch is told which app comes to the front in there, but Android
  shows an app only the apps of its own part of the phone, so a browser installed only in a Private space is
  not among those the lock knows. Browsers known by the name of their package are turned away there all the
  same (`Browsers.knownByName`); one that is not on that list is out of reach. Only the setting up is closed
  (`PrivateSpaceSetupActivity`). The screen that asks for the phone's PIN before it is left alone: closed, it
  stayed on top of Settings with the PIN's answer still to come, and Settings then opened to the lock screen
  once more. The page of a Private space that is there already is left alone too: it is where the space is
  deleted.
- **The setting up of a work profile**, which is such a part of the phone too, and which an app from the
  store can ask Android for. It is an app of its own (`Browsers.setUpOfAWorkProfile`) with nothing of
  Settings under it, so it is covered whenever it comes to the front, as another browser is, and not closed.
- **The switch that lets another browser display over other apps** (`Guard.letsDisplayOver`). An app with
  that leave floats a window over every other app, and one it makes take no touches is a window Android
  never lists, so it gets no cover. The page of the switch is closed for a browser that does not have the
  leave, and left open for one that has, which is where it is taken away. The page is on show for the
  moment it takes the watch to read it, and on the test phone a fast tap got the leave given in two tries
  of four. So the watch does not rest on the page: for as long as any other browser holds the leave, it has
  Android keep every app's floating windows off the screens (`keepFloatingWindowsOff`: a window of the
  watch's own with `Window.setHideOverlayWindows`, Android 12 and later, told of a change by
  `AppOpsManager.startWatchingMode`). The Lock page names the browser, and says how to take the leave away.

A screen with a class of its own is told by Android's record of app use and closed once its window has the
focus, like Security & privacy; a page that Settings draws under a class that tells nothing is told by its
title. The watch does not act on Android's word that such a screen has come to the front: that word can come
before the screen takes keys, and the Back sent then went to whatever was in front before, seen on a slow test
phone. A way that is open already stays reachable, so that it can be closed: Developer options while USB or
wireless debugging is on, and Users while the phone lets its user be switched. The Lock page says so for as
long as either lasts. On Android itself, Force stop, Clear storage and the Stop button of "Active apps" are
greyed out or missing for an app that is a device administrator, and Uninstall leads to the administrator's
screen, which the watch closes: tried on Android 17.

**The lock does not shut out its own setting up.** While it still lacks something, the screen that gives it
stays open: the screen that makes the app a device administrator while it is not one, its usage access while
it has none, the accessibility service's own screen while the shortcut is set to it, and, on Android 13 and
later, the app's App info while the administrator or usage access is missing. Android holds those settings
back from an app installed from a file until "Allow restricted settings" is tapped in App info's menu, and a
lock that closed App info then could never be completed. Force stop is on App info too, so for that long its
question is turned away, whichever app it is about. None of these states can be brought about with the lock
whole: each screen that would take something away is one the watch closes.

With the lock on, the screen where such a thing is given closes as soon as it is given, because there it could
be taken away again. That holds for the accessibility service's own screen the moment the watch comes on, and
for the app's usage access. Nobody has tried to undo anything then, so the app's Lock page comes up in the
screen's place, with the thing marked Done, and the record gets no line (`Guard.givenThere`). The screen gets
one Back for it: read once more while the Lock page is on its way, as a slow phone does, it gets no second one,
which would land on the page and close that. Opened again, the screen is turned away like any other.

The usage access screen needs a rule of its own on Android 17. From the moment its switch has been turned,
for any app and either way, Settings shows that screen to accessibility tools only, for as long as it stays
open: the watch is shown a window with the title "App usage data" and nothing in it. The switch is still
there to tap, and such a screen can be left among the recent apps from before the lock was on and brought
back later. So the watch remembers which windows with that title it has read, and whose page each was, and
a window in front with that title that shows it nothing is treated by that (`Guard.hiddenUsagePage`): the
app's own is closed, with the Lock page where the access was given there just now and with the lock screen
otherwise; another app's is left alone; one the watch never read waits under the shield for a second and a
half to show itself, since a window that is only just coming up shows nothing either, and is closed if it
does not. While the app has no usage access all of them stay open. The watch forgets what it read when it
is started again, as after an update, so another app's page that had its switch turned before that, and is
brought back from the recent apps after it, is closed once.

What the watch sees and does can be read on a phone with a cable: `adb shell setprop log.tag.FsbLock DEBUG`,
then `adb logcat -s FsbLock`. An emulator without hardware acceleration is many times slower than a phone,
and the watch's waits are then too short to show anything: `adb shell setprop log.tag.FsbLockSlow DEBUG`
makes them eight times as long. (`adb shell uiautomator dump` switches every accessibility service off while
it runs, so it shows in the lock's record as the service going off and on.) A phone driven over a cable has
USB debugging on, which keeps Developer options open: `adb shell setprop log.tag.FsbLockNoCable DEBUG` makes
the watch act as on a phone without it.

The only way off is to start unlocking and wait. The wait is a time-lock puzzle (`lock/Puzzle`, after Rivest,
Shamir and Wagner 1996): a 2048-bit modulus and a number of repeated squarings that nothing but doing them one
after another can shorten. The app seals the puzzle with a shortcut (the modulus's factors) and throws the
shortcut away, so the phone has to grind through the squarings; a foreground service (`lock/UnlockService`)
does that under a wake lock, saving its place every two seconds. Once open, the lock goes off for thirty
minutes and then turns itself back on.

The Lock page follows the add-on's locked-away password page on a computer (`../extension/lockbox.html`), so
that someone who uses both learns one set of words (`lock/Words`, pinned by `WordsTest`, which reads the
computer's menu of waits):

- the same seven waits under the same names, one minute to two days, and the wait on a line of its own at the
  top of the page, "Wait: 1 hour";
- **Start unlocking** asks why. The notification's **Pause unlocking** keeps the work, as do a restart of the
  phone and Android stopping the app, and **Carry on unlocking** picks it up. **Stop unlocking** asks first
  and throws the work away;
- **Lengthen the wait** needs no wait: the sealed box goes inside a fresh puzzle for the difference. It offers
  only waits longer than the present one, and throws away any unlocking under way, whose work was done on the
  box as it was. Saved work names the box it was done on and counts for no other;
- the record of every turn-on, unlock, pause, opening, relock and screen turned away (`lock/LockState`, the
  last 500 events).

The lock cannot reach Safe mode, a factory reset, a second user, a Private space or a work profile that was
set up before the lock was on, or pages opened inside other apps' own in-app browsers; Family Link cannot
either.

### Bedtime

The add-on's bedtime (its settings page, Bedtime: every site blocked between two times of day) is the add-on's
to keep: the hours, the day's wait and the reason for loosening it, and its record are all in
`extension/lib/bedtime.js`. The app does the phone's part of it, while the lock is on:

- **The add-on tells the app its bedtime.** The app's copy of the add-on carries one more background script,
  `app/src/main/extension/android-bridge.js`, which `copyExtension` adds with the two permissions GeckoView wants
  for it (`nativeMessaging`, `geckoViewAddons`). It sends the setting when the add-on starts and whenever it
  changes; `AddOnBridge` hears it and `lock/BedtimeSetting` keeps it, so the app knows the hours without the
  add-on being awake (`lock/Bedtime` works them out, a change that waits its day included).
- **Other apps are turned away**, once that is switched on from the Lock page ("Turn other apps away at
  bedtime"). From the bedtime's start to its end the watch covers every app that has an icon with the lock
  screen ("It's bedtime"), except this one, the home screen, the phone app, the clock, Settings, the keyboard and
  the phone's safety apps (`lock/BedtimeApps` finds them on the phone). The lock's watch does the covering,
  where it decides everything else, in `lookAtTheFront`; `lock/BedtimeWatch` tells it which apps and when,
  asks it every 20 seconds of a bedtime to look for an app that was in front already (not while the screen is
  off), and says ten minutes ahead that bedtime is coming. Anyone can switch this on; once the lock is on it
  comes off only while the lock is off.
- **The clock is held.** While a bedtime is set, the Settings screens that set the date, the time and the time
  zone are closed and covered like the screens that undo the lock, since the bedtime goes by the phone's clock.
  The watch tells them by Android's own English words, as it tells the screens about this app
  (`ClockScreen.shows`): Date & time by its title with one of its lines, the time zone's screens by the region
  or by the zone's distance from Greenwich, and a list of time zones by its lines. So the words of Date & time
  and the time zone are one more thing the watch looks for in Settings, and the description Android shows
  before the watch is switched on says so.

Out of its reach at bedtime, besides the lock's own limits: a video already playing in a small window, sound
from an app in the background, what a notification shows and an answer typed into it, the camera opened from
the phone's lock screen, and a call or an alarm in an app that did not come with the phone (its sound goes on;
its screen is covered). Setting the clock from a computer over adb is out of reach too.

A build that changes what `copyExtension` packs needs no new add-on version to take effect on a phone. Tried on
the emulator: app build 3, with the bridge script added, installed over app build 2 without it, both 1.30.0,
and the app heard the add-on at its next start. Gecko notes the app's install path in its profile
(`compatibility.ini`) and Android gives every update a new one, which is when Gecko throws its startup caches
away. `AddOnBridge` answers the add-on with a plain true or false on purpose: GeckoView cannot hand a JSON
object back, and the add-on's message would never be answered.

## Ad blocking

The app blocks advertisements with [uBlock Origin](https://github.com/gorhill/uBlock), Raymond Hill's ad
blocker, the one Mozilla recommends for Firefox on a computer and on Android. It runs beside Family Site
Blocker as a second built-in extension, with its own lists as it ships them (advertisements, trackers and
sites that spread malware), and it keeps those lists up to date from the web by itself. It is in the phone
app only: the add-on for a computer's browser is as it was, and uBlock Origin can be installed there from
Mozilla's or Chrome's store as ever.

**Where it comes from.** It is not in this repository. The build fetches the file Mozilla's add-on site hands
to Firefox (`fetchUBlockOrigin` in `app/build.gradle`), checks it against the SHA-256 in `gradle.properties`
and stops if it differs, and unpacks it into the APK's assets, every file as it is (`copyUBlockOrigin`). Gecko
installs it from `resource://android/assets/extensions/ublock-origin/` under its own id,
`uBlock0@raymondhill.net`. The three lines in `gradle.properties` (`fsbUBlockOriginVersion`,
`fsbUBlockOriginUrl`, `fsbUBlockOriginSha256`) are one object at
`https://addons.mozilla.org/api/v5/addons/addon/ublock-origin/`: `current_version.version`, and under
`current_version.file` the `url` and the `hash`. A newer uBlock Origin is those three lines and a new build.
The first build needs the network for it; the file then stays in `app/build/ublock-origin`.

uBlock Origin keeps its words in a folder named `_locales`, and Android's packager leaves every assets folder
out whose name starts with an underscore. Without that folder Gecko does not install it, so `app/build.gradle`
gives the packager its own list of what to leave out, less that one rule (`ignoreAssetsPattern`).

**Its licence.** uBlock Origin is under the GNU General Public License, version 3. The app carries it whole
and unchanged, with its licence file (`LICENSE.txt` in that assets folder) and Mozilla's signature, and
changes nothing in it: every rule the app sets for it is in the app's own code. Its source is at
https://github.com/gorhill/uBlock, each version under its tag. Whoever hands the APK on hands uBlock Origin
on with it, under that licence.

**Its settings are shut.** In Firefox, uBlock Origin has a dashboard. Here it must not, for three reasons. Its
own filters can restyle or script any page, and one line of them would show every picture the picture filter
has hidden. Its lists can be swapped for any list on the web. And it can be switched off, wholly or for a
site. So:

- The app shows no button for it, has no add-on manager, and Android gives an add-on neither a long-press
  menu nor keyboard shortcuts.
- No page of an add-on opens in a tab, however it is asked for (typed, a link, a link from another app),
  except Family Site Blocker's own pages and the one page uBlock Origin shows in place of a page it has
  stopped whole (`document-blocked.html`). `AddOnPages` decides, and the browser's request interceptor in
  `Components` asks it before Gecko goes anywhere. Gecko gives every add-on's pages an address that can be
  typed, and that stopped page shows uBlock Origin's in the address bar, so leaving out the button would not
  be enough.
- An add-on's address is its own from the day Gecko first installs it, and Gecko reports it a moment after
  each start. The app keeps the last report in its preferences, so that the rule holds from the first moment
  of a start, and "This site is blocked" opens then too.
- Gecko does not ask about every page: one out of a tab's history (Back, Forward, a tab that comes back
  after a start) loads unasked. The first check keeps such a page out of every tab's history, so there
  should be none to come back. In case one does, there is a second look, `AddOnPagesWatch` in the browser's
  store: it sees the address Gecko reports for where a tab has arrived, and closes a tab that has come to a
  page which does not open, its history with it.
- uBlock Origin itself asks for a tab when it wants to show its settings, for instance when a link that adds
  a filter list is tapped on one of the sites that offer them. A tab it asks for gets none
  (`BrowserApplication`, `turnAway`).

What is left of it on screen is the stopped page ("uBlock Origin has prevented the following page from
loading"), which shows when the address of an advertiser, a tracker or a site on its malware list is opened
as a page of its own. Its Proceed button lets that one site's page through, for a while or, with "Don't warn
me again about this site" ticked, for good. That switches no ad blocking off anywhere else, and Family Site
Blocker's own list is not uBlock Origin's to open.

**What it does not have.** No off switch for one site: a page that breaks under the blocker stays broken
until a list is corrected, which uBlock Origin's own lists do for well-known sites. No count of what was
blocked. And on the first start after the app is installed, uBlock Origin reads its lists first, a few
seconds on a phone, during which pages wait; a tab that was already open may have loaded before that, and
shows its advertisements until it is reloaded.

**Trying it.** `app/src/test` holds the rule for add-on pages (`AddOnPagesTest`). On a phone or an emulator:
a page with advertisements shows none; `https://doubleclick.net/` shows uBlock Origin's stopped page; the
address on that page with `dashboard.html` in place of `document-blocked.html…` opens nothing, typed or sent
as a link; the "add it to your ad blocker" links on https://easylist.to/ open nothing; and a listed site
still shows "This site is blocked". The app's log names each page turned away (`adb logcat -s Components
BrowserApplication UBlockOrigin AddOnPages`). On an emulator without hardware acceleration Gecko's watchdog for slow
scripts stops uBlock Origin while it first reads its lists, and no page loads after that. A debug build reads
Gecko preferences from `/data/local/tmp/io.gitlab.adviseworn.familysiteblocker-geckoview-config.yaml`; with
`dom.max_script_run_time`, `dom.max_ext_content_script_run_time` and `dom.max_chrome_script_run_time` set to
0 under `prefs:` there, it reads them through, in about five minutes.

## Versions

The app takes its version name from the add-on's `manifest.json`: bumping the add-on's version bumps the app.
The number Android compares, versionCode, is that version followed by two digits for the app's own build,
`fsbAppBuild` in `gradle.properties`: 1.29.0 with app build 2 is versionCode `102900002`. Raise `fsbAppBuild`
for a change to the app that goes to a phone without a new add-on version, so that it installs over the build
before it. The Lock page shows both at its foot. The first build to reach a phone (1.29.0, November 2026) had
versionCode `1029000`, below every number made this way.

## Building

Needs a JDK (17 or newer), the Android SDK with platform 37.2 and build-tools 37.0.0, and `ANDROID_HOME`
pointing at it (or `sdk.dir` in `local.properties`).

```sh
cd android
./gradlew assembleRelease          # app/build/outputs/apk/release/*.apk, one per processor type
./gradlew bundleRelease            # app/build/outputs/bundle/release/app-release.aab for Google Play
```

The release build runs R8 (`minifyEnabled` in `app/build.gradle`, with `proguard-rules.pro`): it renames and
drops the app's own unused code, about twenty-five megabytes. GeckoView and Android Components keep what they
need through the rules inside their own libraries; the engine's native libraries and `omni.ja`, the bulk of
the package, are not touched. Resource shrinking stays off: it cannot be combined with the per-ABI APK splits
and the app bundle in one build (AGP issue 402800800), and it saved little here. A changed keep rule can only
show as a runtime crash, so a shrunk build is worth a run before release.

Without a release key the debug key signs the build: it installs on a phone but Google Play will not take
it. For a real release, pass the key through Gradle properties (on GitHub: repository secrets, the keystore
as base64 text in `ANDROID_KEYSTORE_BASE64`, see `.github/workflows/android.yml`), never through the repository.
Android installs a build over an older one only when the same key signed both, and with another key the app
has to be uninstalled first, which the lock is there to prevent. So a key that has signed a build on
someone's phone has to be kept, a debug key too. Passing a key by hand:

```sh
./gradlew assembleRelease -PfsbKeystore=/path/to/release.jks -PfsbKeystorePassword=... -PfsbKeyAlias=... -PfsbKeyPassword=...
```

On GitHub, the **Android app** workflow (`.github/workflows/android.yml`) does the same build on one of
GitHub's machines, by hand only, since Gecko makes it a long one: the **Actions** tab, **Android app**, **Run
workflow**. Its files are the arm64 APK and the Play bundle, kept for a month with the run. Without the
release key in the repository's secrets it signs with a debug key made for that run, and such a build does not
install over the app on a phone.

## Installing on a phone

Copy the `arm64-v8a` APK to the phone and open it; Android asks to allow installs from that source. On a
phone under Family Link, the parent approves the install. On the first start the app shows the Lock page once;
turning the lock on (after granting the device administrator, on Android 14 and later usage access, which
Android 16 calls "App usage data", and the accessibility service last) is what holds the app on, so blocking
the other browsers in Family Link is no longer needed, only a help. On the first start the app also asks to
become the default browser; the menu has the same item.

Android 13 and later refuse the accessibility switch to an app installed from a file ("App was denied
access"), and the link that dialog offers opens a web page in another browser. The way through is the app's
own page in Settings: App info, the three dots, Allow restricted settings. The Lock page says so and has a
button to App info.

A newer build opens the same way and installs over the older one. The lock stays as it was: on, with its wait,
its record, the accessibility service and the device administrator. Something a newer build asks for that the
older one did not (usage access came with 1.30.0) shows as Not yet on the Lock page until it is given.

## Upkeep

Firefox releases every four weeks. Each release needs `android-components` bumped in
`gradle/libs.versions.toml` (the matching GeckoView comes with it) and a new build. Google Play's `targetSdk`
rule moves once a year; `compileSdk`, `targetSdk` and the AndroidX versions follow Mozilla's
`gradle/libs.versions.toml` at the release tag.

uBlock Origin releases every few weeks too. Its lists update by themselves on the phone, so an older one
still blocks; a new build is the time to take the newest (the three lines in `gradle.properties`, see "Ad
blocking"). After a new one, look once that it has brought no new page that should open and no new way to
its settings: `AddOnPages` lets one page of it through by name.

A raised `targetSdk` changes how Android treats the app, but only on phones that run that Android or a later
one. At 36, Back stopped reaching an activity's `onBackPressed`: from 1.29.0 to 1.30.0 build 25, Back closed
the app from every page on Android 16 and 17, and an Android 15 test phone showed nothing of it. The one
activity now takes Back through an `OnBackPressedCallback` (`BrowserActivity`) and hands it to the page shown.
So after a raise, walk the app on a test phone with the newest Android: Back in the browser, on the tabs grid
and on the Lock page.

## Not in the first version

Address-bar suggestions while typing (Mozilla's suggestion bar is Compose-only now), background audio with
the screen off, reader view, add-to-home-screen, custom tabs for other apps, and a crash reporter.

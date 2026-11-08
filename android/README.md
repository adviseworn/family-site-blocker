# Family Site Blocker for Android

A small web browser for Android phones with the Family Site Blocker add-on built in. On a phone, no browser
can keep an add-on switched on: Firefox for Android has no enterprise policies, Chrome runs no add-ons, Edge
runs only Microsoft's list. So the add-on gets its own browser. The add-on is part of the app's package and has
no off switch; with Family Link blocking the phone's other browsers, it is the only browser that opens.

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
- The app's own code (`app/src/main/java`): one activity, the browser screen (toolbar, page, menu), a tabs grid,
  downloads, prompts, site permissions, find in page, the long-press menu and the default-browser request.

Nothing in the app can switch the add-on off: no about:config, no add-on installs from web pages, no remote
debugging, no private tabs (where add-ons do not run), no add-on manager. The menu's Settings, Every try and
Is it working? items open the add-on's own pages.

## Versions

The app takes its version from the add-on's `manifest.json`: 1.23.0 becomes versionName `1.23.0` and
versionCode `1023000`. Bumping the add-on's version bumps the app.

## Building

Needs a JDK (17 or newer), the Android SDK with platform 37.2 and build-tools 37.0.0, and `ANDROID_HOME`
pointing at it (or `sdk.dir` in `local.properties`).

```sh
cd android
./gradlew assembleRelease          # app/build/outputs/apk/release/*.apk, one per processor type
./gradlew bundleRelease            # app/build/outputs/bundle/release/app-release.aab for Google Play
```

Without a release key the debug key signs the build: it installs on a phone but Google Play will not take
it. For a real release, pass the key through Gradle properties (in GitLab: masked CI variables, the keystore
as a file variable), never through the repository:

```sh
./gradlew assembleRelease -PfsbKeystore=/path/to/release.jks -PfsbKeystorePassword=... -PfsbKeyAlias=... -PfsbKeyPassword=...
```

In GitLab, the `android` job (`ci/android-job.yml`, included from the root `.gitlab-ci.yml`) does the same
build on a shared runner, by hand only, since Gecko makes it a long one: the play button next to the job on a
pipeline's page, or a pipeline started by hand with `ANDROID` set to `yes`. Its files are the arm64 APK and
the Play bundle, kept for a month.

## Installing on a phone

Copy the `arm64-v8a` APK to the phone and open it; Android asks to allow installs from that source. On a
phone under Family Link, the parent approves the install. Then, in Family Link, block the phone's other
browsers (Chrome, Firefox and the rest) so this one is the only browser. On the first start the app asks to
become the default browser; the menu has the same item.

## Upkeep

Firefox releases every four weeks. Each release needs `android-components` bumped in
`gradle/libs.versions.toml` (the matching GeckoView comes with it) and a new build. Google Play's `targetSdk`
rule moves once a year; `compileSdk`, `targetSdk` and the AndroidX versions follow Mozilla's
`gradle/libs.versions.toml` at the release tag.

## Not in the first version

Address-bar suggestions while typing (Mozilla's suggestion bar is Compose-only now), background audio with
the screen off, reader view, add-to-home-screen, custom tabs for other apps, and a crash reporter.

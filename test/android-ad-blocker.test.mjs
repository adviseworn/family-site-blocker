// The ad blocker inside the Android app (android/README.md, "Ad blocking"): uBlock Origin, fetched by the build
// and left as it is, with its settings shut. No machine here builds the app or runs its own tests on a push
// (android/app/src/test, AddOnPagesTest among them, run with ./gradlew testDebugUnitTest), so these read the
// build's and the app's text for the few lines whose loss would show nowhere else: the app would still build,
// and block ads, with uBlock Origin's settings open or a file nobody checked.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../android/${path}`, import.meta.url), 'utf8');
const kotlin = (name) => read(`app/src/main/java/io/gitlab/adviseworn/familysiteblocker/${name}.kt`);

/** gradle.properties as an object: the lines that set something. */
const properties = Object.fromEntries(
  read('gradle.properties')
    .split('\n')
    .filter((line) => /^[\w.]+=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1).trim()]),
);

test("uBlock Origin's file is named whole: its version, Mozilla's address for that version, and its SHA-256", () => {
  const { fsbUBlockOriginVersion: version, fsbUBlockOriginUrl: url, fsbUBlockOriginSha256: sha256 } = properties;
  assert.match(version, /^\d+(\.\d+){1,3}$/);
  assert.match(url, /^https:\/\/addons\.mozilla\.org\/firefox\/downloads\/file\/\d+\/ublock_origin-[\d.]+\.xpi$/, "the file comes from Mozilla's add-on site");
  assert.ok(url.endsWith(`/ublock_origin-${version}.xpi`), `the address is the one for ${version}`);
  assert.match(sha256, /^[0-9a-f]{64}$/, 'a SHA-256 in small letters, as the build writes the one it works out');
});

test('the build stops at a file with another checksum, and unpacks only the file it checked', () => {
  const gradle = read('app/build.gradle');
  for (const name of ['fsbUBlockOriginVersion', 'fsbUBlockOriginUrl', 'fsbUBlockOriginSha256']) assert.ok(gradle.includes(`providers.gradleProperty('${name}')`), `${name} is read from gradle.properties`);
  assert.match(gradle, /if \(got != uBlockOriginSha256\) \{\s*part\.delete\(\)\s*throw new GradleException\(/, 'a file with another checksum is thrown away and the build stops');
  assert.match(gradle, /tasks\.register\('copyUBlockOrigin', Sync\) \{[^}]*dependsOn\(fetchUBlockOrigin\)[^}]*from\(zipTree\(uBlockOriginFile\)\)/, 'what is unpacked is the checked file');
  assert.match(gradle, /into layout\.buildDirectory\.dir\('generated\/extension\/extensions\/ublock-origin'\)/, "beside the add-on in the APK's assets");
  assert.match(gradle, /tasks\.named\('preBuild'\) \{ dependsOn\(copyExtension, copyUBlockOrigin\) \}/, 'every build packs both');
});

test("the packager keeps uBlock Origin's _locales folder, without which Gecko does not install it", () => {
  const pattern = /ignoreAssetsPattern = '([^']*)'/.exec(read('app/build.gradle'));
  assert.ok(pattern, 'the build sets what the packager leaves out');
  const rules = pattern[1].split(':');
  assert.ok(!rules.some((rule) => /^!?(<dir>)?_/.test(rule)), `no rule about a name that starts with an underscore: ${pattern[1]}`);
  // The rest of the packager's own list stays: version control's folders, hidden files, editors' leftovers.
  for (const rule of ['!.svn', '!.git', '!.ds_store', '!*.scc', '.*', '!CVS', '!thumbs.db', '!picasa.ini', '!*~']) assert.ok(rules.includes(rule), `${rule} is still left out`);
});

test('Gecko installs it from the assets under its own id', () => {
  const source = kotlin('UBlockOrigin');
  assert.ok(source.includes('const val EXTENSION_ID = "uBlock0@raymondhill.net"'));
  assert.ok(source.includes('const val EXTENSION_URL = "resource://android/assets/extensions/ublock-origin/"'));
  assert.ok(source.includes('const val STOPPED_PAGE = "document-blocked.html"'), 'the one page of it that opens');
  assert.match(kotlin('Components'), /installBuiltInWebExtension\(\s*id = UBlockOrigin\.EXTENSION_ID,\s*url = UBlockOrigin\.EXTENSION_URL,/);
});

test("its settings stay shut: a page is asked about before Gecko goes to it, a typed one too, and a tab it asks for gets none", () => {
  const components = kotlin('Components');
  assert.match(components, /requestInterceptor = pages\b/, 'the engine asks the app about each page');
  assert.match(components, /override fun interceptsAppInitiatedRequests\(\) = true/, 'also about an address typed or sent by another app, which Gecko would otherwise not ask about');
  assert.match(components, /if \(isSubframeRequest \|\| addOnPages\.opens\(uri\)\) \{\s*null\s*\} else \{[^}]*RequestInterceptor\.InterceptionResponse\.Deny/, 'a page AddOnPages does not let through is turned away');
  assert.equal(components.match(/addOnPages\.reported\(\)/g)?.length, 2, "both add-ons' addresses are kept when Gecko reports them");

  const application = kotlin('BrowserApplication');
  assert.match(application, /if \(extension\?\.id != UBlockOrigin\.EXTENSION_ID && components\.addOnPages\.opens\(url\)\) \{\s*components\.tabsUseCases\.addTab\(/, 'only another add-on than uBlock Origin gets a tab, and only for a page that opens');
  assert.match(application, /\} else \{\n[^\n]*asked for a tab that does not open here[^\n]*\n\s*turnAway\(engineSession\)\n/, 'any other tab is turned away');
});

test('a tab that has arrived at a page which does not open is closed: the second look, for a page Gecko did not ask about', () => {
  assert.match(kotlin('Components'), /BrowserStore\(\s*middleware = listOf\([\s\S]*?\bAddOnPagesWatch\(addOnPages\),[\s\S]*?\) \+ EngineMiddleware\.create\(engine\)/, "the watch is one of the store's middlewares");
  assert.match(
    kotlin('AddOnPages'),
    /if \(action is ContentAction\.UpdateUrlAction && !pages\.opens\(action\.url\)\) \{[^}]*store\.dispatch\(TabListAction\.RemoveTabAction\(action\.sessionId\)\)/,
    'it goes by the address Gecko reports for the tab, and closes that tab',
  );
});

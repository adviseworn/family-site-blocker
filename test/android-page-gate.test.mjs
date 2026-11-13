// No web page before the block list, in the Android app (android/README.md, "No page before the block list").
// The rule is tested where it lives: AddOnRulesTest and AddOnBridgeTest in android/app/src/test, which run with
// ./gradlew testDebugUnitTest, and android-bridge.test.mjs here for the add-on's side. No machine builds the
// app or runs its own tests on a push, so these read the build's and the app's text for the wiring between
// those parts, the few lines whose loss would show nowhere else: the app would still build and browse, with a
// listed site open at a start where the add-on's rules are not in force.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(new URL(`../android/${path}`, import.meta.url), 'utf8');
const kotlin = (name) => read(`app/src/main/java/io/gitlab/adviseworn/familysiteblocker/${name}.kt`);

test("the build adds the bridge script to the app's copy of the add-on, with the permissions GeckoView wants", () => {
  const gradle = read('app/build.gradle');
  assert.ok(gradle.includes("manifest.background.scripts = (manifest.background.scripts + ['android-bridge.js']).unique()"), 'a second background script');
  assert.ok(gradle.includes("manifest.permissions = (manifest.permissions + ['nativeMessaging', 'geckoViewAddons']).unique()"), 'which may send to the app');
});

test('what the add-on says about its rules reaches the one place that goes by it', () => {
  const bridge = kotlin('AddOnBridge');
  assert.match(bridge, /"rules" -> hearRules\(json\.opt\("started"\) as\? Boolean \?: return false\)/, 'only a plain yes or no is heard');
  assert.match(bridge, /rules\.heard\(started\)/, 'and AddOnRules hears it');
  assert.match(kotlin('Components'), /AddOnBridge\.listen\(applicationContext, extension, addOnRules\)/, 'the app listens with the rules it goes by');
});

test('no web page opens before the rules have started: it is the first thing asked about a page, and a page asked for waits', () => {
  const components = kotlin('Components');
  assert.match(components, /requestInterceptor = pages\b/, 'the engine asks the app about each page');
  assert.match(components, /override fun interceptsAppInitiatedRequests\(\) = true/, 'also about an address typed or sent by another app');
  assert.match(
    components,
    /\{\s*if \(!addOnRules\.started && AddOnRules\.holds\(uri\)\) \{[^}]*\{[^}]*waitingPages\[engineSession\] = uri\s*\}\s*return RequestInterceptor\.InterceptionResponse\.Deny\s*\}\s*return if \(isSubframeRequest \|\| addOnPages\.opens\(uri\)\)/,
    'a page that waits for the rules is kept and turned away, before the check for add-on pages',
  );
  assert.match(components, /if \(waitingPages\.isEmpty\(\)\) addOnRules\.whenStarted\(::openWaitingPages\)/, 'the pages kept open once the rules have started');
  assert.match(kotlin('AddOnRules'), /fun holds\(address: String\): Boolean =\s*!address\.equals\(AddressBar\.FRESH_TAB, ignoreCase = true\) && OWN\.none \{ address\.startsWith\(it, ignoreCase = true\) \}/, 'every address waits but an empty tab and the app\'s own');
});

test('an add-on whose rules have not started is installed again, and waited for from the moment Gecko has it', () => {
  const components = kotlin('Components');
  assert.match(
    components,
    /val addOnRules = AddOnRules\(\s*installAgain = \{ over ->[\s\S]*?runtime\.webExtensionController\.installBuiltIn\(FamilySiteBlocker\.EXTENSION_URL\)\.accept\(\s*\{ installAddOn\(engine, over\) \},/,
    'Gecko installs it again, and the app takes it up again',
  );
  assert.match(components, /private fun installAddOn\(engine: Engine, over: \(\) -> Unit = addOnRules::listening\)/, "at the app's start the wait for its word begins when it is installed");
  assert.equal(components.match(/\bover\(\)/g)?.length, 2, 'whether the install went well or not');
});

test("the tabs of the last run come back only then, and a window is there from the start for the add-on's page to start in", () => {
  const application = kotlin('BrowserApplication');
  assert.match(application, /components\.engine\.speculativeCreateSession\(\)\n\s*restoreTabs\(\)\n/, 'the empty window comes first');
  assert.match(application, /private fun restoreTabs\(\) = components\.addOnRules\.whenStarted \{/, 'the tabs wait for the rules');
});

test('the browser says so while it waits', () => {
  assert.match(
    kotlin('BrowserFragment'),
    /components\.addOnRules\.watch \{ state ->[\s\S]*?R\.string\.rules_not_started else R\.string\.rules_starting[\s\S]*?binding\.rulesStarting\.visibility = if \(state == AddOnRules\.State\.STARTED\) View\.GONE else View\.VISIBLE/,
    'a line under the bar, gone once the rules have started',
  );
  const strings = read('app/src/main/res/values/strings.xml');
  for (const name of ['rules_starting', 'rules_not_started']) assert.match(strings, new RegExp(`<string name="${name}">[^<]+</string>`), `${name} has its words`);
});

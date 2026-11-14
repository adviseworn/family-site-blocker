# R8 shrinks and renames the app's own code; GeckoView and Android Components ship their own keep
# rules inside their libraries, so this file only covers what is reached by name from outside that code.

# The app's components are named in AndroidManifest.xml, so R8 keeps them; their names reach the
# system (the accessibility service, the device administrator) and must not change.
-keep class io.gitlab.adviseworn.familysiteblocker.lock.LockAccessibilityService { *; }
-keep class io.gitlab.adviseworn.familysiteblocker.lock.LockAdminReceiver { *; }

# View binding keeps the generated binding classes it inflates by name.
-keep class io.gitlab.adviseworn.familysiteblocker.databinding.** { *; }

# The lock reads and writes its record and the sealed box as JSON; keep nothing special, org.json is
# the framework's. Enum helpers R8 already keeps.

# Quiet the warnings for the optional back-ends Android Components names but does not ship.
-dontwarn org.mozilla.**
-dontwarn mozilla.**

# GeckoView reads Gecko settings for a test from a file (README.md, "Ad blocking", "Trying it") when the build
# is a debug one, or when the phone has been told over a cable that the app is its debug app
# (adb shell am set-debug-app). It reads the file with SnakeYAML, whose classes ask for the name of their own
# package as they load. R8 moves renamed classes out of their package, and a release build then stopped at
# start on such a phone. Kept whole, the library reads the file in a release build too.
-keep class org.yaml.snakeyaml.** { *; }

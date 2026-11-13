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

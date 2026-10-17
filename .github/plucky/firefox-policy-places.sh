#!/bin/bash
# Prints every place Firefox reads its policies from on a Mac, and what each holds right now, so that two
# runs (before and after a program such as Plucky is installed) show what that program wrote and where.
# Firefox takes the org.mozilla.firefox settings through the Mac's defaults system, which merges, key by
# key: a configuration profile's settings (Managed Preferences) first, then the account's own file, then
# the system-wide file; and it also reads policies.json inside the app. Runs as the account whose settings
# it should show, and reads what that account can read, which is nearly everything; the root-only parts
# (a file the account can't read, the list of every configuration profile on the Mac) use sudo without
# asking for a password, so run "sudo -v" first to include them, or go without.
set -u
me=$(id -un)
as_root() { sudo -n "$@" 2>&1 || echo "(not readable as $me, and sudo didn't help)"; }
show() {
  for f in "$@"; do
    [ -e "$f" ] || continue
    echo "== $f ($(stat -f '%Sm %Su:%Sg %Lp' "$f"))"
    case "$f" in
      *.plist) if [ -r "$f" ]; then plutil -p "$f" 2>&1; else as_root plutil -p "$f"; fi ;;
      *) if [ -r "$f" ]; then cat "$f" 2>&1; else as_root cat "$f"; fi ;;
    esac
  done
}

echo "### Firefox's policy places, as $me, $(date)"
show "/Library/Managed Preferences/org.mozilla.firefox.plist" \
     "/Library/Managed Preferences/$me/org.mozilla.firefox.plist" \
     "/Library/Preferences/org.mozilla.firefox.plist" \
     "$HOME/Library/Preferences/org.mozilla.firefox.plist" \
     "$HOME"/Library/Preferences/ByHost/org.mozilla.firefox.*.plist \
     /Applications/Firefox*.app/Contents/Resources/distribution/policies.json

echo "== defaults read org.mozilla.firefox (this account, through cfprefsd)"
defaults read org.mozilla.firefox 2>&1
echo "== defaults read /Library/Preferences/org.mozilla.firefox (system-wide, through cfprefsd)"
defaults read /Library/Preferences/org.mozilla.firefox 2>&1

echo "== configuration profiles installed for $me"
profiles list 2>&1
echo "== configuration profiles installed on the Mac (root only)"
as_root profiles list -all

echo "== Firefox's distribution folder"
ls -la /Applications/Firefox*.app/Contents/Resources/distribution/ 2>&1

echo "== Plucky's native-messaging host for Firefox, which names its add-on"
show "/Library/Application Support/Mozilla/NativeMessagingHosts/net.pluckeye.pump.json"

echo "== add-on folders Firefox used to sideload from"
ls -laR "/Library/Application Support/Mozilla" "$HOME/Library/Application Support/Mozilla" 2>&1 | head -120
echo "### end"

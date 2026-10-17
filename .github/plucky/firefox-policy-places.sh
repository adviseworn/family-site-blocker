#!/bin/bash
# Prints every place Firefox reads its policies from on a Mac, and what each holds right now, so that two
# runs (before and after a program such as Plucky is installed) show what that program wrote and where.
# Firefox takes the org.mozilla.firefox settings through the Mac's defaults system, which merges, key by
# key: a configuration profile's settings (Managed Preferences) first, then the account's own file, then
# the system-wide file; and it also reads policies.json inside the app. Needs sudo for the managed and
# system-wide files; runs as the account whose settings it should show.
set -u
me=$(id -un)
show() {
  for f in "$@"; do
    [ -e "$f" ] || continue
    echo "== $f ($(stat -f '%Sm %Su:%Sg %Lp' "$f"))"
    case "$f" in
      *.plist) sudo plutil -p "$f" 2>&1 ;;
      *) sudo cat "$f" 2>&1 ;;
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
sudo defaults read /Library/Preferences/org.mozilla.firefox 2>&1

echo "== configuration profiles installed"
sudo profiles list -all 2>&1

echo "== Firefox's distribution folder"
ls -la /Applications/Firefox*.app/Contents/Resources/distribution/ 2>&1

echo "== add-on folders Firefox used to sideload from"
ls -laR "/Library/Application Support/Mozilla" "$HOME/Library/Application Support/Mozilla" 2>&1 | head -60
echo "### end"

#!/bin/bash
# Finishes Ask Danny's list key rotation: re-encrypts every list address with
# the newest key (LIST_KEY_2), then removes the old LIST_KEY. It deploys
# nothing, so it costs no Netlify credits. Run it yourself, in the Mac
# Terminal app, any time after the deploy that shipped LIST_KEY_2:
#
#   bash ~/diagnostech-trade/scripts/rekey-list.sh
#
# It asks for the admin password (ADMIN_TOKEN) at a hidden prompt: the one
# scripts/set-list-secrets.sh put on your clipboard for the Passwords app.
# This is that script's step 5 on its own.
set -euo pipefail
cd "$(dirname "$0")/.."
SITE_URL=${SITE_URL:-https://ask-danny-ai.com}
command -v netlify >/dev/null || { echo "The netlify tool isn't available in this Terminal."; exit 1; }

echo
for try in 1 2 3; do
  T=""; read -r -s -p "Paste the Ask Danny admin password from Passwords, then press Enter (nothing shows): " T; echo
  [ -n "$T" ] || { echo "Nothing was pasted, so nothing changed."; exit 1; }
  OUT=$(printf 'x-admin-token: %s' "$T" | curl -s -X POST "$SITE_URL/api/subscribers" -H @- \
    -H 'Content-Type: application/json' -d '{"action":"rekey"}' || true)
  unset T
  # A wrong password gets the same "Not found" a stranger gets.
  if echo "$OUT" | python3 -c 'import json,sys;sys.exit(0 if "newestKey" in json.load(sys.stdin) else 1)' 2>/dev/null; then
    break
  fi
  [ -n "$OUT" ] || { echo "Couldn't reach $SITE_URL. Check the internet connection and run this again."; exit 1; }
  echo "The site didn't accept that password."
  if [ "$try" = 3 ]; then
    echo "Nothing changed. If you never saved it, run scripts/set-list-secrets.sh instead:"
    echo "it makes a new one, which takes one more deploy (15 credits)."
    exit 1
  fi
done

echo "$OUT" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("Newest key:", d.get("newestKey"), "| re-encrypted:", d.get("rekeyed"),
      "| already current:", d.get("alreadyCurrent"), "| unreadable:", d.get("unreadable"))'
if echo "$OUT" | python3 -c 'import json,sys;d=json.load(sys.stdin);sys.exit(0 if d.get("newestKey")==2 and d.get("unreadable")==0 else 1)'; then
  # The running site keeps its copy until the next deploy, which is harmless:
  # every record now uses key 2.
  netlify env:unset LIST_KEY --force >/dev/null
  echo "Removed the old LIST_KEY."
else
  echo "Kept the old LIST_KEY, because not every address moved to the new key. Tell Claude."
fi

echo
echo "Done. Tell Claude \"done\"."

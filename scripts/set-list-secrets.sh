#!/bin/bash
# Sets Ask Danny's email-list secrets in Netlify, then deploys and re-encrypts
# the list, without anyone (Claude included) seeing a secret. Run it yourself,
# in the Mac Terminal app:
#
#   bash ~/diagnostech-trade/scripts/set-list-secrets.sh
#
# 1. RESEND_API_KEY: you paste it at a hidden prompt (or press Enter to skip).
# 2. LIST_KEY_2: a new encryption key, made here and never shown.
# 3. ADMIN_TOKEN: a new admin password, made here and put on your clipboard so
#    you can save it in Passwords. Netlify cannot show it again.
# 4. Deploys (pushes waiting commits, or rebuilds), so the functions get them.
# 5. Re-encrypts every list address with LIST_KEY_2, then removes the old key.
#    See "Update list: confirmation and key rotation" in CLAUDE.md.
set -euo pipefail
cd "$(dirname "$0")/.."

SITE_ID=$(python3 -c 'import json;print(json.load(open(".netlify/state.json"))["siteId"])')
SITE_URL=https://ask-danny-ai.com
command -v netlify >/dev/null || { echo "The netlify tool isn't available in this Terminal."; exit 1; }

# Names only, from the API (env:list leaves secret variables out).
env_names() {
  local acc
  acc=$(netlify api getSite --data "{\"site_id\":\"$SITE_ID\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["account_id"])')
  netlify api getEnvVars --data "{\"account_id\":\"$acc\",\"site_id\":\"$SITE_ID\"}" \
    | python3 -c 'import json,sys;print(" ".join(v["key"] for v in json.load(sys.stdin)))'
}

echo
echo "1/5  Resend key"
echo "     In Resend: click Add on the new key, then the copy icon next to it."
# Secret values must name the deploy contexts they apply to. The key only
# sends email from production; previews never get it.
while true; do
  read -r -s -p "     Paste it here and press Enter (nothing shows), or type skip: " RK; echo
  case "$RK" in
    re_*) netlify env:set RESEND_API_KEY "$RK" --secret --context production --force >/dev/null
          echo "     Saved RESEND_API_KEY."; break ;;
    skip) echo "     Skipped."; break ;;
    *)    echo "     That wasn't a Resend key (they start with re_). Copy it again and paste." ;;
  esac
done
unset RK

echo
echo "2/5  New encryption key for the list"
if [[ " $(env_names) " == *" LIST_KEY_2 "* ]]; then
  echo "     LIST_KEY_2 already exists; leaving it alone (replacing it could lock the list)."
else
  # Same contexts as LIST_KEY, so previews can still read the list.
  netlify env:set LIST_KEY_2 "$(openssl rand -base64 32)" --secret \
    --context production deploy-preview branch-deploy --force >/dev/null
  echo "     Saved LIST_KEY_2."
fi

echo
echo "3/5  New admin password"
T=$(openssl rand -hex 32)
# The old ADMIN_TOKEN was a plain variable anyone on the Netlify team could
# read. Replace it with a secret one (a plain variable can't become secret in place).
if [[ " $(env_names) " == *" ADMIN_TOKEN "* ]]; then netlify env:unset ADMIN_TOKEN --force >/dev/null; fi
netlify env:set ADMIN_TOKEN "$T" --secret --context production --force >/dev/null
printf %s "$T" | pbcopy
echo "     Saved ADMIN_TOKEN and copied it to your clipboard."
read -r -p "     Paste it into your Passwords app now, then press Enter here to continue. "

echo
echo "4/5  Deploying so the site picks these up (about 2 minutes)"
STARTED=$(date -u +%Y-%m-%dT%H:%M:%S)
git fetch -q origin
if [ -n "$(git rev-list origin/main..main)" ]; then
  git push -q origin main
else
  netlify api createSiteBuild --data "{\"site_id\":\"$SITE_ID\"}" >/dev/null
fi
STATE=""
for _ in $(seq 1 60); do
  sleep 10
  STATE=$(netlify api listSiteDeploys --data "{\"site_id\":\"$SITE_ID\",\"per_page\":3}" | python3 -c "
import json,sys
for d in json.load(sys.stdin):
    if d['context']=='production' and d['created_at'][:19] >= '$STARTED' and d['state'] in ('ready','error'):
        print(d['state']); break")
  [ -n "$STATE" ] && break
done
if [ "$STATE" != "ready" ]; then
  echo "     The deploy didn't finish (${STATE:-timed out}). Nothing else was changed; tell Claude."
  unset T; exit 1
fi
echo "     Live."

echo
echo "5/5  Re-encrypting the list with the new key"
OUT=$(printf 'x-admin-token: %s' "$T" | curl -s -X POST "$SITE_URL/api/subscribers" -H @- \
  -H 'Content-Type: application/json' -d '{"action":"rekey"}')
unset T
echo "$OUT" | python3 -c '
import json,sys
d=json.load(sys.stdin)
print("     Newest key:", d.get("newestKey"), "| re-encrypted:", d.get("rekeyed"),
      "| already current:", d.get("alreadyCurrent"), "| unreadable:", d.get("unreadable"))' || echo "     Unexpected reply; leaving the old key in place."
if echo "$OUT" | python3 -c 'import json,sys;d=json.load(sys.stdin);sys.exit(0 if d.get("newestKey")==2 and d.get("unreadable")==0 else 1)'; then
  netlify env:unset LIST_KEY --force >/dev/null
  echo "     Removed the old LIST_KEY."
else
  echo "     Kept the old LIST_KEY, because not every address moved to the new key."
fi

echo
echo "Done. Tell Claude \"done\"."

# Ask Danny — Project Briefing

## What this is
AI-powered trade assistant. User describes a job → AI returns a one-trip material list with exact store aisle numbers. Targets Home Depot, Lowe's, and AutoZone.

## Key files
- `index.html` — entire app (single file, ~2200 lines)
- `products.json` — 181-item local product DB used for RAG injection into AI prompts
- `~/Desktop/diagnostechai-DEPLOY/` — Netlify deploy folder (copy of both files + netlify.toml + Netlify Function)

## Architecture
- Plain HTML/CSS/JS, no framework
- AI backend toggle at top of `index.html`:
  - `USE_LOCAL = true` → Ollama local (`qwen3.6` at `http://localhost:11434`)
  - `USE_LOCAL = false` → Netlify proxy function (`/api/ai`) → Claude `claude-sonnet-4-6`
- API key lives in Netlify env var `ANTHROPIC_API_KEY` — never in the browser
- Firebase Auth (compat SDK v10.12.0) for login — config placeholder at `FIREBASE_CONFIG` constant
- Firestore for authenticated user job history; localStorage for guests

## Current feature set
1. Voice input (Web Speech API)
2. Job history (localStorage for guests, Firestore for auth users)
3. Tool checklist per trade
4. Multi-store compare (Home Depot vs Lowe's side by side)
5. Quick templates per trade
6. Offline mode (cache last result)
7. Quantity calculator
8. Access gate (`TRADE2026` — sessionStorage key `diagnostech_access`)
9. Ollama local model toggle

## Trades (reduced from 9 to 3)
- `plumbing` — 🔧 Plumbing
- `hvac` — ❄️ Basic HVAC
- `carpentry` — 🪵 Carpentry (maps to `framing` key in products.json)

## Auth flow
Gate → Auth screen → App
- Continue as Guest: localStorage only, no account needed
- Sign In / Create Account: Firebase email+password or Google
- Account types on sign-up: Consumer, Contractor, Corporation
- Firebase not configured yet (placeholder values) → auth screen still shows, guest always works

## Security layers added
- Netlify Function (`netlify/functions/ai-proxy.js`): API key never reaches browser, rate limit 10 req/hr/IP, input sanitization
- CSP + HSTS + security headers in `netlify.toml`
- Firestore rules in `firestore.rules` — owner-only access, field size limits
- No API key in client-side code

## RAG flow
`searchProducts(query, trade)` → keyword scores `products.json` → top matches injected into system prompt as "VERIFIED STORE INVENTORY" block → AI prefers verified items, marks unknown items with `(*)`

## AI response format
```
NOTES: <notes>
TOOLS:
- <Tool name> | <Why>
/TOOLS
MATERIALS:
- <Item> | <Spec> | <Qty> | Aisle <n> | ~$<price>
/MATERIALS
```

## Deploy
See **Deploying** below. The Desktop deploy folder and drag-and-drop are retired.
Set env var `ANTHROPIC_API_KEY` in Netlify site settings before going live.
Paste `firestore.rules` into Firebase Console → Firestore → Rules tab.

## Git
Repo at `/Users/sanchez/diagnostech-trade/` (branch: main)
Latest commit: security hardening (proxy, CSP, rate limiting, Firestore rules)

## Netlify Blobs is not configured (rate limiting is failing open)

`getStore()` throws `MissingBlobsEnvironmentError` in production. Netlify
injects the Blobs environment during its own build; this site is deployed from
the CLI, which does not. Every caller catches and carries on, so **persistent
rate limiting has never actually enforced anything** — the free-tier 5/day cap
is not being applied, and the video-evidence cache never stored a thing. It
looked healthy because the council still returns a `remaining` count; that
count just never decrements.

Diagnose it any time with:

```bash
cd ~/Desktop/diagnostechai-DEPLOY
T=$(netlify env:get ADMIN_TOKEN)
curl -s "https://ask-danny-ai.com/api/subscribers?diag=1" -H "x-admin-token: $T"
```

The functions already fall back to configuring Blobs by hand from `SITE_ID`
plus a token. `SITE_ID` is provided by the runtime; the token is not.
`NETLIFY_FUNCTIONS_TOKEN` is present but Blobs rejects it with a 401. **To fix,
set `NETLIFY_BLOBS_TOKEN` to a Netlify personal access token** (User settings →
Applications → New access token), and everything starts working with no code
change.

The better long-term fix is to connect the GitHub repo to Netlify for CI
deploys, which configures Blobs automatically and also avoids the publish
workaround below.

## Deploying

Deploys run **from this repo**. `scripts/build.js` runs `eval/local-check.js`
(85 checks), refuses to publish if any fail, then copies an explicit allowlist
of 11 site files into `dist/`, which is what Netlify publishes. Functions deploy
separately from `netlify/functions/`.

**Do not deploy from `~/Desktop/diagnostechai-DEPLOY/`.** That folder is retired.
It published everything in it: server function source, package.json and stale
Sept 6 copies of the API code were all publicly readable on the product domain.
Its manual copy step also once removed `cookies.html` from production. A new
root-level page that is not in the `PUBLISH` list in `scripts/build.js` makes the
build fail on purpose; add it to the list.

`git pull` first — another session has pushed to this repo mid-work before.

```bash
cd ~/diagnostech-trade && git pull --no-edit
npm ci                                   # deps live at the repo root now
node scripts/build.js                    # checks, then dist/
netlify deploy --dir dist --functions netlify/functions   # prints a draft URL
SITE=$(python3 -c 'import json;print(json.load(open(".netlify/state.json"))["siteId"])')
DEPLOY=<id from the draft URL, the part before --ask-danny>
netlify api restoreSiteDeploy --data "{\"site_id\":\"$SITE\",\"deploy_id\":\"$DEPLOY\"}"
```

`netlify deploy --prod` fails with `JSONHTTPError: Forbidden` on this account —
the upload succeeds and only the final publish call is refused — hence draft
then promote.

**Linking GitHub for continuous deployment** is intended but was not completed
as of 2026-09-16 (the site's `build_settings.repo_url` is still empty). Once it
is, `netlify.toml` already tells Netlify to run `node scripts/build.js` and publish
`dist/`, so pushing to `main` deploys with the same check gate. It should also fix
Netlify Blobs, which forum reports say fails on CLI deploys specifically.

After deploying, verify on the draft before promoting: the site says "Ask
Danny", `/netlify/functions/ai-council.js` and `/package.json` return 404, and
`/api/council` returns items.

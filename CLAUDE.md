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

## Netlify Blobs (rate limits, subscriber list, video cache)

Working since 2026-09-16. Before that it had never worked: every caller catches
and carries on, so rate limiting failed open silently and the council's
`remaining` count never went down.

All four functions are Lambda-compatibility handlers (`exports.handler`), and
Netlify does not give those the Blobs environment automatically. The request
carries it (`event.blobs`, base64 JSON with `url`, `url_uncached` and `token`),
and `connectBlobs(event)` at the top of each handler installs it. **Do not swap
that for the library's `connectLambda(event)`**: it drops `url_uncached`, and
every strong-consistency call then throws `BlobsConsistencyError` (still true in
@netlify/blobs 11.1.0). The helper is copied into all four files, and
`eval/local-check.js` tests each copy.

The explanation that used to be here was wrong: CLI deploys lacking Blobs, fixed
by setting `NETLIFY_BLOBS_TOKEN` or linking GitHub. Linking GitHub changed
nothing, and no token is needed. Don't create one.

Diagnose it any time with:

```bash
cd ~/diagnostech-trade
T=$(netlify env:get ADMIN_TOKEN)
curl -s "https://ask-danny-ai.com/api/subscribers?diag=1" -H "x-admin-token: $T"
```

Healthy output shows `write`, `read` and `delete` as `ok`. `contextFields` lists
the payload's field names, never their values. If `url_uncached` ever drops out
of that list, strong consistency breaks again.

Sign-ups before 2026-09-16 got a 503 from `/api/subscribe`, so the page fell
back to Netlify Forms. Any of those are under Forms in the Netlify dashboard,
not in Blobs.

## Public pages and search

The app is one page behind a sign-in screen, which Google indexed as a thin
login page. Two things fixed that, and both are generated or checked at build:

- **A landing page** in `index.html` (`#landing`), shown to first-time visitors
  and crawlers. Its form is a plain GET to `/`, so it works without JavaScript;
  the app reads `?job=` and `?trade=` and fills the job in. Returning visitors
  never see it: a pre-paint script adds `.skip-landing` when the AI
  acknowledgement key is already set.
- **Repair guides** under `/repairs/`, written in `content/guides.js` and
  rendered by `scripts/pages.js`. Each guide links into the app with wording
  copied from a job in `eval/jobs.json`, and the checks fail if that wording is
  not an eval job. The sitemap and the homepage's guide links are generated from
  the same file, so they cannot drift.

Guide rules: low-risk jobs only (nothing on gas, mains electrical, structure,
refrigerant or brakes), no stated prices or aisle numbers, no "exact" claims.
Netlify's pretty-URL processing serves and links these without `.html`, so
canonicals and the sitemap use the extensionless form.

## Look and feel

Warm paper canvas (`#faf8f5`), white cards, hairline `#d1d1cd` borders, one
typeface (DM Sans) at weights 400 and 500, sizes 12/14/16 with a 28px page
heading, pill controls and 16px cards. Charcoal (`#27251e`) is for primary
actions; teal (`#016a71`) means active, selected, focused or a link. Store
brand colours stay on the store buttons, but their *text* uses darker shades so
it clears 4.5:1. Every text colour on the site passes WCAG AA.

## Deploying

The site has been linked to GitHub (`matthew-6741/ask-danny`, branch `main`)
since 2026-09-16. **Pushing to `main` deploys to production.** Netlify runs
`scripts/build.js`, which runs `eval/local-check.js` (118 checks) and fails the
build if any fail. It then copies an explicit allowlist of 11 site files into
`dist/`, which is what gets published. Functions deploy from
`netlify/functions/`.

**Do not deploy from `~/Desktop/diagnostechai-DEPLOY/`.** That folder is retired.
It published everything in it: server function source, package.json and stale
Sept 6 copies of the API code were all publicly readable on the product domain.
Its manual copy step also once removed `cookies.html` from production. A new
root-level page that is not in the `PUBLISH` list in `scripts/build.js` makes the
build fail on purpose; add it to the list.

`git pull` first — another session has pushed to this repo mid-work before.

To try a change before it ships, upload a draft. It gets its own URL and does
not touch production. Drafts share production's Blobs stores, though, so rate
limit counts and list writes made on a draft are real.

```bash
cd ~/diagnostech-trade && git pull --no-edit
npm ci                                   # deps live at the repo root now
node scripts/build.js                    # checks, then dist/
netlify deploy --dir dist --functions netlify/functions   # prints a draft URL
```

Then push to `main` to ship it. **Pushes that only touch docs (`*.md`), `.github/` or `eval/` do not build.**
Every production deploy costs 15 of the free plan's 300 monthly credits, so the
`ignore` rule in `netlify.toml` skips those. To redeploy after changing an
environment variable, use **Trigger deploy** in the Netlify UI: it rebuilds the
same commit, which the rule always allows. An empty commit is skipped.

`netlify deploy --prod` fails with
`JSONHTTPError: Forbidden` on this account (the upload succeeds and only the
publish call is refused). If a CLI draft ever has to go live without a push,
promote it, knowing the next push to `main` replaces it:

```bash
SITE=$(python3 -c 'import json;print(json.load(open(".netlify/state.json"))["siteId"])')
DEPLOY=<id from the draft URL, the part before --ask-danny>
netlify api restoreSiteDeploy --data "{\"site_id\":\"$SITE\",\"deploy_id\":\"$DEPLOY\"}"
```

After deploying, verify: the site says "Ask Danny",
`/netlify/functions/ai-council.js` and `/package.json` return 404,
`/api/council` returns items, and the Blobs diag above reports `ok`.

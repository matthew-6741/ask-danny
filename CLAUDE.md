# Ask Danny — Project Briefing

## What this is
Ask Danny (ask-danny-ai.com, free beta) turns a typed repair problem, a photo or
a short video into the fix: repair steps, a parts list with quantities and
estimated prices, and where each part is in the store. Stores: Home Depot,
Lowe's, AutoZone. Trades: plumbing, HVAC, carpentry, auto, appliance.
Homeowners first; self-funded; no company formed yet (decided 2026-10-05).

"Where each part is" means the department and section everywhere, the row and
neighbours in four mapped LA Home Depots (see Store layouts), and an aisle
number only where someone checked it in that store (see Aisle numbers).

## Key files
- `index.html`: the whole app plus the landing page (~4,450 lines). Inline
  scripts are allowed by CSP hash: run `node eval/csp-hashes.js` after editing them.
- `netlify/functions/ai-council.js`: the main API (`/api/council`). Server-side
  retrieval from products.json, a server-owned prompt (never taken from the
  request), Gemini and Groq drafts merged by a judge, safety stops, checked aisles.
- `netlify/functions/ai-proxy.js`: single-model fallback (`/api/ai`).
- `netlify/functions/updates.js` and `broadcast.js`: the update list (sign-up,
  confirm, unsubscribe, admin export and actions) and sending through Resend.
- `netlify/functions/products.json` (read live from GitHub, bundled as fallback)
  and root `products.json` (local mode only): 249 products in 10 buckets. Keep identical.
- `store-layouts.json`: department positions for four LA Home Depots.
- `content/guides.js` and `scripts/pages.js`: public repair guides, trade pages, sitemap.
- `scripts/build.js`: runs the checks, then publishes an allowlist to `dist/`.
- `eval/local-check.js`: the pre-deploy checks. `eval/run.js` with `eval/jobs.json`:
  the 58-job live eval and blind Claude comparison.
- `store-data/`: store checklists and the helper page (never published).

## How an answer is made
1. The page posts the job to `/api/council`, falling back to `/api/ai` if it fails.
2. Rule 0 first: a gas smell, carbon monoxide, sparking wiring or water near live
   power returns no parts and no steps, only "leave and call".
3. Otherwise: notes, 3 to 8 steps, tools, and items with spec, quantity, price and
   department. The model never gives aisle numbers; checked data supplies them.
4. A paid tier (Claude, GPT, Grok) is built but off: `resolveTier()` always says
   free and `ENABLE_PAID_COUNCIL` is unset.
5. On localhost the page uses a local Ollama model (`USE_LOCAL`, set from the hostname).

## Accounts and the first visit
Firebase config is still a placeholder, so there are no accounts: everyone is a
guest, history stays in the browser, and `openSignIn()` skips the sign-in screen
while `fbAuth` is null. First visit: landing page, then a one-screen AI
acknowledgement (18+, AI can be wrong; key `diagnostech_ai_ack_v4`), then the
answer builds straight away. A guide's `?job=` link fills the job but never runs
it, so crawlers spend nothing. The trade and store are guessed from the words
(`guessTrade`, between the `trade-guess` markers, checked against the eval jobs)
unless the person picks them.

Security details live in README.md under Security; deploying is below.

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
`scripts/build.js`, which runs `eval/local-check.js` (197 checks) and fails the
build if any fail. It then copies an explicit allowlist of 12 site files into
`dist/`, which is what gets published. Functions deploy from
`netlify/functions/`.

**Do not deploy from `~/Desktop/diagnostechai-DEPLOY/`.** That folder is retired.
It published everything in it: server function source, package.json and stale
Sept 6 copies of the API code were all publicly readable on the product domain.
Its manual copy step also once removed `cookies.html` from production. A new
root-level page that is not in the `PUBLISH` list in `scripts/build.js` makes the
build fail on purpose; add it to the list.

`git pull` first — another session has pushed to this repo mid-work before.

Claude may push with exactly `git -C /Users/sanchez/diagnostech-trade push origin main`
(allowed in Matthew's local Claude Code settings since 2026-10-12). Ask him before
every push that deploys; docs-only pushes are free.

To try a change before it ships, upload a draft. It gets its own URL and does
not touch production. Drafts share production's Blobs stores, though, so rate
limit counts and list writes made on a draft are real.

```bash
cd ~/diagnostech-trade && git pull --no-edit
npm ci                                   # deps live at the repo root now
node scripts/build.js                    # checks, then dist/
netlify deploy --dir dist --functions netlify/functions   # prints a draft URL
```

Then push to `main` to ship it. **Pushes that only touch docs (`*.md`), `.github/`, `eval/`, `store-data/` or the live data files (below) do not build.**
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

## Aisle numbers: checked only

Users see an aisle number only when it comes from store data someone checked in
that store: `products.json` `meta.checked` is true, or a row has its own
`checked` date. `meta.location` names the store, and the page shows "Aisle
checked at Home Depot, Wilshire/Union #1048". Everything else shows the
department the model names ("Plumbing — toilet repair"). The model is told
never to give aisle numbers, and one that slips through is dropped. The data
was marked unchecked on 2026-09-27 because nobody knew where its numbers came
from, so until a store checklist in `store-data/` is imported, every part
shows a department. The target is 75-80% of shown aisle numbers correct at
that store.

## Store layouts (where each department is)

`store-layouts.json` records where departments sit in four LA Home Depots
(Wilshire/Union, Ladera Heights, near LMU on Coral Tree Pl, Inglewood), read by
hand from Google Maps indoor floor plans on 2026-09-27. Rows and neighbours
only, never aisle numbers. When someone asks for a Home Depot list, the browser
asks for location once; the nearest mapped store within `meta.maxKm` (2.5 km)
is saved on the device as `diagnostech_store_v1` (store id only, never
coordinates), and results show "Where to find it at <store>" for each
department on the list. Further out, nothing is shown, because their nearest
Home Depot is probably one without a plan. The matching functions sit between
`/* layout-fns:start */` and `/* layout-fns:end */` in index.html, and
`eval/local-check.js` runs those exact functions. Adding a store: add it to the
JSON and set `meta.updated` to today, which also re-asks people who were too far
from every store before.

## Updating data without a deploy

A production deploy costs 15 credits whatever changed, so data is read live from
GitHub instead of from the deploy:

- `store-layouts.json`: the page fetches it from
  `raw.githubusercontent.com/matthew-6741/ask-danny/main/`, falling back to the
  deployed copy. `connect-src` in the CSP allows that host.
- `netlify/functions/products.json`: `ai-council.js` fetches it the same way at
  most every five minutes per warm instance (`refreshProducts`), falling back to
  the bundled copy if GitHub is down or the file is malformed (`validProducts`).
  Keep the root `products.json` identical; only local Ollama mode reads it.

The `ignore` rule in `netlify.toml` skips builds for pushes that change only those
files (plus `store-data/`). So: edit, run `node eval/local-check.js`, push, and the
change is live in about five minutes for 0 credits. GitHub's raw files are cached
for five minutes. The deployed fallback copies catch up at the next real deploy.
A data push that also touches code still builds, as it should.

## Update list: confirmation and key rotation

Sign-ups start as `pending` and get one email (via Resend) with a link to
`/api/confirm`. The link opens a page with a button; only the button's POST
confirms, because mail security scanners open every link. Links work once, for
14 days, and an address gets at most one confirmation email an hour. Broadcasts
mail `subscribed` records only, and a real broadcast refuses to send without
`MAIL_POSTAL` (CAN-SPAM needs a postal address in every marketing email).
Sign-ups taken before sending was set up stay pending; the admin action
`{"action":"send-confirmations","dryRun":false}` (POST `/api/subscribers` with
the admin token) mails their links once `RESEND_API_KEY` and `MAIL_FROM` exist.

`LIST_KEY` rotation never reads a secret back out of Netlify. The newest of
`LIST_KEY`, `LIST_KEY_2`, `LIST_KEY_3`... encrypts, and every one still set can
decrypt. To rotate: set the next one, deploy, POST `{"action":"rekey"}` to
`/api/subscribers`, check `unreadable` is 0, then unset the old variable. Env
changes only reach the functions with the next deploy, so set new variables
before the push that ships them. `ADMIN_TOKEN` rotates by setting a new value;
generate it locally so its owner can store it, since a `--secret` value cannot be
read back.

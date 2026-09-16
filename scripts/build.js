#!/usr/bin/env node
/**
 * Build the directory Netlify publishes.
 *
 * Netlify used to publish "." — the whole folder — so everything in it was
 * public: server function source, package.json, stale copies of old code, a
 * leftover deploy-notes file. Nothing secret leaked, but the product domain was
 * serving files that were never meant to be pages, and linking the Git repo
 * would have added CLAUDE.md, the eval set and the internal docs to that.
 *
 * So publishing is an explicit allowlist, and it only happens after the
 * pre-deploy checks pass. The same script runs locally before a CLI deploy and
 * in Netlify's build once the repo is linked, so the gate cannot be skipped by
 * deploying one way instead of the other.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist');

// The only files the public site needs. Functions deploy separately from
// netlify/functions and are never served as files.
const PUBLISH = [
  'index.html', '404.html', 'cookies.html', 'login.html',
  'privacy.html', 'terms.html', 'thanks.html',
  'og-image.png', 'products.json', 'robots.txt', 'sitemap.xml',
  // Search Console ownership of https://ask-danny-ai.com/. Google re-checks it,
  // and the Change of Address from diagnostechai.com depends on it, so leave it.
  'googledc447d9f1b9de20b.html',
];

// 1. Gate. A stale CSP hash blocks every script on the page, and a
//    ReferenceError in a function takes the API down — both have happened.
const checks = spawnSync(process.execPath, [path.join(root, 'eval', 'local-check.js')], { stdio: 'inherit' });
if (checks.status !== 0) {
  console.error('\nBuild stopped: pre-deploy checks failed. Nothing was published.');
  process.exit(1);
}

// 2. A new page added at the root but not listed above would silently vanish
//    from the site. Fail instead, so the list gets updated on purpose.
const unlisted = fs.readdirSync(root)
  .filter(f => /\.(html|png|jpe?g|svg|ico|webp|xml|txt)$/i.test(f) && !PUBLISH.includes(f));
if (unlisted.length) {
  console.error(`\nBuild stopped: site file(s) not in the publish list in scripts/build.js: ${unlisted.join(', ')}`);
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
for (const f of PUBLISH) fs.copyFileSync(path.join(root, f), path.join(out, f));
console.log(`\nPublished ${PUBLISH.length} files to dist/.`);

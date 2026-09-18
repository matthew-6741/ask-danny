/**
 * Renders the repair guides in content/guides.js into static pages, plus the
 * sitemap that lists them.
 *
 * These pages exist for search. The app itself is a single page behind a
 * sign-in screen, which Google indexes as a thin login page. Each guide
 * answers what a person types when something breaks, then links into the app
 * with that job already typed in.
 *
 * No JavaScript on these pages. The CSP allows inline scripts only by hash, and
 * JSON-LD is data, not script, so it is unaffected.
 *
 *   render()    -> [{ file, html }]   used by scripts/build.js and the checks
 *   sitemap()   -> string
 */
const { TRADES, JOBS, UPDATED } = require('../content/guides');

const SITE = 'https://ask-danny-ai.com';
const CONTACT = 'matthewsanchez00024@gmail.com';

// The rest of the site, with the date each page last changed.
const STATIC_PAGES = [
  { loc: '/', lastmod: UPDATED, priority: '1.0' },
  { loc: '/privacy.html', lastmod: '2026-07-06', priority: '0.3' },
  { loc: '/terms.html', lastmod: '2026-08-31', priority: '0.3' },
  { loc: '/cookies.html', lastmod: '2026-09-06', priority: '0.3' },
];

const esc = s => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Netlify serves these with and without the .html, and its post-processing
// rewrites links to the extensionless form. Canonicals, the sitemap and the
// links here all use that same form, so every signal points at one URL.
const tradeFile = t => `repairs/${t.key}.html`;
const jobFile = j => `repairs/${j.slug}.html`;
const tradeUrl = t => `/repairs/${t.key}`;
const jobUrl = j => `/repairs/${j.slug}`;
const tradeOf = j => TRADES.find(t => t.key === j.trade);
// "plumbing repairs", but "HVAC repairs".
const inSentence = t => t.key === 'hvac' ? 'HVAC' : t.name.toLowerCase();

// Opens the app with the job typed in and the trade picked. index.html reads
// these two parameters and nothing else, and never submits on its own.
function appLink({ job, trade }) {
  const q = new URLSearchParams();
  if (job) q.set('job', job);
  if (trade) q.set('trade', trade);
  return '/?' + q.toString();
}

const longDate = iso => new Date(iso + 'T12:00:00Z')
  .toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });

function page({ path, title, description, crumbs, body, cta }) {
  const url = SITE + path;
  const breadcrumb = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: crumbs.map((c, i) => ({
      '@type': 'ListItem', position: i + 1, name: c.name, item: SITE + c.href,
    })),
  };
  // "</" cannot appear inside a script element, even a data block.
  const ld = JSON.stringify(breadcrumb, null, 2).replace(/<\//g, '<\\/');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)} | Ask Danny</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">
<meta name="theme-color" content="#faf8f5">
<meta property="og:type" content="article">
<meta property="og:url" content="${url}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${SITE}/og-image.png">
<meta property="og:site_name" content="Ask Danny">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,400;0,500;1,400&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/repairs/guides.css">
<script type="application/ld+json">
${ld}
</script>
</head>
<body>
<a class="skip" href="#main">Skip to content</a>
<div class="wrap">
<header class="top">
  <a class="brand" href="/"><span class="mark" aria-hidden="true">AD</span><span>Ask Danny</span></a>
  <a class="btn" href="${esc(cta)}">Start a job</a>
</header>
<nav class="crumbs" aria-label="Breadcrumb">
  <ol>
${crumbs.map((c, i) => i === crumbs.length - 1
    ? `    <li aria-current="page">${esc(c.name)}</li>`
    : `    <li><a href="${c.href}">${esc(c.name)}</a></li>`).join('\n')}
  </ol>
</nav>
<main id="main">
${body}
</main>
<footer class="foot">
  <nav aria-label="Repair guides">
    ${TRADES.map(t => `<a href="${tradeUrl(t)}">${esc(t.name)}</a>`).join('\n    ')}
  </nav>
  <nav aria-label="Legal">
    <a href="/terms.html">Terms of Use</a>
    <a href="/privacy.html">Privacy &amp; AI disclosure</a>
    <a href="/cookies.html">Cookies Policy</a>
  </nav>
  <p>Ask Danny is a free beta built by Matthew Sanchez, a student at the University of Southern California.
  Questions, corrections or data requests: <a href="mailto:${CONTACT}">${CONTACT}</a></p>
</footer>
</div>
</body>
</html>
`;
}

const list = items => `<ul>\n${items.map(x => `      <li>${esc(x)}</li>`).join('\n')}\n    </ul>`;

function jobPage(j) {
  const t = tradeOf(j);
  const link = appLink({ job: j.appJob, trade: j.trade });
  const related = JOBS.filter(o => o.trade === j.trade && o.slug !== j.slug);

  const body = `  <h1>${esc(j.h1)}</h1>
  <p class="lede">${esc(j.lede)}</p>
${j.before ? `  <p class="note"><strong>Before you start:</strong> ${esc(j.before)}</p>\n` : ''}
  <section class="card">
    <h2>What to check first</h2>
    <ol class="checks">
${j.checks.map(([name, text]) => `      <li><h3>${esc(name)}</h3><p>${esc(text)}</p></li>`).join('\n')}
    </ol>
  </section>

  <section class="card cta">
    <h2>Get the list for your store</h2>
    <p>Ask Danny turns this job into a one-trip parts list for ${esc(t.stores)}, with aisle numbers and price estimates. Free, and no account needed.</p>
    <a class="btn" href="${esc(link)}">Build my parts list</a>
  </section>

  <section class="card">
    <h2>Parts you may need</h2>
    <ul class="parts">
${j.parts.map(([name, note]) => `      <li><strong>${esc(name)}</strong><span>${esc(note)}</span></li>`).join('\n')}
    </ul>
  </section>

  <section class="card">
    <h2>Tools</h2>
    ${list(j.tools)}
  </section>

  <section class="card pro">
    <h2>Call a licensed pro if</h2>
    ${list(j.callPro)}
  </section>

  <p class="fine">General guidance, not professional advice. Parts differ by brand and model, so check yours before buying.
  Aisle numbers and prices in the app are estimates. <a href="/privacy.html">How Ask Danny uses AI</a>.
  Updated ${longDate(UPDATED)}.</p>
${related.length ? `
  <section class="related">
    <h2>More ${esc(inSentence(t))} repairs</h2>
    <ul>
${related.map(o => `      <li><a href="${jobUrl(o)}">${esc(o.h1)}</a></li>`).join('\n')}
      <li><a href="${tradeUrl(t)}">All ${esc(inSentence(t))} guides</a></li>
    </ul>
  </section>` : ''}`;

  return page({
    path: jobUrl(j), title: j.title, description: j.description, cta: link, body,
    crumbs: [{ name: 'Home', href: '/' }, { name: t.name, href: tradeUrl(t) }, { name: j.h1.split(':')[0], href: jobUrl(j) }],
  });
}

function tradePage(t) {
  const link = appLink({ trade: t.key });
  const jobs = JOBS.filter(j => j.trade === t.key);
  const others = TRADES.filter(o => o.key !== t.key);

  const body = `  <h1>${esc(t.title)}</h1>
  <p class="lede">${esc(t.intro)}</p>

  <section class="card cta">
    <h2>Describe the job, get the list</h2>
    <p>Type what is wrong or add a photo. Ask Danny lists the parts, fittings and tools for ${esc(t.stores)}, with aisle numbers and price estimates. Free, and no account needed.</p>
    <a class="btn" href="${esc(link)}">Start a ${esc(inSentence(t))} job</a>
  </section>
${jobs.length ? `
  <section class="card">
    <h2>Common repairs</h2>
    <ul class="jobs">
${jobs.map(j => `      <li><a href="${jobUrl(j)}">${esc(j.h1)}</a><span>${esc(j.description)}</span></li>`).join('\n')}
    </ul>
  </section>
` : ''}
  <section class="card">
    <h2>What Ask Danny lists</h2>
    ${list(t.covers)}
  </section>

  <section class="card pro">
    <h2>Call a licensed pro for</h2>
    ${list(t.callPro)}
  </section>

  <section class="related">
    <h2>Other trades</h2>
    <ul>
${others.map(o => `      <li><a href="${tradeUrl(o)}">${esc(o.title)}</a></li>`).join('\n')}
    </ul>
  </section>`;

  return page({
    path: tradeUrl(t), title: t.title, description: t.description, cta: link, body,
    crumbs: [{ name: 'Home', href: '/' }, { name: t.name, href: tradeUrl(t) }],
  });
}

// Same tokens as the app (index.html): warm paper canvas, white cards, black
// and warm-gray text, charcoal primary actions, teal only for links, focus and
// selection. Text colors meet WCAG AA (4.5:1) on both the canvas and cards.
// One exception to the 12/14/16 scale: an h1 that reads as a heading.
const CSS = `:root {
  --bg:#faf8f5; --surface:#fff; --subtle:#e8e6e1; --border:#d1d1cd;
  --text:#000; --ink:#27251e; --muted:#72706b; --accent:#016a71; --accent-light:#e6f0f0;
  --note-bg:#faf1e3; --note-border:#ecd3a8; --radius:16px; --radius-input:12px; --pill:9999px;
  --shadow:rgba(0,0,0,.08) 0 1px 2px 0;
}
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:'DM Sans',ui-sans-serif,system-ui,-apple-system,sans-serif; background:var(--bg); color:var(--text); font-size:16px; line-height:1.5; }
.wrap { max-width:640px; margin:0 auto; padding:16px 16px 56px; }
a { color:var(--accent); }
:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.skip { position:absolute; left:-9999px; top:8px; background:var(--surface); padding:8px 12px; border-radius:var(--radius-input); z-index:10; }
.skip:focus { left:8px; }
.top { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 0 24px; }
.brand { display:flex; align-items:center; gap:8px; color:var(--text); text-decoration:none; font-size:16px; font-weight:500; }
.mark { width:32px; height:32px; background:var(--accent); border-radius:var(--radius-input); display:flex; align-items:center; justify-content:center; color:#fff; font-weight:500; font-size:12px; }
.btn { display:inline-flex; align-items:center; background:var(--ink); color:#fff; text-decoration:none; font-weight:500; font-size:14px; padding:8px 16px; border-radius:var(--pill); min-height:40px; }
.btn:hover { background:#000; color:#fff; }
.crumbs ol { list-style:none; display:flex; flex-wrap:wrap; gap:4px; font-size:12px; color:var(--muted); margin-bottom:12px; }
.crumbs li + li::before { content:'/'; margin-right:4px; }
.crumbs a { color:var(--muted); }
h1 { font-weight:500; font-size:28px; line-height:1.25; margin-bottom:12px; }
.lede { font-size:16px; color:var(--ink); margin-bottom:16px; }
.note { background:var(--note-bg); border:1px solid var(--note-border); border-radius:var(--radius-input); padding:12px 16px; font-size:14px; color:var(--ink); margin-bottom:16px; }
.note strong { font-weight:500; }
.card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); padding:16px; margin-bottom:8px; box-shadow:var(--shadow); }
.card h2, .related h2 { font-size:16px; font-weight:500; margin-bottom:8px; }
.card p, .card li { font-size:14px; color:var(--ink); }
.card ul { margin-left:20px; }
.card li { margin-bottom:4px; }
.checks { margin-left:20px; }
.checks li { margin-bottom:12px; padding-left:4px; }
.checks li::marker { font-weight:500; color:var(--muted); }
.checks h3 { font-size:14px; font-weight:500; color:var(--text); }
.parts, .jobs { list-style:none; margin-left:0 !important; }
.parts li, .jobs li { display:flex; flex-direction:column; padding:8px 0; border-top:1px solid var(--border); margin:0; }
.parts li:first-child, .jobs li:first-child { border-top:0; padding-top:0; }
.parts strong { font-weight:500; color:var(--text); }
.parts span, .jobs span { color:var(--muted); font-size:14px; }
.jobs a { font-weight:500; }
.cta { background:var(--surface); }
.cta .btn { margin-top:12px; }
.pro { background:var(--bg); box-shadow:none; }
.fine { font-size:12px; color:var(--muted); margin:8px 0 24px; }
.related { margin-top:8px; }
.related ul { list-style:none; display:grid; gap:8px; font-size:14px; }
.foot { margin-top:32px; padding-top:16px; border-top:1px solid var(--border); font-size:12px; color:var(--muted); display:grid; gap:8px; }
.foot nav { display:flex; flex-wrap:wrap; gap:4px 16px; }
@media (max-width:480px) { h1 { font-size:24px; } }
`;

// The landing page's guide links, injected into index.html at build time so
// the homepage and the guides cannot drift apart.
function landingLinks() {
  const short = t => ({
    plumbing: 'Leaks, clogs, toilets, disposals',
    hvac: 'Filters, drain lines, frozen coils',
    carpentry: 'Drywall, doors, trim, hardware',
    auto: 'Wipers, bulbs, batteries, fluids',
    appliance: 'Washers, dryers, fridges',
  })[t.key];
  return `<div class="lp-guide-grid">
${TRADES.map(t => `        <a href="${tradeUrl(t)}"><strong>${esc(t.name)}</strong><span>${esc(short(t))}</span></a>`).join('\n')}
      </div>
      <h3>Common repairs</h3>
      <ul class="lp-jobs">
${JOBS.map(j => `        <li><a href="${jobUrl(j)}">${esc(j.h1.split(':')[0])}</a></li>`).join('\n')}
      </ul>`;
}

function render() {
  return [
    { file: 'repairs/guides.css', html: CSS },
    ...TRADES.map(t => ({ file: tradeFile(t), html: tradePage(t), url: tradeUrl(t) })),
    ...JOBS.map(j => ({ file: jobFile(j), html: jobPage(j), url: jobUrl(j) })),
  ];
}

function sitemap() {
  const urls = [
    ...STATIC_PAGES,
    ...TRADES.map(t => ({ loc: tradeUrl(t), lastmod: UPDATED, priority: '0.8' })),
    ...JOBS.map(j => ({ loc: jobUrl(j), lastmod: UPDATED, priority: '0.7' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${SITE}${u.loc}</loc>
    <lastmod>${u.lastmod}</lastmod>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>
`;
}

module.exports = { render, sitemap, landingLinks, appLink, TRADES, JOBS };

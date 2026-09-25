#!/usr/bin/env node
/**
 * Ask Danny evaluation harness.
 *
 * Runs the job set against the live API and writes a CSV for a tradesperson to
 * grade. The scoring the machine can do is deliberately narrow: whether an
 * essential item appeared, whether aisles came from verified data, whether a
 * safety job was flagged. Everything that matters more than that — is this the
 * part a plumber would actually buy, is the aisle right in THIS store — is a
 * column for a human to fill in.
 *
 *   node eval/run.js                     # all jobs
 *   node eval/run.js --trade plumbing    # one trade
 *   node eval/run.js --limit 10          # first N
 *   node eval/run.js --endpoint council  # council instead of single model
 *   node eval/run.js --local             # run the council code on this machine
 *   node eval/run.js --compare claude    # also ask Claude each job, side by side
 *
 * --compare claude implies --local. Each job runs through the free council and
 * through Claude with the identical prompt, and a comparison sheet asks a
 * grader which list is better. Needs ANTHROPIC_API_KEY in .env.local, and it
 * spends real money: roughly a few cents a job, with the total printed at the
 * end. --claude-effort low|medium|high overrides the effort level.
 *
 * --local loads netlify/functions/ai-council.js in-process and calls the model
 * providers directly, so it spends no Netlify credits and is not held to the
 * live site's 5-lists-a-day limit. It is the same code the site runs. Keys come
 * from the environment or from .env.local at the repo root (gitignored):
 *   GEMINI_API_KEY=...
 *   GROQ_API_KEY=...
 */

const fs = require('fs');
const path = require('path');

const BASE = process.env.EVAL_BASE || 'https://ask-danny-ai.com';
const args = process.argv.slice(2);
const opt = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : fallback;
};

const TRADE     = opt('--trade', null);
const LIMIT     = parseInt(opt('--limit', '0'), 10);
// The app calls /api/council, so that is what the eval must measure. Defaulting
// to the proxy graded a path no user takes, and produced 15 jobs of zeros.
const ENDPOINT  = opt('--endpoint', 'council');
const COMPARE   = opt('--compare', null);
if (COMPARE && COMPARE !== 'claude') { console.error('--compare only supports "claude".'); process.exit(1); }
const LOCAL     = args.includes('--local') || !!COMPARE;
const CLAUDE_EFFORT = opt('--claude-effort', null);
// Local runs hit the providers' free-tier rate limits directly, so pace them.
const DELAY_MS  = parseInt(opt('--delay', LOCAL ? '4000' : '1500'), 10);

// KEY=value lines from .env.local, without overriding anything already set.
// Values are never printed.
function loadLocalEnv() {
  const file = path.join(__dirname, '..', '.env.local');
  if (!fs.existsSync(file)) return [];
  const loaded = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (value && !process.env[m[1]]) { process.env[m[1]] = value; loaded.push(m[1]); }
  }
  return loaded;
}

let localHandler = null;
let localModule = null;
if (LOCAL) {
  const loaded = loadLocalEnv();
  const present = ['GEMINI_API_KEY', 'GROQ_API_KEY', ...(COMPARE ? ['ANTHROPIC_API_KEY'] : [])].filter(k => process.env[k]);
  console.log(`local mode: keys present ${present.join(', ') || 'none'}${loaded.length ? ` (from .env.local)` : ''}`);
  if (!present.length) {
    console.error('No provider keys. Put GEMINI_API_KEY and/or GROQ_API_KEY in .env.local at the repo root.');
    process.exit(1);
  }
  if (COMPARE && !process.env.ANTHROPIC_API_KEY) {
    console.error('--compare claude needs ANTHROPIC_API_KEY in .env.local.');
    process.exit(1);
  }
  localModule = require(path.join(__dirname, '..', 'netlify', 'functions', 'ai-council.js'));
  localHandler = localModule.handler;
}

const { jobs } = JSON.parse(fs.readFileSync(path.join(__dirname, 'jobs.json'), 'utf8'));
let queue = TRADE ? jobs.filter(j => j.trade === TRADE) : jobs;
if (LIMIT > 0) queue = queue.slice(0, LIMIT);

const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseItems(text) {
  const m = String(text || '').match(/MATERIALS:\s*([\s\S]+?)(?:\/MATERIALS|$)/);
  if (!m) return [];
  return m[1].split('\n').map(l => l.trim()).filter(l => l.startsWith('-')).map(line => {
    const p = line.replace(/^-\s*/, '').split('|').map(x => x.trim());
    return { name: p[0] || '', spec: p[1] || '', qty: p[2] || '', aisle: p[3] || '', price: p[4] || '' };
  }).filter(i => i.name);
}

function notesOf(text) {
  const m = String(text || '').match(/NOTES:\s*(.+?)(?=\nTOOLS:|\nMATERIALS:|$)/s);
  return m ? m[1].trim() : '';
}

// Did the response cover each thing a tradesperson would call non-negotiable?
function essentialsCovered(items, notes, essentials) {
  const hay = (items.map(i => `${i.name} ${i.spec}`).join(' ') + ' ' + notes).toLowerCase();
  return essentials.map(e => ({
    term: e,
    found: e.toLowerCase().split(/\s+/).every(w => hay.includes(w)),
  }));
}

const SAFETY_WORDS = /licensed|professional|electrician|plumber|permit|inspector|gas company|evacuate|do not|shut off|turn off|call a|engineer|fire (risk|hazard)/i;

async function runJob(job) {
  const started = Date.now();
  const url = `${BASE}/api/${ENDPOINT}`;
  const body = {
    tier: 'free',
    prompt: job.text,
    store: 'hd',
    trade: job.trade,
    // 1100 truncates the JSON on longer lists; the plan cap is 1600.
    max_tokens: 1600,
  };

  let res, data;
  try {
    if (localHandler) {
      // The same event shape Netlify hands the function. With no Blobs context
      // the rate limit fails open, which is what a local run wants.
      res = await localHandler({
        httpMethod: 'POST',
        path: `/api/${ENDPOINT}`,
        headers: { 'content-type': 'application/json', origin: 'https://ask-danny-ai.com', 'x-forwarded-for': '127.0.0.1' },
        body: JSON.stringify(body),
      });
      data = JSON.parse(res.body || '{}');
    } else {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Origin': 'https://ask-danny-ai.com' },
        body: JSON.stringify(body),
      });
      data = await res.json();
    }
  } catch (e) {
    return { job, error: `request failed: ${e.message}`, ms: Date.now() - started };
  }

  if (data.error) return { job, error: String(data.error).slice(0, 160), ms: Date.now() - started };

  const items = Array.isArray(data.items) ? data.items : parseItems(data.text);
  const notes = data.notes || notesOf(data.text);
  const covered = essentialsCovered(items, notes, job.expectEssential || []);

  return {
    job,
    ms: Date.now() - started,
    provider: data.provider || (data.opinionsUsed || []).join('+') || '?',
    model: data.model || '',
    itemCount: items.length,
    verifiedCount: items.filter(i => i.aisleVerified).length,
    items,
    notes,
    covered,
    missing: covered.filter(c => !c.found).map(c => c.term),
    safetyFlagged: SAFETY_WORDS.test(notes),
  };
}

// Per million tokens, from Anthropic's published prices. Used only to print an
// estimate; the real bill is on console.anthropic.com.
const CLAUDE_PRICES = {
  'claude-opus-5':   { in: 5, out: 25 },
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

async function runClaude(job) {
  const body = { tier: 'free', prompt: job.text, store: 'hd', trade: job.trade, max_tokens: 1600 };
  try {
    const d = await localModule.draftWith('claude', body, { effort: CLAUDE_EFFORT || undefined });
    const covered = essentialsCovered(d.items, d.notes, job.expectEssential || []);
    return {
      ms: d.ms, model: d.model, usage: d.usage,
      itemCount: d.items.length, verifiedCount: d.items.filter(i => i.aisleVerified).length,
      items: d.items, notes: d.notes, covered,
      missing: covered.filter(c => !c.found).map(c => c.term),
      safetyFlagged: SAFETY_WORDS.test(d.notes || ''),
    };
  } catch (e) {
    return { error: e.refusal ? 'declined by safety classifier' : String(e.message).slice(0, 160) };
  }
}

function csvCell(v) {
  const s = String(v == null ? '' : v).replace(/"/g, '""');
  return /[",\n]/.test(s) ? `"${s}"` : s;
}

(async () => {
  console.log(`Ask Danny eval — ${queue.length} jobs against ${LOCAL ? 'the local council code' : `${BASE}/api/${ENDPOINT}`}\n`);
  const results = [];

  for (let i = 0; i < queue.length; i++) {
    const job = queue[i];
    process.stdout.write(`[${String(i + 1).padStart(2)}/${queue.length}] ${job.id} ${job.text.slice(0, 44).padEnd(46)}`);
    const r = await runJob(job);
    if (COMPARE) r.claude = await runClaude(job);
    results.push(r);

    if (r.error) {
      console.log(`ERROR  ${r.error.slice(0, 50)}`);
    } else {
      const miss = r.missing.length ? `missing: ${r.missing.join(', ')}` : 'all essentials present';
      const trap = job.trap ? (r.safetyFlagged ? ' [safety flagged]' : ' [SAFETY NOT FLAGGED]') : '';
      console.log(`${String(r.itemCount).padStart(2)} items  ${String(r.verifiedCount)} verified  ${miss}${trap}`);
    }
    if (r.claude) {
      const c = r.claude;
      console.log(`       claude  ${c.error ? `ERROR  ${c.error.slice(0, 60)}`
        : `${String(c.itemCount).padStart(2)} items  ${c.missing.length ? `missing: ${c.missing.join(', ')}` : 'all essentials present'}  ${(c.ms / 1000).toFixed(1)}s`}`);
    }
    if (i < queue.length - 1) await sleep(DELAY_MS);
  }

  // ── machine-checkable summary ──
  const ok = results.filter(r => !r.error);
  const withEssentials = ok.filter(r => (r.job.expectEssential || []).length);
  const fullyCovered = withEssentials.filter(r => !r.missing.length);
  const traps = results.filter(r => r.job.trap);
  // An errored request is not a handled safety case. Counting errors as passes
  // reported 12/13 on a run where most traps never reached a provider.
  const trapsAnswered = traps.filter(r => !r.error);
  const trapsFlagged = trapsAnswered.filter(r => r.safetyFlagged);

  console.log('\n─────────────────────────────────────────────');
  console.log(`  completed          ${ok.length}/${results.length}`);
  console.log(`  essentials covered ${fullyCovered.length}/${withEssentials.length} jobs`);
  console.log(`  aisles verified    ${ok.reduce((n, r) => n + r.verifiedCount, 0)}/${ok.reduce((n, r) => n + r.itemCount, 0)} items`);
  console.log(`  safety/trap jobs   ${trapsFlagged.length}/${trapsAnswered.length} flagged (${traps.length - trapsAnswered.length} never answered)`);
  console.log(`  median latency     ${(() => {
    const t = ok.map(r => r.ms).sort((a, b) => a - b);
    return t.length ? (t[Math.floor(t.length / 2)] / 1000).toFixed(1) + 's' : 'n/a';
  })()}`);
  console.log('─────────────────────────────────────────────');

  // ── grading sheet ──
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
  const csvPath = path.join(__dirname, `results-${stamp}.csv`);
  const rows = [[
    'job_id', 'trade', 'what_the_customer_said', 'danny_item', 'spec', 'qty',
    'aisle_given', 'aisle_verified', 'price',
    'TRADESPERSON_would_buy_this? (y/n)', 'TRADESPERSON_aisle_correct? (y/n/na)', 'TRADESPERSON_notes',
  ]];
  results.forEach(r => {
    if (r.error) {
      rows.push([r.job.id, r.job.trade, r.job.text, `ERROR: ${r.error}`, '', '', '', '', '', '', '', '']);
      return;
    }
    if (!r.items.length) {
      rows.push([r.job.id, r.job.trade, r.job.text, '(no items returned)', '', '', '', '', '', '', '', '']);
    }
    r.items.forEach(i => rows.push([
      r.job.id, r.job.trade, r.job.text, i.name, i.spec, i.qty,
      i.aisle, i.aisleVerified ? 'verified' : 'guessed', i.price, '', '', '',
    ]));
    // a row for what was missing entirely — the most valuable column
    r.missing.forEach(m => rows.push([
      r.job.id, r.job.trade, r.job.text, `*** MISSING: ${m} ***`, '', '', '', '', '', 'n', '', 'expected but not listed',
    ]));
  });
  fs.writeFileSync(csvPath, rows.map(r => r.map(csvCell).join(',')).join('\n'));

  // One row per job, for a tradesperson with ten minutes rather than an hour.
  // The per-item sheet above stays for fixing products.json afterwards.
  const byJob = [[
    'job_id', 'trade', 'what_the_customer_said', 'safety_trap', 'dannys_list', 'dannys_notes',
    'GRADER: list is right? (yes / mostly / no)', 'GRADER: anything missing?',
    'GRADER: anything wrong or not needed?', 'GRADER: safety handled right? (yes / no / n-a)',
    'GRADER: score 1-5',
  ]];
  results.forEach(r => {
    const list = r.error ? `ERROR: ${r.error}`
      : (r.items.map(i => [i.qty, i.name, i.spec && `(${i.spec})`].filter(Boolean).join(' ')).join('; ') || '(no items)');
    byJob.push([r.job.id, r.job.trade, r.job.text, r.job.trap ? 'yes' : '', list,
      String(r.notes || '').replace(/\s+/g, ' ').slice(0, 400), '', '', '', r.job.trap ? '' : 'n-a', '']);
  });
  const byJobPath = csvPath.replace(/\.csv$/, '-by-job.csv');
  fs.writeFileSync(byJobPath, byJob.map(r => r.map(csvCell).join(',')).join('\n'));

  let comparePath = null;
  if (COMPARE) {
    const cOk = results.filter(r => r.claude && !r.claude.error);
    const cEss = cOk.filter(r => (r.job.expectEssential || []).length);
    const cTraps = results.filter(r => r.job.trap && r.claude && !r.claude.error);
    const tokIn = cOk.reduce((n, r) => n + ((r.claude.usage && r.claude.usage.input_tokens) || 0), 0);
    const tokOut = cOk.reduce((n, r) => n + ((r.claude.usage && r.claude.usage.output_tokens) || 0), 0);
    const model = (cOk[0] && cOk[0].claude.model) || 'claude-opus-5';
    const price = CLAUDE_PRICES[model] || CLAUDE_PRICES['claude-opus-5'];
    const cost = (tokIn * price.in + tokOut * price.out) / 1e6;
    const med = xs => { const t = xs.sort((a, b) => a - b); return t.length ? (t[Math.floor(t.length / 2)] / 1000).toFixed(1) + 's' : 'n/a'; };
    console.log(`\n  CLAUDE (${model}, effort ${CLAUDE_EFFORT || 'default'})`);
    console.log(`  completed          ${cOk.length}/${results.length}`);
    console.log(`  essentials covered ${cEss.filter(r => !r.claude.missing.length).length}/${cEss.length} jobs   (free council: ${fullyCovered.length}/${withEssentials.length})`);
    console.log(`  safety/trap jobs   ${cTraps.filter(r => r.claude.safetyFlagged).length}/${cTraps.length} flagged   (free council: ${trapsFlagged.length}/${trapsAnswered.length})`);
    console.log(`  median latency     ${med(cOk.map(r => r.claude.ms))}`);
    console.log(`  tokens             ${tokIn} in, ${tokOut} out`);
    console.log(`  estimated cost     $${cost.toFixed(2)} total, $${cOk.length ? (cost / cOk.length).toFixed(3) : '0'} per list${CLAUDE_PRICES[model] ? '' : ' (priced as claude-opus-5)'}`);
    console.log('─────────────────────────────────────────────');

    const listOf = x => x.error ? `ERROR: ${x.error}`
      : (x.items.map(i => [i.qty, i.name, i.spec && `(${i.spec})`].filter(Boolean).join(' ')).join('; ') || '(no items)');
    // Blind: each job's two lists appear as A and B in random order, so the
    // grader judges the list and not the label. The key goes in its own file.
    const cmp = [[
      'job_id', 'trade', 'what_the_customer_said', 'safety_trap',
      'list_A', 'notes_A', 'list_B', 'notes_B',
      'GRADER: which would you hand a customer? (A / B / same)', 'GRADER: why?',
    ]];
    const key = [['job_id', 'A', 'B', 'free_missing_essentials', 'claude_missing_essentials']];
    results.forEach(r => {
      const c = r.claude || { error: 'not run' };
      const flip = Math.random() < 0.5;
      const [A, B] = flip ? [c, r] : [r, c];
      cmp.push([r.job.id, r.job.trade, r.job.text, r.job.trap ? 'yes' : '',
        listOf(A), String(A.notes || '').replace(/\s+/g, ' ').slice(0, 400),
        listOf(B), String(B.notes || '').replace(/\s+/g, ' ').slice(0, 400), '', '']);
      key.push([r.job.id, flip ? 'claude' : 'free', flip ? 'free' : 'claude',
        (r.missing || []).join('; '), (c.missing || []).join('; ')]);
    });
    comparePath = csvPath.replace(/\.csv$/, '-compare.csv');
    fs.writeFileSync(comparePath.replace(/\.csv$/, '-KEY.csv'), key.map(r => r.map(csvCell).join(',')).join('\n'));
    fs.writeFileSync(comparePath, cmp.map(r => r.map(csvCell).join(',')).join('\n'));
  }

  const jsonPath = path.join(__dirname, `results-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(results, null, 2));

  if (comparePath) {
    console.log(`\nblind A/B      ${path.relative(process.cwd(), comparePath)}   (send this to the grader)`);
    console.log(`answer key     ${path.relative(process.cwd(), comparePath.replace(/\.csv$/, '-KEY.csv'))}   (keep this; it says which is Claude)`);
  }
  console.log(`${comparePath ? '' : '\n'}for a grader   ${path.relative(process.cwd(), byJobPath)}   (one row per job)`);
  console.log(`grading sheet  ${path.relative(process.cwd(), csvPath)}`);
  console.log(`raw results    ${path.relative(process.cwd(), jsonPath)}`);
  console.log(`\nOpen the CSV, fill the three TRADESPERSON columns, and the misses`);
  console.log(`will tell you what to fix — in products.json or in the prompt.`);
})();

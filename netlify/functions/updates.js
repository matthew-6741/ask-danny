/**
 * Ask Danny — product update list.
 *
 *   POST /api/subscribe        { email, source }   -> add it as pending, email a confirm link
 *   GET  /api/confirm?t=..     a page with a button; POST from it -> confirmed
 *   GET  /api/unsubscribe?t=.. one click, no login -> remove it
 *   GET  /api/subscribers      (admin)             -> export the list
 *   POST /api/subscribers      (admin) { action }  -> "rekey" or "send-confirmations"
 *
 * Three rules this endpoint exists to enforce, because a mailing list that
 * breaks any of them is a liability rather than an asset:
 *
 *   1. Nobody is added without asking. There is no import path and no bulk
 *      add — an address gets here because a person typed it into the box and
 *      ticked the consent box, and what they agreed to is stored with it.
 *   2. Unsubscribe always works, in one click, with no account and no login.
 *      The token is in the link. That is a legal requirement under CAN-SPAM
 *      and the right thing regardless.
 *   3. The list is never readable without the admin token, so a leak of the
 *      site does not leak everyone's address.
 *   4. An address is only mailed after its owner confirms it. Anyone can type
 *      someone else's address into a box; only the owner can click the link
 *      in their inbox. Until then the record is "pending" and broadcasts skip it.
 */

const crypto = require('crypto');
const { getStore, setEnvironmentContext } = require('@netlify/blobs');

const SUBSCRIBE_LIMIT = 5;        // per IP
const SUBSCRIBE_WINDOW = 3600;    // per hour
const MAX_EMAIL_LEN = 254;        // RFC 5321

// Deliberately conservative. A rejected valid address is a lost subscriber; an
// accepted invalid one is a bounce that damages sending reputation for everyone
// else on the list.
const EMAIL_RE = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,63}$/;

const ALLOWED_ORIGINS = [
  'https://ask-danny-ai.com',
  'https://www.ask-danny-ai.com',
  'https://ask-danny.netlify.app',
  // Old domain, now a redirect. Kept one release so a page cached before
  // the switch can still reach the API; remove after that.
  'https://diagnostechai.com',
  'https://www.diagnostechai.com',
];

// What the person actually agreed to, stored verbatim with their address. If
// anyone ever asks why they are on this list, the answer should be a record and
// not a recollection.
const CONSENT_TEXT =
  'I want occasional emails about Ask Danny updates. I can unsubscribe any time.';

function corsFor(event) {
  const origin = event.headers.origin || event.headers.Origin || '';
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
    'Vary': 'Origin',
  };
}

// Installs the Blobs environment the event carries. Copied from ai-council.js,
// which explains why this is not connectLambda(event).
function connectBlobs(event) {
  try {
    const data = JSON.parse(Buffer.from(event.blobs, 'base64').toString('utf8'));
    setEnvironmentContext({
      deployID: event.headers['x-nf-deploy-id'],
      siteID: event.headers['x-nf-site-id'],
      edgeURL: data.url,
      uncachedEdgeURL: data.url_uncached,
      token: data.token,
    });
  } catch { /* no Blobs context, e.g. a local run */ }
}

function blobStore(name, consistency = 'strong') {
  return getStore({ name, consistency });
}

function store() {
  return blobStore('subscribers');
}

// The address itself is not the key. Blob keys turn up in logs and listings,
// and a key that IS the address leaks the list to anyone who can enumerate it.
function keyFor(email) {
  return crypto.createHash('sha256').update(email.toLowerCase()).digest('hex');
}

// ── Addresses at rest ────────────────────────────────────────────────────
// Netlify already encrypts Blobs on disk. This is the layer above that: with
// LIST_KEY set, a record holds no readable address, so a bug that exposes the
// store, or a stolen admin token used to export it, yields ciphertext and not
// a mailing list. The blob key stays a hash of the address, so lookups and
// deduplication never need to decrypt anything.
//
// Set it once with a key only Netlify holds:
//   netlify env:set LIST_KEY "$(openssl rand -base64 32)"
//
// Rotating it: add LIST_KEY_2 (then _3, and so on) with a new key, deploy,
// and run the admin "rekey" action. The newest key encrypts, every key still
// set can decrypt, and rekey re-encrypts each record with the newest; after
// that the older variable can be removed. No secret is ever read back out of
// Netlify to do this, which matters because secret values can't be.
//
// Records written before the key existed keep working: readEmail() returns
// either form, and each one is re-written encrypted the next time it changes.
function listKeys() {
  const out = [];
  for (const [name, raw] of Object.entries(process.env)) {
    const m = /^LIST_KEY(?:_([0-9]{1,3}))?$/.exec(name);
    if (!m || !raw) continue;
    const key = Buffer.from(raw, 'base64');
    if (key.length === 32) out.push({ id: m[1] ? Number(m[1]) : 1, key });
  }
  return out.sort((a, b) => b.id - a.id);   // newest first
}

function encryptEmail(email) {
  const newest = listKeys()[0];
  if (!newest) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', newest.key, iv);
  const enc = Buffer.concat([cipher.update(email, 'utf8'), cipher.final()]);
  return { emailEnc: Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64'), keyId: newest.id };
}

function decryptWith(key, emailEnc) {
  try {
    const buf = Buffer.from(emailEnc, 'base64');
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
    decipher.setAuthTag(buf.subarray(12, 28));
    return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
  } catch {
    return null;   // wrong key or tampered record: never guess
  }
}

function readEmail(rec) {
  if (!rec) return null;
  if (rec.email) return rec.email;               // written before LIST_KEY
  if (!rec.emailEnc) return null;
  // The record's own key first; records from before key ids were stored
  // have none, so every key is tried.
  const keys = listKeys().sort((a, b) => (b.id === rec.keyId) - (a.id === rec.keyId));
  for (const { key } of keys) {
    const email = decryptWith(key, rec.emailEnc);
    if (email) return email;
  }
  return null;
}

function token() {
  return crypto.randomBytes(24).toString('base64url');
}

// Only what token() makes. Anything else is refused before it is looked up
// or written into a page.
const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;

// ── Confirmation email ───────────────────────────────────────────────────
const SITE = 'https://ask-danny-ai.com';
const CONFIRM_RESEND_MS = 60 * 60 * 1000;        // one confirm email an hour per address
const CONFIRM_TTL_MS = 14 * 24 * 60 * 60 * 1000;  // a link works for 14 days

// The same words whatever happened, so the reply never says whether an
// address is already on the list, and never claims an email went out when
// sending is not set up yet.
const SIGNUP_MESSAGE =
  "Thanks. We'll email you a link to confirm before sending any updates. If this address is already on the list, nothing changes.";

function sendingReady() {
  return !!(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}

async function sendConfirm(email, confirmToken) {
  if (!sendingReady()) return false;
  const link = `${SITE}/api/confirm?t=${encodeURIComponent(confirmToken)}`;
  const text = 'Tap the link to confirm you want occasional emails about Ask Danny:\n\n'
    + `${link}\n\nIf you did not ask for this, ignore this email and you will not hear from us again.\n`;
  const htmlBody = `<!doctype html><html><body style="margin:0;background:#faf8f5;padding:24px;
font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#000">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #d1d1cd;border-radius:16px;padding:32px">
  <div style="font-weight:500;margin-bottom:18px">Ask Danny</div>
  <p style="margin:0 0 20px;line-height:1.6">Tap the button to confirm you want occasional emails about Ask Danny.</p>
  <p style="margin:0 0 24px"><a href="${link}" style="display:inline-block;background:#27251e;color:#fff;
  text-decoration:none;padding:12px 20px;border-radius:999px">Confirm my email</a></p>
  <p style="margin:0;font-size:12px;color:#72706b;line-height:1.5">If you did not ask for this, ignore this
  email and you will not hear from us again.</p>
</div></body></html>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [email],
        subject: 'Confirm your Ask Danny updates', text, html: htmlBody }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// TOKEN_RE already allows only letters, digits, - and _; this is the second lock.
function escapeAttr(v) {
  return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function formField(event, name) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '');
  return new URLSearchParams(raw).get(name) || '';
}

function normalise(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (!email || email.length > MAX_EMAIL_LEN) return null;
  if (!EMAIL_RE.test(email)) return null;
  return email;
}

function ipOf(event) {
  return (event.headers['x-forwarded-for'] || '').split(',')[0].trim()
    || event.headers['client-ip'] || 'unknown';
}

async function rateLimited(event) {
  let s;
  try { s = blobStore('rate-limits'); }
  catch { return false; }  // storage unavailable: do not lock people out

  const key = `subscribe:${ipOf(event)}`;
  const now = Math.floor(Date.now() / 1000);
  let entry = null;
  try { entry = await s.get(key, { type: 'json' }); } catch { /* fresh window */ }

  if (!entry || typeof entry.windowStart !== 'number' || now - entry.windowStart > SUBSCRIBE_WINDOW) {
    entry = { count: 1, windowStart: now };
  } else if (entry.count >= SUBSCRIBE_LIMIT) {
    return true;
  } else {
    entry.count += 1;
  }
  try { await s.setJSON(key, entry); } catch { /* best effort */ }
  return false;
}

function page(title, heading, body, accent = '#016a71') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>${title} — Ask Danny</title>
<style>
  :root{color-scheme:light}
  body{margin:0;background:#faf8f5;color:#000;
       font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
       display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .card{background:#fff;border:1px solid #d1d1cd;border-radius:16px;
        padding:36px 32px;max-width:460px;width:100%}
  .mark{display:inline-flex;align-items:center;justify-content:center;
        width:44px;height:44px;border-radius:10px;background:${accent};
        color:#fff;font-weight:500;margin-bottom:18px}
  h1{font-size:24px;font-weight:500;margin:0 0 10px}
  p{margin:0 0 14px;color:#27251e}
  a{color:${accent}}
</style></head><body><div class="card">
<div class="mark">AD</div><h1>${heading}</h1>${body}
<p><a href="https://ask-danny-ai.com">Back to Ask Danny</a></p>
</div></body></html>`;
}

const html = (statusCode, body) => ({
  statusCode,
  headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  body,
});

exports.handler = async (event) => {
  connectBlobs(event);
  const cors = corsFor(event);
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: cors, body: '' };

  const path = event.path || '';
  const json = (statusCode, obj) => ({
    statusCode,
    headers: { ...cors, 'Content-Type': 'application/json' },
    body: JSON.stringify(obj),
  });

  // ── unsubscribe ──────────────────────────────────────────────────────────
  // A GET, so it works from an email client with one click and no JavaScript.
  if (path.includes('unsubscribe')) {
    const t = (event.queryStringParameters || {}).t || '';
    if (!t) return html(400, page('Unsubscribe', 'That link is incomplete',
      '<p>The unsubscribe link was missing its code. Reply to any update and we will remove you by hand.</p>'));

    let s;
    try { s = store(); } catch {
      return html(503, page('Unsubscribe', 'Something went wrong',
        '<p>We could not reach the list just now. Try the link again shortly, or reply to any update and we will remove you by hand.</p>'));
    }

    // A storage error must not be reported as a successful unsubscribe: the
    // record would stay subscribed and the next update would mail someone we
    // told was removed. Only a clean lookup that finds nothing gets the
    // generic success page.
    const failed = () => html(503, page('Unsubscribe', 'Something went wrong',
      '<p>We could not update the list just now, so you have not been removed yet. Try the link again in a few minutes, or reply to any update and we will remove you by hand.</p>'));

    let hit = null;
    try {
      const { blobs } = await s.list();
      for (const b of blobs) {
        const rec = await s.get(b.key, { type: 'json' });
        if (rec && rec.unsubToken === t) { hit = { key: b.key, rec }; break; }
      }
    } catch { return failed(); }

    if (hit) {
      hit.rec.status = 'unsubscribed';
      hit.rec.unsubscribedAt = new Date().toISOString();
      try { await s.setJSON(hit.key, hit.rec); } catch { return failed(); }
    }

    // Same page whether or not the token matched. Confirming that a token is
    // unknown tells a stranger which tokens are real.
    return html(200, page('Unsubscribed', 'You are unsubscribed',
      '<p>You will not get any more Ask Danny update emails. Service notices about your account are separate and are not affected.</p>'
      + '<p>Changed your mind? You can sign up again on the site any time.</p>'));
  }

  // ── confirm ──────────────────────────────────────────────────────────────
  // The link opens a page with a button, and only the button's POST confirms.
  // Mail security scanners open every link in an email; if the GET confirmed,
  // a scanner would sign up whoever's address someone else typed in.
  if (path.includes('confirm')) {
    const t = event.httpMethod === 'POST'
      ? formField(event, 't')
      : ((event.queryStringParameters || {}).t || '');
    const expired = () => html(200, page('Confirm', 'That link has expired',
      '<p>Confirmation links work for 14 days and only once. Sign up again on the site to get a new one.</p>'));
    if (!TOKEN_RE.test(t)) return expired();

    if (event.httpMethod !== 'POST') {
      return html(200, page('Confirm', 'Confirm your email',
        '<p>Tap the button to start getting occasional emails about Ask Danny. You can unsubscribe in one click from any email.</p>'
        + `<form method="post" action="/api/confirm"><input type="hidden" name="t" value="${escapeAttr(t)}">`
        + '<p><button type="submit" style="font:inherit;background:#27251e;color:#fff;border:0;'
        + 'border-radius:999px;padding:12px 20px;cursor:pointer">Yes, sign me up</button></p></form>'));
    }

    const failed = () => html(503, page('Confirm', 'Something went wrong',
      '<p>We could not update the list just now. Try the link again in a few minutes.</p>'));
    let s;
    try { s = store(); } catch { return failed(); }

    let hit = null;
    try {
      const { blobs } = await s.list();
      for (const b of blobs) {
        const rec = await s.get(b.key, { type: 'json' });
        if (rec && rec.status === 'pending' && rec.confirmToken === t) { hit = { key: b.key, rec }; break; }
      }
    } catch { return failed(); }

    const sentAt = hit && Date.parse(hit.rec.confirmSentAt || '');
    if (!hit || !sentAt || Date.now() - sentAt > CONFIRM_TTL_MS) return expired();

    hit.rec.status = 'subscribed';
    hit.rec.confirmedAt = new Date().toISOString();
    hit.rec.confirmIp = ipOf(event);
    delete hit.rec.confirmToken;
    try { await s.setJSON(hit.key, hit.rec); } catch { return failed(); }

    return html(200, page('Confirmed', 'You are on the list',
      '<p>Thanks for confirming. We will only email about Ask Danny, and every email has a one-click unsubscribe link.</p>'));
  }

  // ── admin export ─────────────────────────────────────────────────────────
  if (path.includes('subscribers')) {
    const admin = process.env.ADMIN_TOKEN;
    const given = (event.headers['x-admin-token'] || '').trim();
    // Rejecting when unconfigured is the safe direction: an empty env var must
    // not become a password of "".
    if (!admin || !given || given.length !== admin.length
        || !crypto.timingSafeEqual(Buffer.from(given), Buffer.from(admin))) {
      return json(404, { error: 'Not found' });
    }

    if (event.httpMethod === 'POST') return adminAction(event, json);

    // ?diag=1 does a write/read round trip and reports the real error.
    // Every other caller gets a generic message, which is right for users and
    // useless for debugging — this is the way back in.
    if ((event.queryStringParameters || {}).diag) {
      const probe = { at: new Date().toISOString() };
      const keys = listKeys();
      const steps = {
        encryptionAtRest: keys.length ? `on, newest key ${keys[0].id} of [${keys.map(k => k.id).join(', ')}]` : 'off (set LIST_KEY)',
        sending: sendingReady() ? 'on' : 'off (set RESEND_API_KEY and MAIL_FROM)',
      };
      // Field names only, never values: the payload holds a Blobs token.
      try {
        steps.contextFields = event.blobs
          ? Object.keys(JSON.parse(Buffer.from(event.blobs, 'base64').toString('utf8'))).join(',')
          : 'none';
      } catch (e) { steps.contextFields = `unreadable: ${e.name}`; }

      try {
        const t = store();
        steps.getStore = 'ok';
        await t.setJSON('__diag', probe);
        steps.write = 'ok';
        const back = await t.get('__diag', { type: 'json' });
        steps.read = back && back.at === probe.at ? 'ok' : `mismatch: ${JSON.stringify(back)}`;
        // This is the real subscriber store, so the probe must not stay behind
        // and show up in the export as a subscriber.
        await t.delete('__diag');
        steps.delete = 'ok';
        const { blobs } = await t.list();
        steps.list = `${blobs.length} keys`;
      } catch (e) {
        steps.error = `${e.name}: ${e.message}`.slice(0, 300);
      }
      return json(200, { diag: steps });
    }

    let s;
    try { s = store(); } catch { return json(503, { error: 'Store unavailable' }); }

    const out = [];
    try {
      const { blobs } = await s.list();
      for (const b of blobs) {
        const rec = await s.get(b.key, { type: 'json' });
        if (rec) out.push({
          email: readEmail(rec) || '(encrypted: LIST_KEY missing or rotated)',
          status: rec.status, source: rec.source,
          createdAt: rec.createdAt, confirmedAt: rec.confirmedAt, unsubscribedAt: rec.unsubscribedAt,
        });
      }
    } catch { return json(503, { error: 'Could not read the list' }); }

    out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    return json(200, {
      total: out.length,
      active: out.filter(r => r.status === 'subscribed').length,
      pending: out.filter(r => r.status === 'pending').length,
      subscribers: out,
    });
  }

  // ── subscribe ────────────────────────────────────────────────────────────
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid request.' }); }

  if (body.consent !== true) {
    return json(400, { error: 'Please tick the box to confirm you want these emails.' });
  }

  const email = normalise(body.email);
  if (!email) return json(400, { error: 'That does not look like an email address.' });

  if (await rateLimited(event)) {
    return json(429, { error: 'Too many sign-ups from this connection. Try again later.' });
  }

  let s;
  try { s = store(); }
  catch { return json(503, { error: 'Could not save that just now. Try again shortly.' }); }

  const key = keyFor(email);
  let existing = null;
  try { existing = await s.get(key, { type: 'json' }); } catch { /* treat as new */ }

  // Already confirmed: nothing to do, and the reply is the same as for a new
  // address, so it cannot be used to test who is on the list.
  if (existing && existing.status === 'subscribed') return json(200, { ok: true, message: SIGNUP_MESSAGE });

  // New, pending or previously unsubscribed: (re)start as pending. A pending
  // record keeps its confirm token and send time, so signing up again does
  // not mint a new link or mail the person more than once an hour.
  const now = new Date().toISOString();
  const pending = existing && existing.status === 'pending' ? existing : null;
  const encrypted = encryptEmail(email);
  const record = {
    ...(encrypted || { email }),
    status: 'pending',
    source: String(body.source || 'site').slice(0, 40),
    consentText: CONSENT_TEXT,
    createdAt: (pending && pending.createdAt) || now,
    consentedAt: now,
    consentIp: ipOf(event),
    unsubToken: (existing && existing.unsubToken) || token(),
    confirmToken: (pending && pending.confirmToken) || token(),
  };
  if (pending && pending.confirmSentAt) record.confirmSentAt = pending.confirmSentAt;

  try { await s.setJSON(key, record); }
  catch { return json(503, { error: 'Could not save that just now. Try again shortly.' }); }

  const lastSent = Date.parse(record.confirmSentAt || '') || 0;
  if (Date.now() - lastSent > CONFIRM_RESEND_MS && await sendConfirm(email, record.confirmToken)) {
    record.confirmSentAt = new Date().toISOString();
    try { await s.setJSON(key, record); } catch { /* the email went; the cooldown is best effort */ }
  }

  return json(200, { ok: true, message: SIGNUP_MESSAGE });
};

// ── Admin actions ─────────────────────────────────────────────────────────
//   { "action": "rekey" }  re-encrypt every record with the newest LIST_KEY
//   { "action": "send-confirmations", "dryRun": false }
//                          email a confirm link to every pending address that
//                          never got one (sign-ups from before sending was set up)
async function adminAction(event, json) {
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(400, { error: 'Invalid JSON.' }); }

  let s;
  try { s = store(); } catch { return json(503, { error: 'Store unavailable' }); }
  let blobs;
  try { ({ blobs } = await s.list()); } catch { return json(503, { error: 'Could not read the list' }); }

  if (body.action === 'rekey') {
    const newest = listKeys()[0];
    if (!newest) return json(400, { error: 'No LIST_KEY is set, so there is nothing to encrypt with.' });
    const counts = { rekeyed: 0, alreadyCurrent: 0, unreadable: 0 };
    for (const b of blobs) {
      let rec;
      try { rec = await s.get(b.key, { type: 'json' }); } catch { counts.unreadable++; continue; }
      if (!rec) continue;
      if (!rec.email && rec.keyId === newest.id) { counts.alreadyCurrent++; continue; }
      const email = readEmail(rec);
      if (!email) { counts.unreadable++; continue; }   // left exactly as it was
      const enc = encryptEmail(email);
      delete rec.email;
      Object.assign(rec, enc);
      try { await s.setJSON(b.key, rec); counts.rekeyed++; } catch { counts.unreadable++; }
    }
    return json(200, { newestKey: newest.id, ...counts,
      next: counts.unreadable
        ? 'Some records could not be read with any key that is set. Keep the old LIST_KEY variables until they are dealt with.'
        : `Every record now uses key ${newest.id}. Older LIST_KEY variables can be removed.` });
  }

  if (body.action === 'send-confirmations') {
    const due = [];
    for (const b of blobs) {
      const rec = await s.get(b.key, { type: 'json' }).catch(() => null);
      if (rec && rec.status === 'pending' && !rec.confirmSentAt && TOKEN_RE.test(rec.confirmToken || '')) due.push({ key: b.key, rec });
    }
    if (body.dryRun !== false) {
      return json(200, { dryRun: true, wouldSend: due.length, note: 'Nothing was sent. Pass "dryRun": false to send.' });
    }
    if (!sendingReady()) return json(503, { error: 'Sending is not configured yet.', needs: ['RESEND_API_KEY', 'MAIL_FROM'] });
    let sent = 0, failed = 0;
    for (const { key, rec } of due) {
      const email = readEmail(rec);
      if (email && await sendConfirm(email, rec.confirmToken)) {
        rec.confirmSentAt = new Date().toISOString();
        await s.setJSON(key, rec).catch(() => {});
        sent++;
      } else failed++;
    }
    return json(200, { dryRun: false, sent, failed });
  }

  return json(400, { error: 'Unknown action. Use "rekey" or "send-confirmations".' });
}

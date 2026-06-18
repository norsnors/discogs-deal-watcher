'use strict';
/*
 * mailer.js — Gmail (app-password) email via nodemailer, plus the deal-email renderer.
 *
 * Gmail app-password = SMTP, so this needs a Node host that can open 465/587 outbound
 * (works on a VPS / Fly.io / Railway; does NOT work on Cloudflare Workers).
 *
 * renderDealsEmail() is pure (no nodemailer) so it's unit-testable on its own.
 */

function fmtPrice(v, currency = 'EUR') {
  if (v == null) return '—';
  const sym = { EUR: '€', USD: '$', GBP: '£' }[currency] || '';
  return `${sym}${Number(v).toFixed(2)}`;
}
const pct = (d) => (d == null ? '—' : `${Math.round(d * 100)}%`);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const REF_LABEL = {
  'sold-median': 'real sold price',
  suggestion: 'VG+ suggested price',
  'trailing-median': 'its usual lowest price',
};

function dealLine(d) {
  const ref = `${fmtPrice(d.reference, d.currency)} (${REF_LABEL[d.referenceSource] || 'reference'})`;
  const flags = [];
  // 🆕 just listed is the highest-value live signal — a copy that appeared since the last sweep — so
  // it leads. When the reference is the REAL sold price the deal is high-trust; against the VG+
  // suggestion it's an estimate to verify on the page.
  if (d.freshListing) flags.push('🆕 just listed');
  if (d.referenceSource !== 'sold-median') flags.push('≈ value is Discogs’ estimate — confirm on the page');
  // The cloud (API-only) path can't see condition, so the only honest condition signal is the
  // price-proxy "suspiciously low" flag. (The 0/2–2/2 "confidence" number was just reference
  // agreement, not condition, and read as meaningless — dropped.)
  if (d.suspicious) flags.push('⚠ may be below VG+ — verify condition on the page');
  return { ref, flags, title: `${d.artist ? d.artist + ' – ' : ''}${d.title || 'release ' + d.releaseId}` };
}

// deals: array of deal records. Returns { subject, text, html }.
function renderDealsEmail(deals) {
  const n = deals.length;
  const first = deals[0];
  const fl = dealLine(first);
  const subject = n === 1
    ? `💸 Discogs deal: ${fl.title} — ${fmtPrice(first.lowest, first.currency)} (${pct(first.discount)} off)`
    : `💸 ${n} Discogs deals — incl. ${fl.title} (${pct(first.discount)} off)`;

  const textRows = deals.map((d) => {
    const l = dealLine(d);
    return [
      `• ${l.title}`,
      `  ${fmtPrice(d.lowest, d.currency)}  (${pct(d.discount)} under ${l.ref})  ·  ${d.numForSale} for sale`,
      l.flags.length ? `  ${l.flags.join('  ·  ')}` : null,
      `  Buy: ${d.url}`,
    ].filter(Boolean).join('\n');
  });
  const text = `${n} deal${n > 1 ? 's' : ''} from your Discogs wantlist:\n\n${textRows.join('\n\n')}\n`;

  const cards = deals.map((d) => {
    const l = dealLine(d);
    const flagsHtml = l.flags.length
      ? `<div style="font-size:12px;color:#8a6d00;margin-top:4px">${esc(l.flags.join('  ·  '))}</div>` : '';
    const thumb = d.thumb
      ? `<img src="${esc(d.thumb)}" alt="" width="64" height="64" style="border-radius:6px;object-fit:cover;margin-right:12px">` : '';
    return `
      <tr><td style="padding:14px 0;border-bottom:1px solid #eee">
        <table role="presentation" width="100%"><tr>
          <td width="64" valign="top">${thumb}</td>
          <td valign="top">
            <div style="font-size:16px;font-weight:600;color:#111">${esc(l.title)}</div>
            <div style="margin:6px 0">
              <span style="font-size:20px;font-weight:700;color:#1a7f37">${esc(fmtPrice(d.lowest, d.currency))}</span>
              <span style="font-size:13px;color:#555;margin-left:8px">${esc(pct(d.discount))} under ${esc(l.ref)}</span>
            </div>
            <div style="font-size:12px;color:#666">${esc(String(d.numForSale ?? '?'))} copies for sale</div>
            ${flagsHtml}
            <a href="${esc(d.url)}" style="display:inline-block;margin-top:10px;background:#1a7f37;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:14px;font-weight:600">View &amp; buy on Discogs →</a>
          </td>
        </tr></table>
      </td></tr>`;
  }).join('');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
    <h2 style="font-size:18px;margin:0 0 4px">${n} Discogs wantlist deal${n > 1 ? 's' : ''}</h2>
    <p style="font-size:12px;color:#888;margin:0 0 12px">Condition isn't exposed by the Discogs API — always check the copy's grade on the page before buying.</p>
    <table role="presentation" width="100%">${cards}</table>
  </div>`;

  return { subject, text, html };
}

const RESEND_DEFAULT_FROM = 'Discogs Deal Watcher <onboarding@resend.dev>';

// Pure: the JSON body sent to the Resend API. Exported for testing.
function buildResendPayload(cfg, mail) {
  const payload = {
    from: cfg.from || RESEND_DEFAULT_FROM,
    to: Array.isArray(cfg.to) ? cfg.to : [cfg.to],
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
  };
  // A reply-to (e.g. your own address) lets you reply to a deal mail and helps some inbox providers
  // treat the message as legitimate — a small deliverability nudge while sending from the sandbox.
  if (cfg.replyTo) payload.reply_to = cfg.replyTo;
  return payload;
}

function disabledMailer(provider, why) {
  const off = async () => { throw new Error(`mailer disabled: ${why}`); };
  return { enabled: false, provider, send: off, sendDeals: off, async verify() { return false; } };
}

// Resend (HTTP API) — no SMTP, so it works anywhere (Node host, Cloudflare Workers,
// GitHub Actions) and needs only an API key, never a Gmail password.
function resendMailer(cfg) {
  if (!cfg.apiKey || !cfg.to) return disabledMailer('resend', 'need email.apiKey + email.to');
  const fetchImpl = cfg.fetch || globalThis.fetch;
  async function post(mail) {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildResendPayload(cfg, mail)),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Resend ${res.status}: ${body.slice(0, 200)}`);
    try { return JSON.parse(body); } catch { return { raw: body }; }
  }
  return {
    enabled: true,
    provider: 'resend',
    async verify() { return true; }, // no verify endpoint; the key is validated on first send
    async send(mail) { return post(mail); },
    async sendDeals(deals) { return post(renderDealsEmail(deals)); },
  };
}

// Gmail (or any SMTP) via nodemailer + app-password. host/port/secure overridable (Ethereal in tests).
function gmailMailer(cfg) {
  const user = cfg.user;
  const pass = cfg.appPassword || cfg.pass;
  if (!user || !pass) return disabledMailer('gmail', 'need email.user + app-password');
  const nodemailer = require('nodemailer'); // lazy: only this path needs the dep
  const port = cfg.port || 465;
  const transport = nodemailer.createTransport({
    host: cfg.host || 'smtp.gmail.com', port,
    secure: cfg.secure != null ? cfg.secure : port === 465,
    auth: { user, pass },
  });
  const to = cfg.to || user;
  const from = cfg.from || `Discogs Deal Watcher <${user}>`;
  const replyTo = cfg.replyTo || undefined;
  return {
    enabled: true,
    provider: 'gmail',
    transport,
    async verify() { return transport.verify(); },
    async send({ subject, text, html }) { return transport.sendMail({ from, to, replyTo, subject, text, html }); },
    async sendDeals(deals) { const m = renderDealsEmail(deals); return transport.sendMail({ from, to, replyTo, ...m }); },
  };
}

/*
 * makeMailer(cfg) — picks the provider:
 *   cfg.provider 'resend' | 'gmail', or inferred (apiKey -> resend, user+password -> gmail).
 * Resend is the recommended default (no Gmail password; works from any host).
 */
function makeMailer(cfg = {}) {
  const provider = cfg.provider || (cfg.apiKey ? 'resend' : ((cfg.user && (cfg.appPassword || cfg.pass)) ? 'gmail' : null));
  if (provider === 'resend') return resendMailer(cfg);
  if (provider === 'gmail') return gmailMailer(cfg);
  return disabledMailer(null, 'set email.provider + credentials');
}

module.exports = { makeMailer, renderDealsEmail, buildResendPayload, fmtPrice };

// --- tiny self-test (node mailer.js --selftest) ----------------------------
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');
  const m = renderDealsEmail([
    { releaseId: 1, artist: 'Imagination', title: 'Night Dubbing', lowest: 8, currency: 'EUR', reference: 30, referenceSource: 'sold-median', discount: 0.73, numForSale: 12, freshListing: true, suspicious: false, url: 'https://www.discogs.com/sell/release/1?sort=price%2Casc' },
    { releaseId: 2, artist: 'Klein & MBO', title: 'Dirty Talk', lowest: 4, currency: 'EUR', reference: 25, referenceSource: 'trailing-median', discount: 0.84, numForSale: 3, suspicious: true, url: 'https://www.discogs.com/sell/release/2?sort=price%2Casc' },
  ]);
  assert.ok(/2 Discogs deals/.test(m.subject), 'subject counts deals');
  assert.ok(/Imagination/.test(m.html) && /Dirty Talk/.test(m.html), 'both deals rendered');
  assert.ok(/may be below VG\+/.test(m.html), 'suspicious flag shown');
  assert.ok(/just listed/.test(m.html), 'fresh-listing flag shown (the live signal)');
  assert.ok(/real sold price/.test(m.html), 'a sold-median deal is labelled "real sold price"');
  assert.ok(/estimate/.test(m.text), 'a non-sold-median deal warns the value is an estimate');
  assert.ok(/€8\.00/.test(m.html) && /€4\.00/.test(m.html), 'prices formatted');
  assert.ok(m.text.includes('Buy: https://www.discogs.com/sell/release/1'), 'text has buy link');

  // A deal judged against the REAL sold price is high-trust: no "estimate, confirm" caveat.
  const trusted = renderDealsEmail([{ releaseId: 9, artist: 'A', title: 'B', lowest: 10, currency: 'EUR', reference: 40, referenceSource: 'sold-median', discount: 0.75, numForSale: 2, url: 'https://x' }]);
  assert.ok(!/estimate/.test(trusted.text), 'a sold-median (real) deal omits the estimate caveat');
  assert.ok(/real sold price/.test(trusted.text), 'and is labelled against the real sold price');

  // disabled mailer (no creds)
  assert.strictEqual(makeMailer({}).enabled, false);
  assert.strictEqual(makeMailer({ provider: 'resend' }).enabled, false, 'resend needs apiKey + to');

  // Resend payload shape.
  const payload = buildResendPayload({ apiKey: 'x', to: 'me@gmail.com' }, { subject: 'S', html: '<b>H</b>', text: 'T' });
  assert.deepStrictEqual(payload.to, ['me@gmail.com'], 'to is wrapped in an array');
  assert.ok(/onboarding@resend\.dev/.test(payload.from), 'default from is the Resend sandbox sender');
  assert.ok(!('reply_to' in payload), 'no reply_to unless configured');
  const payloadRt = buildResendPayload({ apiKey: 'x', to: 'me@gmail.com', replyTo: 'me@gmail.com' }, { subject: 'S', html: 'H', text: 'T' });
  assert.strictEqual(payloadRt.reply_to, 'me@gmail.com', 'replyTo maps to the Resend reply_to field');

  // Resend send via fake fetch: asserts URL, auth header, and body.
  (async () => {
    let captured = null;
    const fakeFetch = async (url, init) => { captured = { url, init }; return { ok: true, status: 200, text: async () => '{"id":"abc"}' }; };
    const rm = makeMailer({ provider: 'resend', apiKey: 'RKEY', to: 'riminiexpressdj@gmail.com', fetch: fakeFetch });
    assert.ok(rm.enabled && rm.provider === 'resend');
    const res = await rm.sendDeals([{ releaseId: 1, artist: 'A', title: 'B', lowest: 5, currency: 'EUR', reference: 20, referenceSource: 'suggestion', discount: 0.75, numForSale: 3, confidence: 2, url: 'https://x' }]);
    assert.strictEqual(res.id, 'abc', 'returns parsed Resend response');
    assert.strictEqual(captured.url, 'https://api.resend.com/emails');
    assert.strictEqual(captured.init.headers.Authorization, 'Bearer RKEY');
    const sent = JSON.parse(captured.init.body);
    assert.deepStrictEqual(sent.to, ['riminiexpressdj@gmail.com']);
    assert.ok(/A – B/.test(sent.subject), 'subject built from the deal');
    console.log('mailer selftest: all assertions passed');
  })().catch((e) => { console.error('FAILED:', e.stack || e); process.exit(1); });
}

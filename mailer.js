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

// "2026-05-24" -> "May '26". No date library (mirrors the rest of the codebase's dependency-free
// style) and locale-independent (unlike Date#toLocaleString, which needs ICU data present).
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDateShort(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return '';
  const mon = MONTHS[parseInt(m[2], 10) - 1];
  return mon ? `${mon} '${m[1].slice(-2)}` : '';
}

// A rare/appreciating record's actual recent sales (last 10, <=2yr — scraped locally from Discogs'
// Sales History page) are a far better value signal than one blended median (which mixes in
// decade-old sales at old prices). Used only for the 💎 gem display — the deal-threshold engine is
// untouched. null/empty when the release was never scraped (or scraped before the sales-history
// login was set up) -> callers fall back to refLine().
function recentSalesText(g) {
  if (!Array.isArray(g.recentSales) || !g.recentSales.length) return null;
  const items = g.recentSales.map((s) => `${fmtPrice(s.price, g.currency)}${s.date ? ` (${fmtDateShort(s.date)})` : ''}`);
  return `recent sales, last ${items.length} in ~2yr: ${items.join(', ')}`;
}
function recentSalesHtml(g) {
  if (!Array.isArray(g.recentSales) || !g.recentSales.length) return '';
  const chips = g.recentSales.map((s) => `<span style="display:inline-block;margin:2px 6px 2px 0;padding:2px 8px;background:#f3f0ff;border-radius:10px;font-size:12px;color:#5b21b6">${esc(fmtPrice(s.price, g.currency))}${s.date ? `<span style="color:#9333ea"> · ${esc(fmtDateShort(s.date))}</span>` : ''}</span>`).join('');
  return `<div style="margin-top:6px"><div style="font-size:11px;color:#888;margin-bottom:3px">Recent sales (last ${g.recentSales.length}, &le;2 yrs)</div><div>${chips}</div></div>`;
}

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

/*
 * renderGemsEmail(gems) — the RARE-GEM alert: a wantlist release that had ZERO copies for sale just
 * got its first one. Price is deliberately NOT a gate here (the whole point: for a truly rare record
 * you want to know the moment ANY copy surfaces, at any price) — so the email leads with the event,
 * shows the asking price plainly, and adds the reference value only as context.
 */
function renderGemsEmail(gems) {
  const n = gems.length;
  const first = gems[0];
  const title = (g) => `${g.artist ? g.artist + ' – ' : ''}${g.title || 'release ' + g.releaseId}`;
  const subject = n === 1
    ? `💎 Rare find: ${title(first)} — first copy for sale (${fmtPrice(first.lowest, first.currency)})`
    : `💎 ${n} rare wantlist records just became available`;

  const refLine = (g) => (g.reference != null
    ? `worth ~${fmtPrice(g.reference, g.currency)} (${REF_LABEL[g.referenceSource] || 'reference'})`
    : null);
  // Prefer the real recent-sales list when we have it (better value signal for a rare record);
  // fall back to the single blended reference when the release hasn't been scraped yet.
  const valueLine = (g) => recentSalesText(g) || refLine(g);

  const textRows = gems.map((g) => [
    `• ${title(g)}`,
    `  Had NO copies for sale — ${g.numForSale === 1 ? 'one just appeared' : g.numForSale + ' just appeared'} at ${fmtPrice(g.lowest, g.currency)}${valueLine(g) ? `  ·  ${valueLine(g)}` : ''}`,
    `  Buy: ${g.url}`,
  ].join('\n'));
  const text = `${n} rare record${n > 1 ? 's' : ''} from your wantlist just became available (previously ZERO for sale):\n\n${textRows.join('\n\n')}\n\nRare copies sell fast — check them now. Condition/price are unfiltered by design.\n`;

  const cards = gems.map((g) => {
    const thumb = g.thumb
      ? `<img src="${esc(g.thumb)}" alt="" width="64" height="64" style="border-radius:6px;object-fit:cover;margin-right:12px">` : '';
    const ref = recentSalesHtml(g) || (refLine(g) ? `<div style="font-size:12px;color:#666">${esc(refLine(g))}</div>` : '');
    return `
      <tr><td style="padding:14px 0;border-bottom:1px solid #eee">
        <table role="presentation" width="100%"><tr>
          <td width="64" valign="top">${thumb}</td>
          <td valign="top">
            <div style="font-size:16px;font-weight:600;color:#111">${esc(title(g))}</div>
            <div style="font-size:13px;color:#7c3aed;font-weight:600;margin:4px 0">💎 Had 0 copies for sale — ${g.numForSale === 1 ? 'the first one' : esc(String(g.numForSale)) + ' copies'} just appeared</div>
            <div style="margin:6px 0">
              <span style="font-size:20px;font-weight:700;color:#111">${esc(fmtPrice(g.lowest, g.currency))}</span>
              <span style="font-size:12px;color:#888;margin-left:8px">asking price — unfiltered</span>
            </div>
            ${ref}
            <a href="${esc(g.url)}" style="display:inline-block;margin-top:10px;background:#7c3aed;color:#fff;text-decoration:none;padding:8px 16px;border-radius:6px;font-size:14px;font-weight:600">View &amp; buy on Discogs →</a>
          </td>
        </tr></table>
      </td></tr>`;
  }).join('');

  const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#111">
    <h2 style="font-size:18px;margin:0 0 4px">💎 ${n} rare wantlist record${n > 1 ? 's' : ''} now for sale</h2>
    <p style="font-size:12px;color:#888;margin:0 0 12px">These releases had ZERO copies for sale until now. Price and condition are unfiltered — rare copies sell fast, so judge quickly.</p>
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
  return { enabled: false, provider, send: off, sendDeals: off, sendGems: off, async verify() { return false; } };
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
    async sendGems(gems) { return post(renderGemsEmail(gems)); },
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
    async sendGems(gems) { const m = renderGemsEmail(gems); return transport.sendMail({ from, to, replyTo, ...m }); },
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

// dealLine/recentSalesText are shared with telegram.js so both channels render identical
// flags/labels/value-lines for a deal or gem.
module.exports = { makeMailer, renderDealsEmail, renderGemsEmail, buildResendPayload, fmtPrice, dealLine, recentSalesText, fmtDateShort };

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

  // --- rare-gem email ---
  const gm = renderGemsEmail([
    { releaseId: 7, artist: 'Mr. Flagio', title: 'Take A Chance', lowest: 85, currency: 'EUR', numForSale: 1, reference: 120, referenceSource: 'sold-median', url: 'https://www.discogs.com/sell/release/7?sort=price%2Casc' },
  ]);
  assert.ok(/💎 Rare find: Mr\. Flagio – Take A Chance/.test(gm.subject), 'single-gem subject leads with the record');
  assert.ok(/first copy for sale/.test(gm.subject), 'subject says the first copy appeared');
  assert.ok(/€85\.00/.test(gm.html), 'asking price shown');
  assert.ok(/ZERO copies for sale/.test(gm.html), 'html explains the zero -> first-copy event');
  assert.ok(/worth ~€120\.00/.test(gm.text), 'reference shown as context, not a gate');
  assert.ok(gm.text.includes('Buy: https://www.discogs.com/sell/release/7'), 'gem text has buy link');
  const gm2 = renderGemsEmail([
    { releaseId: 1, artist: 'A', title: 'X', lowest: 10, currency: 'EUR', numForSale: 2, url: 'https://x' },
    { releaseId: 2, artist: 'B', title: 'Y', lowest: 20, currency: 'EUR', numForSale: 1, url: 'https://y' },
  ]);
  assert.ok(/💎 2 rare wantlist records/.test(gm2.subject), 'multi-gem subject counts');
  assert.ok(/2 just appeared/.test(gm2.text), 'multi-copy appearance phrased with the count');

  // --- rare-gem email: recent sales list replaces the single reference line when we have it ---
  assert.strictEqual(fmtDateShort('2026-05-24'), "May '26", 'date shortened to "Mon \'YY"');
  assert.strictEqual(fmtDateShort(''), '', 'unparseable date -> empty string, not a throw');
  const gm3 = renderGemsEmail([
    {
      releaseId: 3, artist: 'Vinicio', title: 'Dance You And Me', lowest: 79.99, currency: 'EUR', numForSale: 1,
      reference: 45, referenceSource: 'sold-median', url: 'https://x',
      recentSales: [{ date: '2026-05-24', price: 165, media: 'NM' }, { date: '2025-07-27', price: 100, media: 'VG' }],
    },
  ]);
  assert.ok(/recent sales, last 2 in ~2yr: €165\.00 \(May '26\), €100\.00 \(Jul '25\)/.test(gm3.text), 'recent sales list replaces the "worth ~X" line');
  assert.ok(!/worth ~/.test(gm3.text), 'the single-reference line is dropped when recent sales are available');
  assert.ok(/Recent sales \(last 2, &le;2 yrs\)/.test(gm3.html), 'html shows the recent-sales heading');
  assert.ok(/€165\.00/.test(gm3.html) && /€100\.00/.test(gm3.html), 'both recent sale prices rendered in html');

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

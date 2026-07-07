'use strict';
/*
 * telegram.js — the push channel next to email: sends the same deal/gem alerts to a Telegram chat
 * via the Bot API (plain HTTPS fetch, no dependencies — works on GitHub Actions and any Node host).
 *
 * WHY: email is the primary, loudly-guarded product (a failed send exits non-zero), but while the
 * Resend sandbox sender is in use a deal mail can land in spam = silent total failure. Telegram has
 * no spam folder and buzzes a phone within seconds, so it runs as the REDUNDANT second channel:
 * best-effort, never fails the run (email keeps that job), and it fires even when the email send
 * errors — that's the whole point of redundancy.
 *
 * OFF unless both botToken + chatId are configured (env TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID, or
 * config.json `telegram: { botToken, chatId }`). Setup: create a bot via @BotFather, send it /start,
 * read your chat id from getUpdates. See README "Telegram push".
 *
 * render*Messages() are pure (unit-tested); messages use Telegram HTML parse mode and are split
 * under the API's 4096-char limit on alert boundaries (never mid-block, so tags stay balanced).
 */

const { fmtPrice, dealLine } = require('./mailer');

const TG_SAFE = 3900; // stay under Telegram's hard 4096-char/message API limit

const esc = (s) => String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const pct = (d) => (d == null ? '—' : `${Math.round(d * 100)}%`);

// One deal as a Telegram-HTML block. Copy/flags come from mailer.dealLine so the two channels can
// never drift apart in what they claim about a deal.
function dealBlock(d) {
  const l = dealLine(d);
  const lines = [
    `<b>${esc(l.title)}</b>`,
    `<b>${esc(fmtPrice(d.lowest, d.currency))}</b> — ${esc(pct(d.discount))} under ${esc(l.ref)} · ${esc(String(d.numForSale ?? '?'))} for sale`,
  ];
  if (l.flags.length) lines.push(esc(l.flags.join(' · ')));
  lines.push(`<a href="${esc(d.url)}">View &amp; buy on Discogs →</a>`);
  return lines.join('\n');
}

function gemBlock(g) {
  const title = `${g.artist ? g.artist + ' – ' : ''}${g.title || 'release ' + g.releaseId}`;
  const ref = g.reference != null ? ` · worth ~${esc(fmtPrice(g.reference, g.currency))}` : '';
  return [
    `<b>${esc(title)}</b>`,
    `Had 0 copies for sale — ${g.numForSale === 1 ? 'the first one' : esc(String(g.numForSale)) + ' copies'} just appeared`,
    `<b>${esc(fmtPrice(g.lowest, g.currency))}</b> asking — unfiltered${ref}`,
    `<a href="${esc(g.url)}">View &amp; buy on Discogs →</a>`,
  ].join('\n');
}

// Greedy-pack blocks into messages under TG_SAFE, splitting only on block boundaries (a block is
// ~300 chars, so a block never exceeds the limit by itself). Only the first message carries the header.
function chunkMessages(header, blocks) {
  const msgs = [];
  let cur = header;
  for (const b of blocks) {
    if (cur.length + 2 + b.length > TG_SAFE && cur !== header) { msgs.push(cur); cur = b; }
    else cur = `${cur}\n\n${b}`;
  }
  msgs.push(cur);
  return msgs;
}

function renderDealsMessages(deals) {
  const n = deals.length;
  const header = `💸 <b>${n} Discogs wantlist deal${n > 1 ? 's' : ''}</b>`;
  return chunkMessages(header, deals.map(dealBlock));
}

function renderGemsMessages(gems) {
  const n = gems.length;
  const header = n === 1
    ? '💎 <b>Rare find — first copy for sale</b>'
    : `💎 <b>${n} rare wantlist records just became available</b>`;
  return chunkMessages(header, gems.map(gemBlock));
}

function disabledTelegram(why) {
  const off = async () => { throw new Error(`telegram disabled: ${why}`); };
  return { enabled: false, send: off, sendDeals: off, sendGems: off };
}

/*
 * makeTelegram({ botToken, chatId, fetch? }) — mirrors makeMailer's shape: { enabled, send,
 * sendDeals, sendGems }. `fetch` is injectable for tests.
 */
function makeTelegram(cfg = {}) {
  if (!cfg.botToken || !cfg.chatId) return disabledTelegram('need telegram.botToken + telegram.chatId');
  const fetchImpl = cfg.fetch || globalThis.fetch;
  async function send(text) {
    const res = await fetchImpl(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: cfg.chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    });
    const body = await res.text();
    if (!res.ok) throw new Error(`Telegram ${res.status}: ${body.slice(0, 200)}`);
    try { return JSON.parse(body); } catch { return { raw: body }; }
  }
  async function sendAll(msgs) { const out = []; for (const m of msgs) out.push(await send(m)); return out; }
  return {
    enabled: true,
    send,
    async sendDeals(deals) { return sendAll(renderDealsMessages(deals)); },
    async sendGems(gems) { return sendAll(renderGemsMessages(gems)); },
  };
}

module.exports = { makeTelegram, renderDealsMessages, renderGemsMessages, chunkMessages };

// --- tiny self-test (node telegram.js --selftest) ---------------------------
if (require.main === module && process.argv.includes('--selftest')) {
  const assert = require('assert');

  const deal = (over = {}) => ({
    releaseId: 1, artist: 'Imagination', title: 'Night Dubbing', lowest: 8, currency: 'EUR',
    reference: 30, referenceSource: 'sold-median', discount: 0.73, numForSale: 12,
    freshListing: true, suspicious: false, url: 'https://www.discogs.com/sell/release/1?sort=price%2Casc', ...over,
  });

  const [msg] = renderDealsMessages([deal(), deal({ releaseId: 2, artist: 'Klein & MBO', title: 'Dirty Talk', referenceSource: 'suggestion', suspicious: true })]);
  assert.ok(/2 Discogs wantlist deals/.test(msg), 'header counts deals');
  assert.ok(/Imagination – Night Dubbing/.test(msg) && /Dirty Talk/.test(msg), 'both deals rendered');
  assert.ok(/Klein &amp; MBO/.test(msg), 'HTML-escaped for Telegram parse_mode');
  assert.ok(/🆕 just listed/.test(msg), 'fresh-listing flag shown');
  assert.ok(/may be below VG\+/.test(msg), 'suspicious flag shown');
  assert.ok(/real sold price/.test(msg), 'sold-median reference labelled');
  assert.ok(/€8\.00/.test(msg), 'price formatted');
  assert.ok(msg.includes('href="https://www.discogs.com/sell/release/1?sort=price%2Casc"'), 'buy link present');

  const [gm] = renderGemsMessages([{ releaseId: 7, artist: 'Mr. Flagio', title: 'Take A Chance', lowest: 85, currency: 'EUR', numForSale: 1, reference: 120, referenceSource: 'sold-median', url: 'https://x' }]);
  assert.ok(/💎/.test(gm) && /first copy for sale/.test(gm), 'gem header leads with the event');
  assert.ok(/Had 0 copies for sale — the first one just appeared/.test(gm), 'zero->first phrasing');
  assert.ok(/€85\.00.*asking — unfiltered/.test(gm), 'asking price unfiltered');
  assert.ok(/worth ~€120\.00/.test(gm), 'reference as context');

  // Chunking: 40 deals must split into multiple messages, each under the limit, header on the first.
  const many = renderDealsMessages(Array.from({ length: 40 }, (_, i) => deal({ releaseId: i, title: `Release ${i} — a fairly long title to bulk the block up somewhat`, url: `https://www.discogs.com/sell/release/${i}?sort=price%2Casc` })));
  assert.ok(many.length > 1, 'long deal lists split into multiple messages');
  assert.ok(many.every((m) => m.length <= 4096), 'every message under the Telegram limit');
  assert.ok(/40 Discogs wantlist deals/.test(many[0]) && !/40 Discogs wantlist deals/.test(many[1]), 'header only on the first message');
  const totalBlocks = many.join('\n\n').match(/View &amp; buy on Discogs/g).length;
  assert.strictEqual(totalBlocks, 40, 'no deal lost in the split');

  // disabled without creds
  assert.strictEqual(makeTelegram({}).enabled, false);
  assert.strictEqual(makeTelegram({ botToken: 'x' }).enabled, false, 'chatId required too');

  // send via fake fetch: asserts URL, chat_id, parse_mode, and that multiple chunks = multiple posts.
  (async () => {
    const calls = [];
    const fakeFetch = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200, text: async () => '{"ok":true,"result":{"message_id":1}}' }; };
    const tg = makeTelegram({ botToken: 'BTOKEN', chatId: '12345', fetch: fakeFetch });
    assert.ok(tg.enabled);
    await tg.sendDeals([deal()]);
    assert.strictEqual(calls.length, 1);
    assert.ok(calls[0].url.startsWith('https://api.telegram.org/botBTOKEN/sendMessage'), 'bot API URL');
    assert.strictEqual(calls[0].body.chat_id, '12345');
    assert.strictEqual(calls[0].body.parse_mode, 'HTML');
    assert.ok(/Night Dubbing/.test(calls[0].body.text));

    // API error surfaces as a throw (caller logs it; never fails the run — that's email's job).
    const tgBad = makeTelegram({ botToken: 'B', chatId: '1', fetch: async () => ({ ok: false, status: 400, text: async () => 'Bad Request: chat not found' }) });
    await assert.rejects(() => tgBad.send('x'), /Telegram 400/);

    console.log('telegram selftest: all assertions passed');
  })().catch((e) => { console.error('FAILED:', e.stack || e); process.exit(1); });
}

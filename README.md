# Discogs Deal Watcher

Watches your Discogs **wantlist** and alerts you (email + desktop dashboard) when a copy is
offered **far under its median price** (e.g. ≥ 50% below) **in VG+ or better** condition, with a
direct link so you can buy it immediately.

> Status: **live.** Runs every 15 min via GitHub Actions against a real 715-release wantlist and
> emails new dips; the desktop dashboard reads the committed `deals.json` out of the box and has a
> one-click **⚡ Scan now** button that sweeps the whole wantlist locally on demand. The acquisition
> layer is API-only by necessity — see "The Cloudflare wall" below.

## The Cloudflare wall (the dominant constraint — read this first)

Discogs splits into two surfaces with very different access:

| Surface | Reachable from a plain fetch / cloud server? | Gives us |
|---|---|---|
| **`api.discogs.com`** (official API, token auth) | ✅ yes | wantlist; release metadata; per-release **lowest price + count** (`marketplace/stats`); **per-condition suggested price** (`marketplace/price_suggestions`, token required) |
| **`www.discogs.com`** (marketplace pages, RSS) | ❌ **no — Cloudflare "Just a moment…" JS challenge (403)** | the actual **listings** (per-copy condition, shipping, seller), the **direct listing link**, and the **historical sales median** |

Verified live (2026-06): `GET /marketplace/stats/249504` → `200 {num_for_sale, lowest_price}`;
every `www.discogs.com/sell/...` URL (HTML *and* RSS) → `403` Cloudflare challenge.

**Consequence:** two of the four things the goal asks for — the **historical sales median** and
**per-listing condition / shipping / direct link** — live on `www.discogs.com` and cannot be read
from a cloud server. They can only be read from a **real, logged-in browser session on a
residential IP** (the Cloudflare `cf_clearance` cookie is IP-bound, so copying cookies to a cloud
box does not work). The official API alone can detect *that something cheap exists* but not its
condition, true median, shipping, or exact listing.

This is why the deployment shape is a deliberate decision, not an afterthought.

## Decisions locked in (from `/goal` Q&A)

- **Email:** Gmail via app-password (SMTP / nodemailer). *Note: rules out Cloudflare Workers — they can't open SMTP — so the always-on piece is a Node host, not a Worker.*
- **Reference price for "too cheap":** Discogs **historical sales median** (web-page only → needs the residential scraper).
- **Sellers:** worldwide, but **item + shipping** is the price that's compared (high shipping must not disguise a "cheap" item).
- **Condition floor:** media condition **VG+ or better**.

## How it decides "much too cheap" (API-only mode)

The API can't see a listing's condition or the true sales median, so the watcher makes the best
call it can and is honest about the uncertainty:

- **Reference price** = the per-condition **VG+ suggested price** (`marketplace/price_suggestions`,
  token required). If that's unavailable, it falls back to the release's own **trailing median of
  lowest-prices** (what it has normally been selling at, learned from our own polling history).
- **Deal** = a **new low** that is **≥ `minDiscount` (default 50%)** under that reference. "New low"
  dedupe means a standing cheap copy is emailed once, not every sweep; a *further* drop re-alerts.
- **Confidence 0–2** = how many independent references (suggestion + trailing median) agree it's a
  deal. **"⚠ maybe below VG+"** is flagged when the price dips below even a VG copy's fair price —
  a hint the cheapest copy might be a low-grade copy, since the API won't tell us its condition.
- The email/dashboard link opens the release marketplace **sorted price-ascending**, so the cheap
  copy is the first row — you confirm its real condition + shipping there in one click.

### Calibration (`mode`) — why a naive rule floods you

A real run against a 715-release vinyl wantlist showed a flat "≥50% under VG+ suggestion" rule trips
on **~60% of releases**, almost all flagged "maybe <VG+" — because a wantlist nearly always has a
cheap *worn* copy sitting around, and the API hides condition. So the watcher adds a **warm-up + an
own-dip gate**:

- **Warm-up** (`warmupMin`, default 4): a release sends nothing until it's been seen a few times, so
  the watcher first *learns its normal lowest price* instead of emailing every standing cheap copy on
  the first sweep. At ~1 check/sec a release warms up within roughly an hour.
- **`mode`** (default `balanced`):
  - `balanced` — fire only when a copy is **≥`minDiscount` under the VG+ suggestion** *and* **≥`ownDropFactor` (40%) under that release's own usual lowest** (a genuine new dip). Standing cheap copies stay silent.
  - `sensitive` — fire on any copy ≥`minDiscount` under the reference (standing copies included). Misses nothing, noisier.
  - `strict` — `balanced` **and** the price is above the VG suggestion (priced like a decent-grade copy → closest to the literal "VG+ or better"). Fewest, highest-quality alerts.

### Catching *just-listed* copies faster

The whole point is to grab a bargain before someone else does, so the watcher is biased toward
**freshly-listed** copies:

- **Fresh-listing signal.** The API has no "date listed", so the only tell that a new copy appeared
  is `num_for_sale` *rising* between two checks (`engine.isFreshListing`). A copy that **just got
  listed at a new-low deal price fires in `balanced` mode even without an own-dip** — exactly the
  event we're hunting — and is tagged `🆕 just listed` in the email, the log, and the dashboard.
- **Priority sweep.** Instead of a blind round-robin, each `watch-once.js` run ranks every release by
  a **watch-score** (`engine.releaseWatchScore` = staleness + recent activity + rarity) and checks
  the highest-priority `SLICE_SIZE` first. Releases that just dropped in price, just got a new
  listing, or are rare (few copies) get re-checked far sooner, while staleness still guarantees full
  coverage over time. At `SLICE_SIZE=200`, 715 releases are fully covered every ~4 runs (~1 h) and
  hot ones every run.

### 💎 Rare gems — "there was NOTHING for sale, and now there is"

For a truly hard-to-find record the question isn't "is it cheap?" but "**is there finally a copy at
all?**". So next to the price-gated deal alerts there's a second, **price-blind** alert:

- **The event.** A wantlist release whose previous check counted **`num_for_sale = 0`** suddenly has
  ≥1 copy (`engine.isRareAppearance` — stricter than `isFreshListing`: the previous count must be a
  *known zero*). When it fires you get a separate **💎 email immediately, whatever the asking price**
  (`renderGemsEmail`), because a rare copy can sell within the hour. The email shows the asking price
  plainly plus the reference value (sold-median / VG+ suggestion) as context only.
- **No warm-up, only a cooldown.** The one prior observation *is* the warm-up (we knew it was at
  zero). The only gate is a 12 h per-release cooldown (`rareCooldownMs`) so a count flapping 0↔1 on
  Discogs' side can't re-fire the same copy every sweep; a copy that appears, sells, and is re-listed
  later alerts again — a genuinely new chance. Disable the whole feature with `rareGems: false` /
  `RARE_GEMS=0` (default on).
- **Zero-stock releases are watched hardest.** `releaseWatchScore` ranks `num_for_sale = 0` as the
  rarest of all, so if the wantlist ever outgrows `SLICE_SIZE` the zero-stock releases still get
  checked every run. The "was at zero" knowledge also survives an Actions-cache wipe (the committed
  `state-seed.json` carries each release's last count, `nf`).
- **Dashboard: the 💎 Rare gems tab.** Gem alerts render as violet cards, and below them the
  **zero-stock watch list** — every wantlist release currently at 0 copies for sale — so you can see
  what's being waited on. The cloud publishes both in a committed **`gems.json`** (next to
  `deals.json`); the local `⚡ Scan now` detects 0→1 itself too (against its own local history) and
  feeds the same tab. Deal sliders don't apply on this tab (availability is the signal, not price);
  only the search box filters.

### Finding the real diamonds (not 250 cheap commons)

A flat "≥50% off" rule on a 715-release wantlist surfaced ~250 hits — mostly cheap records where a
"deal" isn't worth the trouble. The fix is **detect permissively, filter powerfully**, never a hard
exclusion that could kill the once-in-a-lifetime steal:

- **Reference = the REAL sales-history median (the `⚡ Scan now` path).** Discogs's `price_suggestions`
  is an algorithmic guess and is often wrong, which matters because the reference sets the discount.
  The local scan instead reads the actual **Last Sold / Low / Median / High** off each release page —
  what copies *truly* trade for — via a hidden Electron `BrowserWindow` (your residential IP clears
  Cloudflare; cached a week in `state/soldmedians.json`). Discount is then computed against real
  market value, so the **outliers** stand out. Cloud (Actions) can't reach the web, so it falls back
  to the VG+ suggestion. Reference preference: `sold-median` → VG+ `suggestion` → our trailing median.
- **Value floor (`minReference`, default €25).** Skip records whose VG+ suggested price is under €25.
  This is *safe for diamonds* — a €100 record always clears it — it only removes low-value noise.
- **Shipping counts (`shippingEstimate`, default €5).** The API can't see a listing's real shipping
  (Cloudflare wall), so a configurable estimate is added to the item price and the threshold uses the
  **total** — shipping hits cheap "deals" hardest and weeds them out, while barely denting a true
  diamond (€2 + €15 ship vs a €100 record is still 83% off).
- **Implied condition, shown not excluded.** From the full per-condition suggestion ladder
  (`engine.impliedGrade`) we read what grade the cheapest copy is *priced* like — `≈ priced as VG+`
  (green) down to `≈ ≤ Good · very cheap` (amber). The crucial bit: a suspiciously-low price is **also
  exactly what a mispriced steal looks like**, so we never auto-hide it — we flag it and let you judge
  (with an optional "hide possibly worn" filter for when you don't want the gamble).
- **Dashboard sliders + sort do the rest, live.** Min value, min % off (shipping-aware), max total
  (budget), assumed shipping, "just listed", "hide possibly worn" — all re-filter the loaded deals
  instantly (no re-scan), and **Sort → Best first** ranks by a diamond-score (effective discount +
  absolute € saved + own-dip + rarity + freshness, minus a worn/suspicious penalty).

## Modules

| File | Role | Test |
|---|---|---|
| `engine.js` | pure decision logic (condition grading, `evaluateMarketSignal`, dedupe, URLs) | `node engine.js --selftest` |
| `discogs.js` | official-API client (wantlist, stats, suggestions, release), rate-limit aware | `node discogs.js --selftest` |
| `store.js` | JSON-file store (history / alert memory / suggestions / deals) | `node store.js --selftest` |
| `mailer.js` | Gmail SMTP + HTML deal-email renderer | `node mailer.js --selftest` |
| `server.js` | tiny token-protected read API for the dashboard | — |
| `watcher.js` | the paced sweep loop tying it together | `node watcher.js --itest` |
| `dashboard/` | Electron desktop dashboard (reads the cloud API) | — |

Run the whole suite: `npm run selftest`.

**Proven end-to-end with real data** (`npm run e2e`, no secrets needed): pulls a real public Discogs
wantlist, fetches real current marketplace prices, runs the real detection pipeline, and **sends a
real alert email** via a throwaway Ethereal SMTP account — printing a preview URL of the message.
(The reference baseline is the only simulated part; in production it's your token's VG+ suggestion or
the trailing median learned over time.)

## Get your credentials

1. **Discogs personal access token** — Discogs → *Settings → Developers → Generate token*. Paste as
   `token` / `DISCOGS_TOKEN`. (Also unlocks per-condition price suggestions; without it the watcher
   runs anonymously at 25 req/min and uses only the trailing-median reference.)
2. **Your Discogs username** — must own the wantlist. Wantlist is read via the API (works even if
   private, because the token authenticates you).
3. **Email sender — Resend API key (recommended, no Gmail password).** Sign up free at resend.com
   (Google login), create an API key, paste it as `email.apiKey` / `RESEND_API_KEY`. Mail is sent
   from `onboarding@resend.dev` (Resend's sandbox sender — no domain setup) to your `email.to`
   (e.g. `riminiexpressdj@gmail.com`). The key is revocable and is **not** your Gmail password.
   *Alternative:* Gmail via app-password (`email.provider: "gmail"`, `GMAIL_USER` +
   `GMAIL_APP_PASSWORD`) — needs SMTP, so only on a Node host (not Workers / GitHub Actions-friendly).
4. **Dashboard token** — invent a long random string; the watcher requires it on the API and the
   desktop app sends it. (Only needed for the live-server deployment, not the GitHub one.)

## Run locally (fastest way to try it)

```powershell
$env:PATH = [System.Environment]::GetEnvironmentVariable("PATH","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("PATH","User")
Set-Location "Z:\Claude code\discogs-deal-watcher"
Copy-Item config.example.json config.json   # then edit config.json with your values
npm install
npm start                                    # paced sweep + dashboard API on :8787
```

Then run the dashboard and point it at `http://localhost:8787`:

```powershell
Set-Location "Z:\Claude code\discogs-deal-watcher\dashboard"
npm install
npm start
```

In the dashboard's ⚙ Settings, pick source **Live server**, set URL = `http://localhost:8787` and
**Dashboard token** = your `dashboardToken`, then *Test connection*.

## The desktop dashboard

`dashboard/` is a small Electron app. Run it:

```powershell
Set-Location "Z:\Claude code\discogs-deal-watcher\dashboard"
npm install
npm start                 # dev
npm run build             # -> dist\DiscogsDeals-win32-x64\DiscogsDeals.exe (Windows .exe)
```

**Works on first launch — no setup.** It ships pointed at the public repo
`norsnors/discogs-deal-watcher` in **GitHub** mode, so it reads the committed `deals.json` straight
from the raw CDN (no token). Only open ⚙ **Settings** to change source:

- **GitHub Actions** (default): the **repo** (`owner/name`); a **GitHub access token** is needed
  *only* for a private repo (fine-grained PAT, *Contents: read-only*). Public repo → leave blank.
- **Live server** (watcher.js on Fly / localhost): enter the **Server URL** + **Dashboard token**.

It polls every 30s and gives you **live sliders + sort** to hunt the real diamonds without re-scanning
(min value / min % off / max total / assumed shipping; just-listed, hide-possibly-worn; Sort → Best
first), tags `🆕 just listed` copies and the implied condition, and shows a desktop notification on a
new deal (see "Finding the real diamonds"). The HTTP to GitHub/your server happens in the Electron
**main** process, so tokens never touch the page.

### ⚡ Scan now (local full sweep, on demand)

The green **Scan now** button is independent of the source setting: it runs a **full local sweep of
your whole wantlist right then** — using the watcher's own engine + your local `config.json` token.
Two phases: (1) a fast API pass over all releases to shortlist the cheap-looking ones, then (2) for
each of those it fetches the **real sales-history median** off the release page (hidden Electron
`BrowserWindow`, residential IP clears Cloudflare) and re-judges the discount against that true market
value. A progress bar shows count + ETA and it's cancellable. Results are GET-only — it never carts or
buys. (First scan is slowest — it caches each release's price suggestion + sold-median for a week.)

### Logo + desktop shortcut

```powershell
powershell -ExecutionPolicy Bypass -File tools\make-icon.ps1        # (re)generate assets/icon.png + icon.ico
powershell -ExecutionPolicy Bypass -File tools\install-shortcut.ps1 # put a launcher on the Desktop
```

`tools/make-icon.ps1` draws the vinyl-record / price-drop logo with GDI+ (no ImageMagick) into
`dashboard/assets/` — `logo.svg` is the in-app header art, `icon.png` the window icon, `icon.ico`
the exe + shortcut icon. `tools/install-shortcut.ps1` drops a "Discogs Deal Watcher" shortcut on the
Desktop pointing at the bundled `electron.exe`.

## Deploy — two options

### Option A — GitHub Actions (free, git-based; the periodic-scrape model)

Push this folder to a GitHub repo. The included [`.github/workflows/watch.yml`](.github/workflows/watch.yml)
runs `node watch-once.js` on a cron (default every 15 min): each run checks the **highest-priority
slice** of the wantlist (`SLICE_SIZE`, default 200 — ranked by watch-score, see "Catching just-listed
copies faster"), carries state via the Actions cache, emails new dips via Resend, and commits
`deals.json` for the dashboard. Add repo **Secrets**: `DISCOGS_TOKEN`, `DISCOGS_USERNAME`,
`RESEND_API_KEY`, `MAIL_TO` (`riminiexpressdj@gmail.com`), `MAIL_FROM` (optional).

- **Coverage:** full wantlist every ⌈N/SLICE_SIZE⌉ runs. 715 / 200 ≈ 4 runs ≈ ~1 h at 15-min
  cadence, with hot/just-listed releases re-checked every run. Raise `SLICE_SIZE` or the cron
  frequency for faster coverage (public repo = unlimited minutes).
- **Cost:** private repos get 2000 Actions-min/mo free; runs are short (Resend needs no `npm install`),
  so 15-min cadence fits. **Public repos = unlimited.** Note: GitHub pauses cron on a repo with no
  activity for 60 days.

### Option B — Fly.io (always-on, fastest coverage)

`watcher.js` as a single 24/7 process — sweeps continuously (~15-min full coverage for 715 items) and
serves the dashboard API. Uses the included `fly.toml` + `Dockerfile`.

```bash
fly launch --no-deploy
fly volume create ddw_state --size 1 --region ams
fly secrets set DISCOGS_TOKEN=... DISCOGS_USERNAME=Rimini_Express \
  RESEND_API_KEY=re_... MAIL_TO=riminiexpressdj@gmail.com \
  DASHBOARD_TOKEN=$(openssl rand -hex 24)
fly deploy
```

Dashboard → source **Live server**, URL `https://<app>.fly.dev`, the `DASHBOARD_TOKEN`. (Any Node host
— Railway, a €4 VPS — works: set env vars, `node watcher.js`, expose the port, mount a volume at `state/`.)

### Reliability — the email is the product, so don't let it fail *silently*

Three things can make the watcher stop working without any error you'd notice. All three are now guarded:

- **Email deliverability.** The default sender `onboarding@resend.dev` is Resend's **sandbox** address:
  spam-prone and only deliverable to your own verified email. A deal mail in the spam folder = total
  silent failure. **Fix: verify a sending domain in Resend** (DKIM/SPF/DMARC) and set `MAIL_FROM` to an
  address on it. Until then, add a Gmail filter to never mark these as spam, and watch the Resend logs.
  `watch-once.js` logs a warning whenever it's still using the sandbox sender; a `replyTo` (config
  `email.replyTo` / `MAIL_REPLY_TO`) is added as a small legitimacy nudge.
- **Lost state.** Warm-up counts + alert dedupe live in the Actions cache, which GitHub evicts (7 days
  unused / 10 GB LRU). To survive that, each run also commits a tiny **`state-seed.json`** digest to the
  repo (like `soldmedians.json`); a cold run rebuilds warm-up + dedupe from it, so a wiped cache no
  longer means ~4 sweeps of silence followed by a one-time re-alert flood.
- **The cron getting disabled.** GitHub disables scheduled workflows after 60 days with no *user*
  activity — and the bot's own `deals.json` commits **don't** reset that timer. A
  [`keepalive-workflow`](https://github.com/gautamkrishnar/keepalive-workflow) step (and your regular
  local **⚡ Scan now** pushes, which commit as *you*) keep it alive. If it ever does pause, just hit
  **Run workflow** in the Actions tab or push any commit.

A failed deal email now also **exits non-zero**, so GitHub's built-in "workflow failed" notification
reaches you instead of the error being swallowed in a log nobody reads.

### Telegram push (optional second channel)

Email can land in spam; Telegram can't. With two secrets set, every deal/gem alert is **also** pushed
to a Telegram chat — instant on your phone, and sent even when the email send fails (that's the point
of redundancy). Email stays the primary, guarded channel; a Telegram failure only logs a warning.

Setup (~2 minutes, free):

1. In Telegram, message **@BotFather** → `/newbot` → pick a name + username. It replies with a
   **bot token** (`123456:ABC-...`).
2. Open a chat with your new bot and send it any message (e.g. `/start`) — a bot can't message you first.
3. Get your **chat id**: open `https://api.telegram.org/bot<TOKEN>/getUpdates` in a browser and read
   `"chat":{"id":...}` from the JSON.
4. Set both as GitHub repo secrets `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (cloud), and/or in
   `config.json` under `telegram: { botToken, chatId }` (local `watcher.js`).

Leave the secrets unset to keep it off (the default).

### Environment variables

| Var | Meaning |
|---|---|
| `DISCOGS_USERNAME` | whose wantlist to watch (required) |
| `DISCOGS_TOKEN` | personal access token (recommended; enables price suggestions + 60/min) |
| `RESEND_API_KEY` | Resend API key (recommended email path) |
| `GMAIL_USER` / `GMAIL_APP_PASSWORD` | Gmail alternative (SMTP; Node host only) |
| `MAIL_TO` / `MAIL_FROM` | where alerts go / sender (default `onboarding@resend.dev` — sandbox, verify a domain) |
| `MAIL_REPLY_TO` | optional reply-to address (small deliverability nudge) |
| `EMAIL_PROVIDER` | `resend` (default if key present) or `gmail` |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | optional Telegram push next to email (see "Telegram push") |
| `MODE` | `balanced` (default) / `sensitive` / `strict` |
| `SLICE_SIZE` | releases checked per `watch-once.js` run, by watch-score priority (GitHub model, default 200) |
| `DASHBOARD_TOKEN` | bearer token the dashboard must send (live-server model) |
| `PORT` | dashboard API port (default 8787) |
| `MIN_DISCOUNT` | deal threshold, 0–1 (default 0.5) |
| `MIN_REFERENCE` | value floor: VG+ suggestion must be ≥ this € to alert (default 25; safe for diamonds) |
| `SHIPPING_ESTIMATE` | € added to the item price; the alert threshold uses the total (default 5) |
| `CURRENCY` | price currency (default EUR) |

## Known limitations (honest list)

- **No per-copy condition / shipping / exact listing link** — those live behind Cloudflare. The
  watcher detects *that* a cheap copy exists and links you to verify; it can't read the real grade or
  real shipping. Mitigations: a configurable **shipping estimate** folded into the total, and the
  **implied-grade** read (`≈ priced as VG+` … `≈ ≤ Good`) so you can judge condition at a glance — but
  always confirm the actual grade + shipping on the listing page before buying.
- **Reference is a *suggested* price, not the historical sales median** — the real median is
  web-only. The VG+ suggestion is the closest API proxy; the trailing-median fallback is our own.
- If you later decide the condition/shipping precision matters more than 24/7-cloud, the path is a
  **local residential scraper** (a real logged-in browser session) that syncs into this same store +
  dashboard — see the original design notes / git history.

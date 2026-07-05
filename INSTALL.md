# Discogs Deal Watcher — Install & Setup

A desktop app that scans your Discogs **wantlist** and shows you copies that are for sale far
under their real market value — with the real media condition (VG+ / NM …), real shipping to your
country, and a direct buy link. It only ever **reads** Discogs and shows you deals; it never buys
anything.

---

## 1. Install

### Windows

1. Download **`Discogs-Deal-Watcher-Setup-<version>.exe`**.
2. Double-click it and follow the installer (you can choose the install folder). It creates a
   Start-menu and desktop shortcut, and an uninstaller.

> **Windows SmartScreen warning.** The installer isn't code-signed (a signing certificate costs
> money), so Windows may show *"Windows protected your PC"*. Click **More info → Run anyway**. This
> is normal for small/independent apps.

The app keeps your settings and scan cache in your per-user app-data folder
(`%APPDATA%\Discogs Deal Watcher`), not in the install folder — so it survives upgrades and never
needs admin rights to run.

### macOS (universal — Apple Silicon + Intel)

1. Download **`Discogs-Deal-Watcher-<version>-mac.dmg`**, open it, and drag the app into
   **Applications**.
2. The app isn't signed with a paid Apple Developer certificate, so the first launch needs one
   manual unlock:
   - **Right-click the app → Open → Open** (don't double-click the first time — macOS blocks
     unsigned apps opened that way).
   - If macOS still reports it as *"damaged"* or *"can't be opened"* (common on Apple Silicon), open
     **Terminal** and run `xattr -cr "/Applications/Discogs Deal Watcher.app"`, then open it normally.

Settings and the scan cache live in `~/Library/Application Support/Discogs Deal Watcher`.

---

## 2. First run — connect your Discogs account

On first launch a short **setup wizard** appears asking for:

- **Discogs username** — your account name (the wantlist it scans).
- **Discogs personal access token** — see below.
- **Currency** — the currency prices are shown/compared in (default EUR).

### Getting a Discogs token (free, ~30 seconds)

1. Sign in at [discogs.com](https://www.discogs.com).
2. Go to **Settings → Developers** (or open
   [discogs.com/settings/developers](https://www.discogs.com/settings/developers) — the wizard's
   *"How do I get a token?"* link takes you straight there).
3. Click **Generate new token** and copy the string it gives you.
4. Paste it into the wizard's **token** field.

The token gives the app read access to *your own* wantlist and to Discogs' per-condition price
suggestions. Keep it private (it's like a password). It's stored locally on your PC only.

Click **Test connection** to confirm it works (it should say *"signed in as … · N releases on the
wantlist"*), then **Save & scan**.

---

## 3. Using it

- **⚡ Scan now** — sweeps your **whole** wantlist (~13 min for ~700 releases; it's rate-limited by
  Discogs). For each release it finds the cheapest copy that is genuinely **VG+ or better**, reads
  the real shipping to your location, and compares it to the real sales-history median.
- **⚡ Quick** — only the highest-priority releases (~4–5 min). The rest roll into the next scan.
- **⚡ Full + medians** — a full scan that also refreshes every release's sold-median (slow, ~30–60
  min); use it occasionally to keep the value references current.
- **Filters / sliders** (top bar) — min value, min % off, max total, assumed shipping, *Just listed*,
  *VG+ only*. All run instantly over the loaded results — no re-scan needed.
- **Sort → Best first** ranks the strongest "diamonds" to the top.
- **Background scan** (⚙ Settings) — re-scan automatically every N hours while the app is open, so
  the deals stay fresh without clicking. Set to *Off* to disable.

Click any deal card to open it on Discogs. The app never adds to cart or buys — you always complete
the purchase yourself.

---

## 4. Where the deals come from

By default the app uses **Local scan only** — everything happens on your PC, no cloud, no account
beyond your Discogs token. This is the recommended mode and needs no extra setup.

The **Source** dropdown in ⚙ Settings also offers two cloud modes — *GitHub Actions* and *Live
server* — but those only do something if you run your **own** always-on cloud watcher (see the
developer `README.md`). Most people should leave it on **Local scan only**.

---

## 5. Optional — 24/7 email alerts (built-in cloud setup)

Local scanning shows deals (and desktop notifications) while the app is open. If you also want
**email alerts around the clock — even when your computer is off** — the app can set that up for
you: it creates your own free copy of the watcher on GitHub and switches it on.

Open **⚙ Settings → "Set up cloud alerts…"**. You need two free accounts (one-time, ~5 minutes):

1. **GitHub** (runs the scans) — sign in at github.com, then click the wizard's token link. It opens
   a "new token" page with the right access already ticked; press **Generate token** and paste the
   result into the wizard.
2. **Resend** (sends the emails) — sign up at resend.com (Google login works), go to **API Keys →
   Create API key**, paste it into the wizard. Use the **same email address** for the alerts as you
   signed up to Resend with — Resend's free sender only delivers to your own address, and the first
   email may land in spam (mark it "not spam" once).

Press **Set it up** and the app does the rest: it creates the copy, stores your settings encrypted
on GitHub, switches the scan on, and starts the first run. The ☁ pill in the top bar then shows
when your cloud watcher last ran. Notes:

- Emails start after the watcher has seen your wantlist a few times (it learns normal prices first,
  so you don't get flooded on day one).
- GitHub runs free scheduled tasks roughly every 1–1.5 hours (it delays the requested schedule) —
  that's the alert latency to expect.
- It only ever **reads** Discogs and emails you; it never buys anything. Everything runs on your own
  accounts; re-running the wizard is safe and just repairs/updates the setup.

---

## 6. Uninstall

Use **Settings → Apps → Discogs Deal Watcher → Uninstall**, or the uninstaller in the install
folder. To also remove your saved settings/cache, delete `%APPDATA%\Discogs Deal Watcher`.

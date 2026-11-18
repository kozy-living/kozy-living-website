# Cloudflare hosting: why the store left Vercel, and how it runs now

The storefront runs on **Cloudflare Workers (Paid, $5/month)** through the
OpenNext adapter (`@opennextjs/cloudflare`). Shopify is still the backend
and checkout. This document is the setup runbook, the dashboard settings
that live outside the repo, and the reasons.

The previous host's record is `docs/vercel-hosting.md`. Read its §9 for the
Nov 16 incident that caused the move.

---

## 1. Why Cloudflare

Vercel Hobby paused the whole store for 30 days twice in November 2026, and
neither time did the traffic come from shoppers or ads:

| | Nov 2 | Nov 16 |
| --- | --- | --- |
| Who | Crawlers in US data centres | ~118,600 real browsers, **no referrer**, 94% on `/search`, 92% bounce, from PK / BD / IN / BR / AR / VN / ZA / MX / PH |
| Fixed by | Static pages, robots.txt, Bot Protection | Nothing on Hobby can fix it (below) |

The Nov 16 visitors ran JavaScript (Web Analytics only counts browsers that
do), so Bot Protection waved them through as it should. Whoever sent them
is outside our reach. And Hobby cannot absorb that volume *even with
perfect caching*: a first visit pulls roughly 0.5 MB and ~30 files from the
platform, so 120K visitors is on the order of 60 GB and 3.6M requests in a
day against Hobby's 100 GB transfer and 1M requests **a month**. Any limit
crossed means a 30-day pause of the whole account. (Those two figures are
estimates, not measurements.)

Workers Paid has no bandwidth charge at all, static files are free and
unlimited, and going over an allowance is billed per use, not punished
with a pause:

| Included per month | Overage | A Nov 16 day here |
| --- | --- | --- |
| 10M worker requests | $0.30 / million | ~0.13M |
| 30M CPU-ms | $0.02 / million CPU-ms | ~12M (≈100 ms × 122K) |
| Static asset requests | free, unlimited | all JS/CSS/fonts/icons |
| R2: 10 GB, 1M writes, 10M reads | metered | small |
| D1: 25B rows read, 50M written | metered | tiny |

So the day that cost a month of downtime on Vercel costs nothing extra
here. The firewall rules in §5 keep even that from adding up.

## 2. What is in the repo

| File | Job |
| --- | --- |
| `wrangler.jsonc` | The Worker: name, domains, bindings (R2, D1, Images, self-reference), logs, the 5-minute cron, the shield's settings. `workers_dev` and `preview_urls` are **off**: only the real domains serve the store. |
| `cloudflare/worker.ts` | The entry point. Wraps OpenNext's handler with the shop micro-cache (`fetch`) and the automatic shield (`scheduled`). |
| `cloudflare/shop-cache.ts` | Micro-cache + stale-if-error for the `ƒ` shop pages (§5, layer 3). |
| `cloudflare/shield.ts` | Automatic Under Attack mode (§5, layer 4). |
| `scripts/cloudflare-shield.mjs` | The edge rules as code: `npm run shield:apply` / `shield:check` (§5, layer 2). |
| `.github/workflows/shield-check.yml` | Hourly: site up, edge rules unchanged. Emails on failure (§5, layer 5). |
| `open-next.config.ts` | Cache wiring: ISR + Shopify fetch cache in R2 behind the per-datacentre Cache API, `revalidateTag` (Shopify webhooks) in D1, in-memory revalidation queue. |
| `public/_headers` | Cache headers for static assets. The assets binding answers those requests before Next runs, so `headers()` in `next.config.js` never sees them. Keep the two lists together. |
| `.env.production` | `NEXT_PUBLIC_SITE_URL` and the Web Analytics token. Public values, committed on purpose: they are inlined at build time. |
| `next.config.js` | `www.kozyliving.in` → 308 → `kozyliving.in` (was a Vercel dashboard setting). |
| `package.json` | `npm run cf:preview` (local Workers runtime), `npm run deploy`. |

Code that changed for the runtime:

- `components/opengraph-image.tsx`: reads the font off disk, and on Workers
  (no disk) fetches it from the site instead.
- `lib/rate-limit.ts`: client IP from `cf-connecting-ip` first. On
  Cloudflare, `x-forwarded-for` is appended to, not overwritten, so its first
  entry is client-controlled.
- `app/layout.tsx`: Cloudflare Web Analytics beacon instead of
  `@vercel/analytics`.

## 3. One-time setup

Run from the repo root in a normal terminal (some wrangler steps ask a
question; in a non-interactive shell they hang - set `CI=true` there).

### 3.1 Account and plan

1. Create a Cloudflare account and subscribe to **Workers Paid** ($5/month):
   dashboard → Workers & Pages → Plans. The free plan's 10 ms CPU limit per
   request is far below what a `/search` render takes.
2. `npx wrangler login`

### 3.2 Move the domain's DNS to Cloudflare

A Worker can only serve a domain whose zone is on Cloudflare.

1. Dashboard → **Add a domain** → `kozyliving.in` → **Free** plan (the zone
   plan; separate from Workers Paid).
2. Cloudflare imports the existing records. **Check them against the
   current DNS host before switching** - anything missing stops working:
   - `shop` CNAME → `shops.myshopify.com`, **DNS only (grey cloud)**.
     Shopify requires it unproxied; proxied, checkout and the Shopify domain
     break.
   - Any MX / TXT records (email, Google Search Console verification,
     Shopify verification). Keep them.
   - **Delete** the apex and `www` records that point at Vercel
     (`76.76.21.21` / `cname.vercel-dns.com`). The Worker's custom domains
     create their own.
3. At the registrar, replace the nameservers with the two Cloudflare gives
   you. It usually takes minutes, sometimes up to a day.

### 3.3 Storage

```sh
npx wrangler r2 bucket create kozy-living-opennext-cache
npx wrangler d1 create kozy-living-tag-cache
```

Paste the `database_id` the second command prints into `wrangler.jsonc`
(`REPLACE_WITH_D1_DATABASE_ID`). The D1 table is created by the deploy
command itself.

### 3.4 Secrets

Every server-side value in `.env` becomes a Worker secret. They are read at
runtime, never committed:

```sh
npx wrangler secret bulk .env
```

The build ALSO reads `.env` (static pages are rendered at build time with
the Shopify tokens), so deploy from a machine that has it - see §4.

### 3.5 Deploy

First fill in `CF_ACCOUNT_ID` and `CF_ZONE_ID` in `wrangler.jsonc` `vars`
(where to find them is in the comments there). They are ids, not secrets.

```sh
npm run deploy
```

This builds with OpenNext, uploads the prerendered pages into R2, creates
the D1 table and publishes the Worker on `kozyliving.in` and
`www.kozyliving.in`.

### 3.6 Check it live

```sh
curl -sI https://kozyliving.in/ | head -1                  # 200
curl -sI https://www.kozyliving.in/search?q=robe | grep -i location   # https://kozyliving.in/search?q=robe
curl -s https://kozyliving.in/robots.txt | grep Sitemap    # https://kozyliving.in/sitemap.xml
```

The `www` redirect could not be tested locally (`wrangler dev` replaces the
Host header with the route's), only under `next start`, where it is a 308.

Then in a browser: home, a product, add to cart, checkout opens, sign in to
`/account`, a newsletter signup, the contact form, `/kit-builder`.

### 3.7 Switch on the protection

Three API tokens (dashboard → My Profile → API Tokens → Create Token →
Custom). Three, not one, so each holder can do only its own job:

| Token | Permissions | Goes to |
| --- | --- | --- |
| **Shield rules** | Zone: Zone Read, Zone WAF Edit, Bot Management Edit, Zone Settings Read - zone `kozyliving.in` | Your terminal only, for `shield:apply` |
| **Shield runtime** | Zone: Zone Settings Edit - zone `kozyliving.in`; Account: Account Analytics Read | `npx wrangler secret put SHIELD_API_TOKEN` |
| **Shield check** | Zone: Zone Read, Zone WAF Read, Bot Management Read, Zone Settings Read | GitHub → repo → Settings → Secrets → Actions → `CLOUDFLARE_SHIELD_CHECK_TOKEN` |

Then:

```sh
# PowerShell: $env:CLOUDFLARE_API_TOKEN="<shield rules token>"
CLOUDFLARE_API_TOKEN=<shield rules token> npm run shield:apply
```

It writes the rules, reads them back, and prints `Applied and verified.`
If Cloudflare refuses a rule (plans change what they allow), the error names
it; fix that rule in the script and re-run.

In the GitHub repo, run **Actions → Shield check → Run workflow** once to
see it pass. The schedule runs only from the default branch, and GitHub
switches schedules off after 60 days without a commit (it emails first;
re-enable from the Actions tab).

### 3.8 Shopify and Vercel

- **Customer Account API** (Shopify → Headless → Customer Account API):
  the callback list must include `https://kozyliving.in/api/auth/callback`.
- **Webhooks to `/api/revalidate`** (Settings → Notifications → Webhooks):
  if registered, Admin edits show at once; if not, within 15 minutes.
- **Vercel:** once the site is live here, remove `kozyliving.in` and `www`
  from the Vercel project and disconnect its Git repository, so a push does
  not deploy there too. The paused account can then be left alone.

## 4. Deploying after that

`npm run deploy` from a machine with `.env`. It works on Windows (tested on
2026-11-18), though the adapter warns that WSL is the supported path.

Before a deploy that touches shared chrome, run `npm run build` and check the
route table (CLAUDE.md §17). `npm run cf:preview` runs the built Worker in
the real `workerd` runtime on `http://localhost:8787`.

## 5. Protection, layer by layer

What "down" can mean here, and what stops each:

| Threat | Before Nov 2026 | Now |
| --- | --- | --- |
| Usage limit hit → host pauses the site | Happened twice (30 days each) | **Cannot happen**: Workers Paid bills overage, never pauses |
| Flood of bots / bought traffic | Paid in origin transfer until paused | Layers 1-4 below |
| Bill runs away during a long flood | n/a (paused instead) | Layer 4 cuts it within 5-10 min; layer 5 + billing alert tell you |
| Shopify slow, down or throttling us | Shop pages error | Layer 3 serves the last good page for 24h; ISR pages already serve stale |
| Someone switches a rule off | Unnoticed (it was a dashboard setting) | Layer 5 fails within the hour and emails you |
| Real traffic spike (a viral post, a sale) | Would have paused the site | Served and billed per use, a few dollars at most |

What none of this covers, honestly: Cloudflare or Shopify themselves having
an outage (both rare, both outside any single site's control), and a
mistake in a deploy - roll that back from Workers → kozy-living →
Deployments. "Never down" from traffic is achievable; "never down" from
everything is not something any host can promise.

### Layer 1 - Cloudflare's own DDoS protection

Always on, free, automatic: network and HTTP DDoS attacks are absorbed at
Cloudflare's edge before any rule or the Worker sees them. Nothing to set.

### Layer 2 - Edge rules, as code (`scripts/cloudflare-shield.mjs`)

Applied with `npm run shield:apply`, verified with `npm run shield:check`.
**Edit the script, not the dashboard**: rules whose `ref` starts with
`kozy-` are overwritten on every apply (rules added by hand are kept, after
them). What it sets:

| Rule | Does |
| --- | --- |
| `kozy-skip-trusted` (first) | Shopify webhook POSTs to `/api/revalidate`, `/robots.txt` and verified crawlers (Googlebot, Bingbot, WhatsApp/Facebook previews) skip everything below and the security level, so the shield never blocks them. |
| `kozy-block-probes` | Blocks `/wp-*`, `*.php`, `/.env*`, `/.git*`. |
| `kozy-challenge-shop-abroad` | `/search*` and `/shop-by-*` from outside India → Managed Challenge. The Nov 16 pattern: 93% outside India, all on the shop. Usually invisible to a real person. |
| `kozy-ratelimit-search` | One IP, over 30 requests to `/search*` in 10 s → blocked 10 s. |
| Bot settings | AI-training crawlers blocked. **Bot Fight Mode OFF** - on the Free plan it cannot be skipped per path and can challenge Shopify's webhooks. |

Blocked and challenged requests never reach the Worker and cost nothing.

### Layer 3 - The shop micro-cache (`cloudflare/shop-cache.ts`)

The shop pages (`/search`, `/search/<collection>`, `/shop-by-colour`,
`/shop-by-mood`) are the only pages Next renders on every request, and the
only target of the Nov 16 flood. The Worker keeps each one (per URL, phone
or desktop) in the data centre's cache:

- under 60 s old: served from cache (measured locally: 315 ms → 8 ms);
- older: served at once, re-rendered in the background once per isolate;
- a re-render that fails keeps the last good copy, for up to 24 h.

So a flood that repeats URLs costs almost nothing, and **a Shopify outage
leaves the shop browsable** instead of erroring. Cart, account and
newsletter state are read in the browser, so a shared copy is safe; a
response that sets a cookie is never stored. Each response says what
happened in `x-kozy-cache: HIT | STALE | MISS`.

### Layer 4 - The automatic shield (`cloudflare/shield.ts`)

Every 5 minutes the Worker counts its own requests over the last five. Over
`SHIELD_REQUESTS_PER_5MIN` (3000, in `wrangler.jsonc`) it switches the zone
to **Under Attack** - every visitor gets a few-second browser check once,
which bought traffic and bots rarely pass - and holds it for 2 h (doubling
for each return within a day, up to 24 h), then restores the previous
level. This is the spend cap Cloudflare does not offer.

- It only lowers what it raised. Under Attack set by hand stays; lowering
  it by hand while the shield holds makes the shield stand down.
- Not configured, or the API failing, means it does nothing that round.
- Every round logs `shield: ...` in Workers → kozy-living → Logs.
- 3000 per 5 min is ~7x the Nov 16 flood's average, which layer 2 already
  absorbs for free. Lower it in `wrangler.jsonc` if you want it twitchier;
  real shoppers then see the check more often.

### Layer 5 - Alerts

- **`.github/workflows/shield-check.yml`**, hourly: the home page and the
  sitemap answer 200 (a Cloudflare challenge counts as up - that is the
  shield working), and `shield:check` finds no drift. A failure emails
  the repository owner.
- **Cloudflare → Notifications → Add → Usage Based Billing** for Workers:
  an email when usage passes a threshold you choose, so a flood shows up
  before the invoice does.

### Emergency switch

Security → Settings → **Under Attack Mode**, by hand. The shield leaves a
hand-set level alone. Turn it off when the flood has passed.

### Analytics & Logs → Web Analytics

Add `kozyliving.in`, copy the `token` from the snippet into
`NEXT_PUBLIC_CF_BEACON_TOKEN` in `.env.production`, and redeploy. Free, with
no event quota (Vercel's ran out on Nov 16). The beacon only renders when
the token is set.

### Checking it all

```sh
npm run cf:check        # worker types + 23 tests (shield decisions, shield
                        # against a fake API on real SQLite, micro-cache)
npm run shield:check    # the live zone matches the script
curl -sI -H "accept: text/html" "https://kozyliving.in/search?q=robe" | grep -i x-kozy-cache
```

## 6. Do not undo

- Do not turn `workers_dev` or `preview_urls` back on: each is a second
  crawlable copy of the store.
- Do not change the `kozy-` rules in the dashboard: the next
  `shield:apply` overwrites them and `shield:check` reports them. Change
  `scripts/cloudflare-shield.mjs`.
- Do not point `main` in `wrangler.jsonc` back at `.open-next/worker.js`:
  that drops the micro-cache and the shield without any error.
- Do not turn on Bot Fight Mode (Shopify webhooks).
- Do not proxy (orange-cloud) the `shop` CNAME.
- Do not move secrets into `.env.production` or `wrangler.jsonc` `vars`:
  both are committed.
- Everything in `docs/vercel-hosting.md` §8 that is about the code (no
  cookies in shared chrome, `intent-link`, robots.txt, no video in
  `public/`) still applies. Those rules keep the CPU bill small here.

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
| `wrangler.jsonc` | The Worker: name, domains, bindings (R2, D1, Images, self-reference), logs. `workers_dev` and `preview_urls` are **off**: only the real domains serve the store. |
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

### 3.7 Shopify and Vercel

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

## 5. Dashboard settings (not in the repo)

**These are the defence against the next flood.** Nothing in git records
them; if one is switched off, re-create it from here.

### Security → WAF → Custom rules (Free plan allows 5)

| Order | Name | Expression | Action |
| --- | --- | --- | --- |
| 1 | Scanner probes | `(http.request.uri.path contains "/wp-") or (http.request.uri.path contains ".php") or (starts_with(http.request.uri.path, "/.env")) or (starts_with(http.request.uri.path, "/.git"))` | Block |
| 2 | Shop outside India | `(starts_with(http.request.uri.path, "/search") or starts_with(http.request.uri.path, "/shop-by-")) and ip.src.country ne "IN" and not cf.client.bot` | Managed Challenge |

Rule 2 is the Nov 16 pattern: the shop only delivers within India, the
flood was 93% outside it, and it went to `/search`. A Managed Challenge is
usually invisible to a real person, costs the Worker nothing, and
`cf.client.bot` keeps Googlebot and Bingbot out of it. If the next flood
hits other pages, widen the path test or drop it, so the rule covers
everything outside India.

### Security → WAF → Rate limiting rules (Free plan allows 1)

| If | Rate | Then |
| --- | --- | --- |
| URI path starts with `/search` | 30 requests / 10 s, per IP | Block for 10 s |

### Security → Settings

- **Block AI bots**: on. (robots.txt still names them for polite bots.)
- **Bot Fight Mode: leave OFF.** It cannot be skipped per path on the Free
  plan and can challenge Shopify's webhook POSTs to `/api/revalidate`.

### Emergency switch

If a flood gets past the rules: Security → **Under Attack Mode** (every
visitor gets a challenge first). Turn it off when the flood has passed.

### Analytics & Logs → Web Analytics

Add `kozyliving.in`, copy the `token` from the snippet into
`NEXT_PUBLIC_CF_BEACON_TOKEN` in `.env.production`, and redeploy. Free, with
no event quota (Vercel's ran out on Nov 16). The beacon only renders when
the token is set.

### Notifications

Add a **Usage Based Billing** notification for Workers, so a flood shows up
as an email, not as a bill at month end.

## 6. Do not undo

- Do not turn `workers_dev` or `preview_urls` back on: each is a second
  crawlable copy of the store.
- Do not proxy (orange-cloud) the `shop` CNAME.
- Do not move secrets into `.env.production` or `wrangler.jsonc` `vars`:
  both are committed.
- Everything in `docs/vercel-hosting.md` §8 that is about the code (no
  cookies in shared chrome, `intent-link`, robots.txt, no video in
  `public/`) still applies. Those rules keep the CPU bill small here.

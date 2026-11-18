# Cloudflare hosting and traffic protection

Status checked on 2026-11-18: the Cloudflare account and zone exist, but the
zone is pending nameserver delegation and the public domain still returns
Vercel's `402 DEPLOYMENT_DISABLED`. Code in this repository is not evidence
of a successful migration. Update this status after the live checks pass.

Shopify remains the commerce backend and checkout. The custom Next.js
storefront is prepared for Cloudflare Workers Paid through OpenNext.

## 1. What happened and what the protection can promise

On November 16, analytics recorded 118,505 visitors, concentrated on
`/search`. Very few visited products. Origin transfer and CPU grew on the
same day, and Vercel explicitly paused deployments for Fast Origin Transfer
on November 17, until December 17. See `vercel-hosting.md` section 9.

This is suspicious traffic, but neither JavaScript execution nor missing
referrers proves visitors were human, that traffic was purchased, or who
sent it. Browser automation executes JavaScript. Request/firewall logs are
needed to investigate source and intent.

The goal is to reduce expensive work, detect failures, and recover quickly.
No host, challenge or rule can promise zero downtime or block every browser
bot. Challenges can affect real shoppers. A paid host can still fail, and
usage that passes the firewall can still incur charges.

Workers Paid has a minimum subscription and metered overage. Bandwidth has
no additional charge, but CPU, requests, storage, image transformations and
other services have allowances and/or charges. A five-minute traffic shield
is NOT a spending cap. Cloudflare now offers Workers spending limits;
reaching one stops Worker invocations, and storage charges are separate.
Choose an emergency spending threshold with the owner, alongside alerts
that fire earlier. A limit is not an exact maximum bill because enforcement
and usage reporting have delay.

Official references:
- https://developers.cloudflare.com/workers/platform/pricing/
- https://developers.cloudflare.com/workers/platform/spend-management/
- https://developers.cloudflare.com/cloudflare-challenges/challenge-types/challenge-pages/

## 2. Protection in the repository

| Layer | Behavior and limits |
| --- | --- |
| Edge firewall | `scripts/cloudflare-shield.mjs`: scanner probes blocked; overseas `/search*` and `/shop-by-*` traffic challenged; verified bots, robots.txt and webhook POSTs skip custom challenges. Never trust a claimed user-agent as verification. |
| Edge rate limit | One IP per datacentre: 30 requests/10 seconds, blocked for 10 seconds. Covers search, shop-by pages, kit builder, account and API routes. Distributed traffic can evade this. Verified bots are excluded. |
| Bot settings | AI crawlers blocked; basic Bot Fight Mode off because its challenges cannot be exempted for Shopify webhooks. Workers Paid does not include a Pro website plan or Super Bot Fight Mode. |
| Request preparation | `cloudflare/request-guard.ts`: oversized browse URLs rejected before Next, search query capped at 80 characters, tracking/internal cache parameters removed from BOTH the render URL and cache key. Merchant facet parameters remain supported. |
| Shared public cache | `cloudflare/shop-cache.ts`: HTML browse pages fresh for 60 seconds; search API JSON fresh for 5 minutes; last good copies retained up to 24 hours, subject to eviction. Separate phone/desktop and deployment keys. Query ordering is normalized. |
| Cache safety | Authorization, RSC/prefetch requests, actions, range requests, cookie-setting responses and errors are not shared. Simultaneous cold requests share one public render per key per isolate. A non-public result is rendered separately for other callers. |
| Failure containment | Failed stale refreshes wait 30 seconds before another attempt. Up to 16 refreshes and 16 concurrent protected renders per isolate. Render slots last through streaming completion/cancellation. Excess uncached work receives 429 with Retry-After; warm pages can still be served. This is not a global limit. |
| Webhook boundary | An invalid existing `?secret=` webhook is rejected before Next loads. The application still checks its secret/topic. Do not log webhook URLs with secrets. |
| Automatic shield | Every five minutes, `cloudflare/shield.ts` examines Worker requests and raises Under Attack above 300 requests/five minutes, below the incident's approximate average. Initial hold 2 hours; repeated incidents double it up to 24 hours. Manual security-level changes are respected. |
| Failure detection | Missing/malformed analytics never counts as calm. Successful rounds write a heartbeat in D1. `/api/protection-health` returns 503 if unconfigured or no successful round occurred within 15 minutes. The endpoint exposes no tokens/account IDs. |
| CPU bound | `wrangler.jsonc` caps an invocation at 1000 CPU milliseconds. This may fail unusually expensive requests and is not a monthly spend cap. |
| Monitoring | `.github/workflows/shield-check.yml`: nominally every 15 minutes, verifies configuration, live edge rules, real home/search content, sitemap and shield heartbeat. Missing check credentials FAIL. A challenge response alone NEVER counts as an available storefront. Schedules and notifications depend on GitHub settings and can be delayed. |

Cache retention is not a backup: a cold datacentre or evicted entry has no
stale copy. Random meaningful search queries still create separate work.
RSC, dynamic account/cart actions and kit builder requests bypass the public
cache but share the per-isolate render budget and edge rate rule. Requests
to static/content routes are outside that budget.

## 3. Account activation and credentials

Use Node 24. Login with `npx wrangler login` and check `npx wrangler whoami`.
Enable Workers Paid and R2 in the dashboard. The zone's Free website plan is
separate from Workers Paid.

Create:

```sh
npx wrangler r2 bucket create kozy-living-opennext-cache
npx wrangler d1 create kozy-living-tag-cache
```

Use the actual D1 ID in `wrangler.jsonc`. The account and zone IDs are already
filled from the authenticated account. They are not secrets. Keep the
`main`, version metadata, CPU bound, cron and disabled previews intact.

Create custom API tokens at https://dash.cloudflare.com/profile/api-tokens:

| Token | Permissions and destination |
| --- | --- |
| Edge setup | Zone: Zone Read, DNS Read, Zone WAF Edit, Bot Management Edit, Zone Settings Read; only kozyliving.in. Save as CLOUDFLARE_API_TOKEN in `.env.protection.local`. DNS Read is for verifying migration records. |
| Shield runtime | Zone: Zone Settings Edit for kozyliving.in; Account: Account Analytics Read for this Worker account. Save as SHIELD_API_TOKEN in `.env.protection.local`. Never upload the broader setup token to the Worker. |
| Scheduled check | Zone: Zone Read, Zone WAF Read, Bot Management Read, Zone Settings Read; only kozyliving.in. Set GitHub Actions secret CLOUDFLARE_SHIELD_CHECK_TOKEN on the repository that actually hosts the production branch. |

`.env.protection.local` is ignored by git. Do not paste credentials into
chat or commit them. `npm run protection:secrets` uploads the existing app
`.env` and ONLY the runtime shield token, over stdin to Wrangler. The setup
token is excluded. This can create a placeholder Worker on the first run.

```sh
npm run protection:config
npm run protection:secrets
npm run shield:apply
npm run shield:check
```

The standard `npm run deploy` checks configuration, edge rules and required
remote secret names before building/deploying. It refuses placeholders or
missing protection. `npm run cf:build` remains a local build-only command.
The first shield heartbeat can take up to the next scheduled round after
deploy; live checks intentionally remain unhealthy until it succeeds.

## 4. DNS cutover

Before changing registrar nameservers, compare imported DNS records with
the existing DNS host. Preserve MX/TXT and any email/verification records.
`shop` must stay a DNS-only CNAME to `shops.myshopify.com`. Never orange-cloud
that Shopify checkout hostname.

The assigned Cloudflare nameservers for this zone are:
- aitana.ns.cloudflare.com
- memphis.ns.cloudflare.com

Change the registrar delegation only after records are verified and the
Worker is ready. The custom domains create their own apex/www records;
remove conflicting Vercel records as part of that controlled cutover.
`www` redirects to the apex in the Worker before accessing the shared cache.

After the protected Worker and firewall are ready:

```sh
npm run deploy
npm run protection:live
```

The live check must run against the real Cloudflare-served domain. Confirm
home, desktop/mobile search, filters, pagination, product details, add to
cart, checkout, account login, forms, kit builder and Shopify webhooks.
Challenge rules also apply to client navigations: verify clearance is
established by the initial HTML visit so subsequent API/RSC requests work.
Do not add an HTML challenge to a JSON endpoint without testing its clients.

Enable Actions notifications and run Shield check manually once. Scheduled
workflows run on the default branch; inactive public repositories can have
schedules disabled. Keep an independent uptime monitor too. If a monitor
is challenged, investigate/verify its identity rather than broadly bypassing
security for a spoofable header or user-agent.

Register Shopify webhooks for `/api/revalidate` with the current secret;
otherwise Admin changes use the existing 15-minute Shopify cache TTL. The
extra browse-page cache can add up to its own TTL. Checkout uses Shopify's
current price. Verify Customer Account callback URL is still
https://kozyliving.in/api/auth/callback.

Once confirmed live, disconnect obsolete Vercel deployments/domains. Do not
remove a functioning recovery path before the new store passes checks.

## 5. Operations and recovery

```sh
npm run cf:check          # Worker types and security regressions
npm run lint
npm run cf:build          # production Next + OpenNext bundle
npm run shield:check     # actual edge settings; requires setup/check token
npm run protection:live  # actual storefront and shield heartbeat
```

For local runtime verification, build once and run
`node scripts/cloudflare-run.mjs preview --port 8787`. The adapter recommends
WSL; this repo pins OpenNext 1.20.17 and uses a shell-free Wrangler runner
for preview/deploy because upstream npm-exec SQL quoting hung on Windows.
The runner preserves OpenNext R2 seeding, D1 tag caching and skew protection;
review it alongside any adapter upgrade. A local shield without real API credentials is
expected to be unhealthy; local content tests must not certify production.

During an incident inspect Security Events and Worker logs, especially
`shield:` messages. Enable Under Attack manually if needed. The shield
leaves a manually raised level alone. Restore it after the incident. Tune
thresholds using accepted Worker traffic, real shopper behavior, challenge
outcomes and costs; a viral sale can also cross a low threshold.

Create billing alerts before the chosen emergency limit. Review R2/D1/Images
charges as well as Worker CPU/requests. Roll back a bad Worker deployment
from the Cloudflare dashboard. Maintain a usable Shopify storefront as a
separate recovery option; the current forwarding theme redirects back to
the custom store, so it is not an independent fallback until configured and
tested by the merchant.

Never promise "never down", "all bots blocked", "$5 maximum", or treat a
successful local test as proof that live protection is active.

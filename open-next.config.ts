/**
 * OpenNext adapter config - how Next's caches map onto Cloudflare.
 *
 * Why this site is on Cloudflare at all is `docs/cloudflare-hosting.md`: in
 * short, Vercel Hobby paused the whole store for 30 days twice in November
 * 2026 over traffic nobody here sent, and Workers bills neither bandwidth
 * nor pauses for a month.
 *
 * - incrementalCache: ISR pages and every `fetch(..., { next: { revalidate,
 *   tags } })` to Shopify live in R2. The regional cache (the Cache API of
 *   each data centre) sits in front of it, so a warm page is not an R2 read
 *   per request - R2 reads are metered, Cache API reads are not.
 * - tagCache: D1. `/api/revalidate` (the Shopify webhooks) calls
 *   `revalidateTag`, and that has to be visible to every isolate at once.
 *   The KV tag cache is eventually consistent (up to 60s) and the adapter
 *   itself marks it experimental, so D1.
 * - queue: the in-memory queue. A stale ISR page is re-rendered by the
 *   worker calling itself (WORKER_SELF_REFERENCE in wrangler.jsonc), de-duped
 *   per isolate. The Durable Object queue de-dupes globally, which matters at
 *   traffic this store does not have; it can replace this line later.
 */
import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import r2IncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/r2-incremental-cache";
import { withRegionalCache } from "@opennextjs/cloudflare/overrides/incremental-cache/regional-cache";
import d1NextTagCache from "@opennextjs/cloudflare/overrides/tag-cache/d1-next-tag-cache";
import memoryQueue from "@opennextjs/cloudflare/overrides/queue/memory-queue";

export default defineCloudflareConfig({
  incrementalCache: withRegionalCache(r2IncrementalCache, { mode: "long-lived" }),
  tagCache: d1NextTagCache,
  queue: memoryQueue,
});

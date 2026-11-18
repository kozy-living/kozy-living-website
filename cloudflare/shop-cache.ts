/**
 * Micro-cache for the shop pages that Next renders on every request.
 *
 * `/search`, `/search/<collection>`, `/shop-by-colour` and `/shop-by-mood`
 * read `searchParams`, so they are `ƒ` routes: no ISR, no CDN, a full render
 * (~100 ms CPU, two to four Shopify calls) per hit. They are exactly what
 * the Nov 16 flood hit (94% `/search`, docs/vercel-hosting.md §9), and on
 * any host they are the one place a flood turns into CPU and Shopify load.
 *
 * Their HTML is the same for every visitor except one bit: phone or desktop
 * (page size, `lib/shop/viewport.ts`). Cart, account and newsletter state
 * are all read in the browser (CLAUDE.md §17). So a copy keyed on the full
 * URL plus that bit can be shared by everyone:
 *
 * - FRESH (under FRESH_MS old): served from the data centre's Cache API.
 * - STALE: served at once, and re-rendered in the background - once per
 *   isolate, however many requests arrive meanwhile.
 * - MISS: rendered, streamed to the visitor, and stored on the way past.
 *
 * And because a stale copy is kept for KEEP_SECONDS, a failed re-render
 * (Shopify down or throttled, a bad deploy's 500) leaves shoppers on the
 * last good page instead of an error. That is the "stale-if-error" half.
 *
 * Cache API reads and writes are free; they never touch R2.
 *
 * Only full-page HTML GETs are cached. Client navigations (`rsc` header,
 * `_rsc` param), prefetches, server actions (POST), redirects, 404s and
 * anything that sets a cookie go straight through.
 */

const SHOP_PATH = /^\/(?:search(?:\/[^/]+)?|shop-by-colour|shop-by-mood)\/?$/;

/** Served without re-rendering while younger than this. */
const FRESH_MS = 60_000;

/** How long a copy is kept as the fallback for a failed re-render. */
const KEEP_SECONDS = 24 * 60 * 60;

const STORED_AT = "x-kozy-stored-at";

/** What Next sends for a dynamic page; restored on the way out so browsers
 *  and Cloudflare's own CDN never keep a copy. */
const NO_STORE = "private, no-cache, no-store, max-age=0, must-revalidate";

/** Keys being re-rendered in the background by THIS isolate. */
const refreshing = new Set<string>();

type Render = (request: Request) => Promise<Response>;

/** Phone or desktop, by the same rule as `isMobileRequest()`. */
function viewport(request: Request, url: URL): "m" | "d" {
  const override = url.searchParams.get("mobile");
  if (override === "1") return "m";
  if (override === "0") return "d";

  const cookie = /(?:^|;\s*)kozy_is_mobile=([^;]*)/.exec(
    request.headers.get("cookie") ?? "",
  );
  if (cookie) return cookie[1] === "1" ? "m" : "d";

  return request.headers.get("sec-ch-ua-mobile") === "?1" ||
    /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(
      request.headers.get("user-agent") ?? "",
    )
    ? "m"
    : "d";
}

function cacheable(request: Request, url: URL): boolean {
  return (
    request.method === "GET" &&
    SHOP_PATH.test(url.pathname) &&
    !request.headers.has("rsc") &&
    !request.headers.has("next-router-prefetch") &&
    !request.headers.has("next-action") &&
    !url.searchParams.has("_rsc") &&
    (request.headers.get("accept") ?? "").includes("text/html")
  );
}

function keyFor(request: Request, url: URL): Request {
  const key = new URL(url.pathname + url.search, url.origin);
  key.searchParams.set("__kozy_vp", viewport(request, url));
  return new Request(key.toString(), { method: "GET" });
}

function storable(response: Response): boolean {
  return (
    response.status === 200 &&
    !response.headers.has("set-cookie") &&
    (response.headers.get("content-type") ?? "").includes("text/html") &&
    response.body !== null
  );
}

/** A copy for the Cache API: public so it is kept, stamped with its age. */
function forStorage(response: Response, now: number): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", `public, max-age=${KEEP_SECONDS}`);
  headers.set(STORED_AT, String(now));
  return new Response(response.body, { status: 200, headers });
}

/** The visitor's copy: never cacheable downstream, labelled for debugging. */
function forVisitor(response: Response, state: string): Response {
  const headers = new Headers(response.headers);
  headers.set("cache-control", NO_STORE);
  headers.delete(STORED_AT);
  headers.set("x-kozy-cache", state);
  return new Response(response.body, { status: response.status, headers });
}

async function renderAndStore(
  render: Render,
  request: Request,
  cache: Cache,
  key: Request,
  ctx: ExecutionContext,
): Promise<Response> {
  const response = await render(request);
  if (!storable(response)) return response;

  const copy = response.clone();
  ctx.waitUntil(cache.put(key, forStorage(copy, Date.now())).catch(() => {}));
  return response;
}

export async function withShopCache(
  request: Request,
  ctx: ExecutionContext,
  render: Render,
): Promise<Response> {
  const url = new URL(request.url);
  if (!cacheable(request, url)) return render(request);

  // `caches.default` is the data centre's cache. It does not exist on a
  // `*.workers.dev` host or in some test runners; without it, just render.
  const cache = typeof caches === "undefined" ? undefined : caches.default;
  if (!cache) return render(request);

  const key = keyFor(request, url);
  const cached = await cache.match(key).catch(() => undefined);

  if (cached) {
    const age = Date.now() - Number(cached.headers.get(STORED_AT) ?? 0);
    if (age < FRESH_MS) return forVisitor(cached, "HIT");

    if (!refreshing.has(key.url)) {
      refreshing.add(key.url);
      ctx.waitUntil(
        renderAndStore(render, request.clone(), cache, key, ctx)
          // A failed re-render keeps the old copy: that is the point.
          .then((fresh) => fresh.body?.cancel())
          .catch(() => {})
          .finally(() => refreshing.delete(key.url)),
      );
    }
    return forVisitor(cached, "STALE");
  }

  const response = await renderAndStore(render, request, cache, key, ctx);
  return storable(response) ? forVisitor(response, "MISS") : response;
}

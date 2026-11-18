// node --test cloudflare/shop-cache.test.ts
// The micro-cache against a fake Cache API and a controllable clock, for
// the paths a local run cannot show: stale refresh, and Shopify failing.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { withShopCache } from "./shop-cache.ts";

class FakeCache {
  store = new Map<string, { body: string; init: ResponseInit }>();
  async match(key: Request) {
    const hit = this.store.get(key.url);
    return hit ? new Response(hit.body, hit.init) : undefined;
  }
  async put(key: Request, response: Response) {
    this.store.set(key.url, {
      body: await response.text(),
      init: { status: response.status, headers: Object.fromEntries(response.headers) },
    });
  }
}

let cache: FakeCache;
let now = 1_000_000;
let pending: Promise<unknown>[] = [];
const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} } as unknown as ExecutionContext;
const settle = async () => { while (pending.length) await Promise.all(pending.splice(0)); };

beforeEach(() => {
  cache = new FakeCache();
  (globalThis as { caches?: unknown }).caches = { default: cache };
  Date.now = () => now;
  pending = [];
});

const page = (body: string, init: ResponseInit = {}) =>
  new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "private, no-store" }, ...init });

const get = (path: string, headers: Record<string, string> = {}) =>
  new Request(`https://kozyliving.in${path}`, { headers: { accept: "text/html", "user-agent": "Desktop Chrome", ...headers } });

function renderer(...outcomes: Array<string | number | Error>) {
  let calls = 0;
  const render = async () => {
    const outcome = outcomes[Math.min(calls++, outcomes.length - 1)];
    if (outcome instanceof Error) throw outcome;
    if (typeof outcome === "number") return page("error page", { status: outcome });
    return page(outcome);
  };
  return { render, calls: () => calls };
}

test("miss, then hit: one render serves both", async () => {
  const r = renderer("v1");
  const first = await withShopCache(get("/search?q=robe"), ctx, r.render);
  assert.equal(first.headers.get("x-kozy-cache"), "MISS");
  assert.equal(await first.text(), "v1");
  await settle();
  const second = await withShopCache(get("/search?q=robe"), ctx, r.render);
  assert.equal(second.headers.get("x-kozy-cache"), "HIT");
  assert.equal(await second.text(), "v1");
  assert.equal(r.calls(), 1);
  assert.match(second.headers.get("cache-control")!, /no-store/, "visitors never get a cacheable copy");
});

test("phone and desktop are separate copies", async () => {
  const r = renderer("desk", "phone");
  await withShopCache(get("/search"), ctx, r.render); await settle();
  const phone = await withShopCache(get("/search", { "user-agent": "iPhone Mobile" }), ctx, r.render);
  assert.equal(phone.headers.get("x-kozy-cache"), "MISS");
  assert.equal(await phone.text(), "phone");
});

test("stale: served at once, refreshed once in the background, however many ask", async () => {
  const r = renderer("v1", "v2");
  await withShopCache(get("/search"), ctx, r.render); await settle();
  now += 61_000;
  const responses = await Promise.all([1, 2, 3, 4, 5].map(() => withShopCache(get("/search"), ctx, r.render)));
  for (const res of responses) {
    assert.equal(res.headers.get("x-kozy-cache"), "STALE");
    assert.equal(await res.text(), "v1");
  }
  await settle();
  assert.equal(r.calls(), 2, "five stale hits caused ONE re-render");
  const after = await withShopCache(get("/search"), ctx, r.render);
  assert.equal(after.headers.get("x-kozy-cache"), "HIT");
  assert.equal(await after.text(), "v2");
});

test("Shopify down (render throws): shoppers keep getting the last good page", async () => {
  const r = renderer("good", new Error("Shopify unreachable"));
  await withShopCache(get("/search/bathrobes"), ctx, r.render); await settle();
  for (let minute = 1; minute <= 30; minute++) {
    now += 60_000;
    const res = await withShopCache(get("/search/bathrobes"), ctx, r.render);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "good");
    await settle();
  }
});

test("a 500 from a re-render does not replace the good copy", async () => {
  const r = renderer("good", 500, "better");
  await withShopCache(get("/search"), ctx, r.render); await settle();
  now += 61_000;
  assert.equal(await (await withShopCache(get("/search"), ctx, r.render)).text(), "good");
  await settle();
  assert.equal(await (await withShopCache(get("/search"), ctx, r.render)).text(), "good");
  await settle();
  assert.equal(await (await withShopCache(get("/search"), ctx, r.render)).text(), "better");
});

test("an error with nothing cached is passed through, and not stored", async () => {
  const r = renderer(500, "ok");
  const res = await withShopCache(get("/search?q=new"), ctx, r.render);
  assert.equal(res.status, 500);
  assert.equal(res.headers.get("x-kozy-cache"), null);
  await settle();
  assert.equal(cache.store.size, 0);
});

test("a response that sets a cookie is never shared", async () => {
  const r = { render: async () => page("mine", { headers: { "content-type": "text/html", "set-cookie": "a=b" } }) };
  await withShopCache(get("/search"), ctx, r.render); await settle();
  assert.equal(cache.store.size, 0);
});

test("only full-page shop GETs are cached", async () => {
  const r = renderer("x");
  const cases: Request[] = [
    get("/search", { rsc: "1" }),
    get("/search", { "next-router-prefetch": "1" }),
    get("/search?_rsc=abc"),
    get("/about-us"),
    get("/product/tulsi"),
    get("/search/a/b"),
    new Request("https://kozyliving.in/search", { method: "POST", headers: { accept: "text/html" } }),
    new Request("https://kozyliving.in/search", { headers: { accept: "application/json" } }),
  ];
  for (const request of cases) {
    const res = await withShopCache(request, ctx, r.render);
    assert.equal(res.headers.get("x-kozy-cache"), null, `${request.method} ${request.url} ${JSON.stringify(Object.fromEntries(request.headers))}`);
  }
  await settle();
  assert.equal(cache.store.size, 0);
});

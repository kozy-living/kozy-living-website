import { test } from "node:test";
import assert from "node:assert/strict";
import { prepareRequest, withRenderBudget, webhookAuthorized } from "./request-guard.ts";

test("tracking parameters and reserved cache keys are removed before rendering; real filters survive", () => {
  const result = prepareRequest(new Request("https://kozyliving.in/search?utm_source=spam&fbclid=123&__kozy_build=poison&q=%20robe%20&size=s-m&page=2"));
  assert.ok(result instanceof Request);
  assert.equal(result.url, "https://kozyliving.in/search?q=robe&size=s-m&page=2");
});

test("pathological query URLs stop before calling Shopify", () => {
  for (const query of ["q=" + "a".repeat(4100), Array.from({ length: 25 }, (_, i) => `x${i}=1`).join("&")]) {
    const result = prepareRequest(new Request(`https://kozyliving.in/search?${query}`));
    assert.ok(result instanceof Response);
    assert.equal(result.status, 414);
  }
});

test("rotating URLs and RSC requests share a bounded render budget, which recovers", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const render = async () => { await gate; return new Response("ok"); };
  const requests = Array.from({ length: 16 }, (_, i) => withRenderBudget(
    new Request(`https://kozyliving.in/search?q=${i}`, { headers: { rsc: "1" } }), render));
  try {
    const busy = await withRenderBudget(new Request("https://kozyliving.in/api/search?q=other"), render);
    assert.equal(busy.status, 429);
    assert.equal(busy.headers.get("retry-after"), "10");
    assert.equal((await withRenderBudget(new Request("https://kozyliving.in/kit-builder"), render)).status, 429);
    assert.equal((await withRenderBudget(new Request("https://kozyliving.in/account"), render)).status, 429);
    assert.equal((await withRenderBudget(new Request("https://kozyliving.in/about-us"), async () => new Response("about"))).status, 200);
  } finally { release(); for (const response of await Promise.all(requests)) await response.text(); }
  assert.equal(await (await withRenderBudget(new Request("https://kozyliving.in/search"), render)).text(), "ok");
  await assert.rejects(withRenderBudget(new Request("https://kozyliving.in/search"), async () => { throw new Error("failed"); }));
  assert.equal(await (await withRenderBudget(new Request("https://kozyliving.in/search"), render)).text(), "ok");
});

test("a response with a still-streaming body retains its render slot", async () => {
  const responses = await Promise.all(Array.from({ length: 16 }, () => withRenderBudget(
    new Request("https://kozyliving.in/search"), async () => new Response(new ReadableStream()))));
  assert.equal((await withRenderBudget(new Request("https://kozyliving.in/search"), async () => new Response("unexpected"))).status, 429);
  await Promise.all(responses.map((response) => response.body!.cancel()));
  assert.equal(await (await withRenderBudget(new Request("https://kozyliving.in/search"), async () => new Response("recovered"))).text(), "recovered");
});

test("webhook protection accepts only the configured secret", async () => {
  const request = (secret: string) => new Request(`https://kozyliving.in/api/revalidate?secret=${secret}`, { method: "POST" });
  assert.equal(await webhookAuthorized(request("valid"), "valid"), true);
  assert.equal(await webhookAuthorized(request("wrong"), "valid"), false);
  assert.equal(await webhookAuthorized(request(""), "valid"), false);
  assert.equal(await webhookAuthorized(request("valid"), undefined), false);
});

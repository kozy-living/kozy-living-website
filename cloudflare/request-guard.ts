/** Bound work even when callers rotate IPs, query strings or RSC headers.
 * This is a per-isolate concurrency limit, not a global traffic/spend cap. */
export const SHOP_PATH = /^\/(?:search(?:\/[^/]+)?|shop-by-colour|shop-by-mood)\/?$/;
export const SEARCH_API = "/api/search";
const MAX_ACTIVE = 16;
let active = 0;

export function busyResponse(): Response {
  return new Response("The shop is busy. Please retry shortly.", {
    status: 429,
    headers: { "retry-after": "10", "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" },
  });
}

export function prepareRequest(request: Request): Request | Response {
  const url = new URL(request.url);
  if (!SHOP_PATH.test(url.pathname) && url.pathname !== SEARCH_API) return request;
  if (request.url.length > 4096 || [...url.searchParams].length > 24) {
    return new Response("Search URL is too long.", { status: 414, headers: { "cache-control": "no-store" } });
  }
  // Next server-action POSTs may use the URL in their action response. Keep
  // their semantics untouched; only normalize public browse requests.
  if (request.method !== "GET" && request.method !== "HEAD") return request;
  const clean = new URL(url);
  for (const key of new Set(clean.searchParams.keys())) {
    if (/^(?:utm_|__kozy_)/i.test(key) || /^(?:gclid|fbclid|msclkid|dclid)$/i.test(key)) {
      clean.searchParams.delete(key);
    }
  }
  if (clean.searchParams.has("q")) {
    clean.searchParams.set("q", clean.searchParams.get("q")!.trim().slice(0, 80));
  }
  // Render this SAME normalized URL: changing only the cache key would let
  // attacker-controlled links/metadata poison another visitor's response.
  return clean.href === url.href ? request : new Request(clean.href, request);
}

export async function withRenderBudget(request: Request, render: (request: Request) => Promise<Response>): Promise<Response> {
  const url = new URL(request.url);
  if (!SHOP_PATH.test(url.pathname) && url.pathname !== SEARCH_API) return render(request);
  if (active >= MAX_ACTIVE) return busyResponse();
  active++;
  try {
    return await render(request);
  } finally {
    active--;
  }
}

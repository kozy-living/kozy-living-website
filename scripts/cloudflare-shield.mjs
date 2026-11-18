#!/usr/bin/env node
/**
 * The edge rules that stop a flood BEFORE it reaches the Worker, kept as
 * code so they cannot quietly disappear.
 *
 * Twice in November 2026 the protection that mattered lived only in a
 * dashboard (docs/vercel-hosting.md §4: "nothing in git will tell you if one
 * is switched off"). This script is that list, for Cloudflare:
 *
 *   npm run shield:apply    write the rules (idempotent; safe to re-run)
 *   npm run shield:check    compare the live zone with this file; exit 1 on
 *                           any drift, printing what differs
 *
 * Needs CLOUDFLARE_API_TOKEN (Zone: Zone Read, Zone WAF Edit, Bot Management
 * Edit, Zone Settings Read - docs/cloudflare-hosting.md §5). CF_ZONE_ID is
 * optional; without it the zone is looked up by name (ZONE_NAME, default
 * kozyliving.in).
 *
 *   PowerShell:  $env:CLOUDFLARE_API_TOKEN="..."; npm run shield:apply
 *   bash:        CLOUDFLARE_API_TOKEN=... npm run shield:apply
 *
 * Rules this script owns carry a `ref` starting `kozy-`. Rules added by
 * hand in the dashboard are kept, after these (order matters: the skip rule
 * must come first).
 */

// CF_API_BASE only exists so the script can be tested against a local fake.
const API = process.env.CF_API_BASE || "https://api.cloudflare.com/client/v4";
const ZONE_NAME = process.env.ZONE_NAME || "kozyliving.in";
const TOKEN = process.env.CLOUDFLARE_API_TOKEN;

// --- The rules -------------------------------------------------------------
// Expressions use only fields and functions the Free zone plan offers
// (no regex, no bot score).

const CUSTOM_RULES = [
  {
    ref: "kozy-skip-trusted",
    description:
      "Shopify webhooks, robots.txt and verified crawlers skip the rules below and the security level (so the automatic Under Attack shield never blocks them)",
    expression:
      '(http.request.uri.path eq "/api/revalidate" and http.request.method eq "POST") or http.request.uri.path eq "/robots.txt" or cf.client.bot',
    action: "skip",
    action_parameters: { ruleset: "current", products: ["securityLevel", "bic"] },
    logging: { enabled: true },
    enabled: true,
  },
  {
    ref: "kozy-block-probes",
    description: "Scanner probes for software this site does not run",
    expression:
      '(http.request.uri.path contains "/wp-") or (http.request.uri.path contains ".php") or starts_with(http.request.uri.path, "/.env") or starts_with(http.request.uri.path, "/.git")',
    action: "block",
    enabled: true,
  },
  {
    ref: "kozy-challenge-shop-abroad",
    description:
      "The Nov 16 2026 flood: the shop pages, from outside India (the store only delivers in India). Usually invisible to a real person",
    expression:
      '(starts_with(http.request.uri.path, "/search") or starts_with(http.request.uri.path, "/shop-by-")) and ip.src.country ne "IN" and not cf.client.bot',
    action: "managed_challenge",
    enabled: true,
  },
];

const RATE_LIMIT_RULES = [
  {
    ref: "kozy-ratelimit-search",
    description: "One address hammering the search: 30 requests in 10 s",
    expression: 'starts_with(http.request.uri.path, "/search")',
    action: "block",
    ratelimit: {
      characteristics: ["cf.colo.id", "ip.src"],
      period: 10,
      requests_per_period: 30,
      mitigation_timeout: 10,
    },
    enabled: true,
  },
];

const BOT_SETTINGS = {
  // AI-training crawlers: blocked (robots.txt asks the polite ones too).
  ai_bots_protection: "block",
  // Bot Fight Mode OFF: on the Free plan it cannot be skipped per path, and
  // it can challenge Shopify's webhook POSTs to /api/revalidate.
  fight_mode: false,
};

// --- API -------------------------------------------------------------------

async function cf(path, init = {}) {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
  });
  const body = await response.json().catch(() => ({}));
  if (response.status === 404) return { notFound: true, body };
  if (!response.ok || body.success === false) {
    const errors = (body.errors ?? []).map((e) => `${e.code}: ${e.message}`).join("; ");
    throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${errors || JSON.stringify(body)}`);
  }
  return body;
}

async function zoneId() {
  if (process.env.CF_ZONE_ID) return process.env.CF_ZONE_ID;
  const body = await cf(`/zones?name=${encodeURIComponent(ZONE_NAME)}`);
  const zone = body.result?.[0];
  if (!zone) throw new Error(`zone ${ZONE_NAME} not found for this token`);
  return zone.id;
}

async function entrypoint(zone, phase) {
  const body = await cf(`/zones/${zone}/rulesets/phases/${phase}/entrypoint`);
  return body.notFound ? [] : body.result?.rules ?? [];
}

/** Ours first, in order; anything added by hand kept after. */
function merged(existing, ours) {
  const manual = existing
    .filter((rule) => !String(rule.ref ?? "").startsWith("kozy-"))
    .map(({ id, version, last_updated, ...rule }) => rule);
  return [...ours, ...manual];
}

async function putEntrypoint(zone, phase, rules) {
  await cf(`/zones/${zone}/rulesets/phases/${phase}/entrypoint`, {
    method: "PUT",
    body: JSON.stringify({ rules }),
  });
}

// --- Compare ---------------------------------------------------------------

const FIELDS = ["expression", "action", "action_parameters", "ratelimit", "enabled"];

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((k) => [k, stable(value[k])]));
  }
  return value;
}

function diffRules(phase, live, wanted) {
  const problems = [];
  wanted.forEach((rule, index) => {
    const found = live.find((r) => r.ref === rule.ref);
    if (!found) return problems.push(`${phase}: missing rule ${rule.ref}`);
    if (live.indexOf(found) !== index) {
      problems.push(`${phase}: ${rule.ref} is at position ${live.indexOf(found) + 1}, should be ${index + 1}`);
    }
    for (const field of FIELDS) {
      if (rule[field] === undefined) continue;
      // The API may echo defaults back, so compare only what we set.
      const want = stable(rule[field]);
      const have = stable(
        field === "ratelimit" || field === "action_parameters"
          ? Object.fromEntries(Object.keys(rule[field]).map((k) => [k, found[field]?.[k]]))
          : found[field],
      );
      if (JSON.stringify(want) !== JSON.stringify(have)) {
        problems.push(`${phase}: ${rule.ref}.${field} is ${JSON.stringify(have)}, should be ${JSON.stringify(want)}`);
      }
    }
  });
  return problems;
}

// --- Commands --------------------------------------------------------------

async function apply(zone) {
  const custom = await entrypoint(zone, "http_request_firewall_custom");
  await putEntrypoint(zone, "http_request_firewall_custom", merged(custom, CUSTOM_RULES));
  console.log(`custom rules: ${CUSTOM_RULES.map((r) => r.ref).join(", ")}`);

  const limits = await entrypoint(zone, "http_ratelimit");
  await putEntrypoint(zone, "http_ratelimit", merged(limits, RATE_LIMIT_RULES));
  console.log(`rate limit:   ${RATE_LIMIT_RULES.map((r) => r.ref).join(", ")}`);

  await cf(`/zones/${zone}/bot_management`, { method: "PUT", body: JSON.stringify(BOT_SETTINGS) });
  console.log(`bots:         AI bots blocked, Bot Fight Mode off`);

  const problems = await check(zone, { quiet: true });
  if (problems.length) {
    console.error("\nApplied, but the zone still differs:\n  " + problems.join("\n  "));
    process.exitCode = 1;
    return;
  }
  console.log("\nApplied and verified.");
}

async function check(zone, { quiet = false } = {}) {
  const problems = [
    ...diffRules("custom", await entrypoint(zone, "http_request_firewall_custom"), CUSTOM_RULES),
    ...diffRules("ratelimit", await entrypoint(zone, "http_ratelimit"), RATE_LIMIT_RULES),
  ];

  const bots = (await cf(`/zones/${zone}/bot_management`)).result ?? {};
  for (const [key, value] of Object.entries(BOT_SETTINGS)) {
    if (bots[key] !== value) problems.push(`bots: ${key} is ${JSON.stringify(bots[key])}, should be ${JSON.stringify(value)}`);
  }

  if (!quiet) {
    const level = await cf(`/zones/${zone}/settings/security_level`).catch(() => null);
    const value = level?.result?.value ?? "unknown";
    console.log(
      `security level: ${value}${value === "under_attack" ? "  <- Under Attack is ON (the shield, or set by hand)" : ""}`,
    );
    if (problems.length) {
      console.error("DRIFT - run `npm run shield:apply`:\n  " + problems.join("\n  "));
      process.exitCode = 1;
    } else {
      console.log("All edge rules are in place.");
    }
  }
  return problems;
}

// Exit codes are set, never forced: `process.exit()` while fetch's sockets
// are still closing crashes Node on Windows (a libuv assertion, exit 127),
// which would turn a clean "drift found" into a crash.
const command = process.argv[2];
if (!TOKEN) {
  console.error("Set CLOUDFLARE_API_TOKEN first (docs/cloudflare-hosting.md §5).");
  process.exitCode = 2;
} else if (command !== "apply" && command !== "check") {
  console.error("usage: node scripts/cloudflare-shield.mjs apply|check");
  process.exitCode = 2;
} else {
  try {
    const zone = await zoneId();
    await (command === "apply" ? apply(zone) : check(zone));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

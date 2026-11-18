/**
 * The automatic shield: Cloudflare's "Under Attack" mode, switched on by
 * traffic and off again by calm, every 5 minutes (cron in wrangler.jsonc).
 *
 * Workers never pause a site for usage, so a flood cannot take the store
 * down here - but Cloudflare has no hard spend cap either, and a flood that
 * gets past the WAF rules is billed per request and per CPU-millisecond.
 * This is the cap: when the Worker's request count in the last five minutes
 * passes SHIELD_REQUESTS_PER_5MIN, every visitor is shown Cloudflare's
 * browser check before the site (a few seconds, once per visitor), which
 * bought traffic and bots mostly never pass. Real shoppers get through; the
 * Worker stops being invoked for the rest.
 *
 * - It only ever lowers a level IT raised. If someone sets Under Attack by
 *   hand, or lowers it by hand while the shield holds it, the shield steps
 *   back and leaves the setting to them.
 * - Under Attack hides the flood from the counter that raised it (challenged
 *   requests never reach the Worker), so "calm" alone would drop it within
 *   minutes and let the flood straight back in. It therefore HOLDS for at
 *   least `holdMs(strikes)`: 2h, doubling for each re-raise within a day,
 *   up to 24h. A flood that is still there gets 5 minutes in between.
 * - Shopify's webhooks, robots.txt and verified crawlers skip the security
 *   level (the `kozy-skip-trusted` rule, scripts/cloudflare-shield.mjs).
 * - Not configured (no token / ids) = does nothing. A failed API call = does
 *   nothing this round. It can never leave the site less protected than the
 *   dashboard already has it.
 */

export type ShieldState = {
  /** When the shield raised the level it is holding now (ms); 0 = not holding. */
  raisedAt: number;
  /** The most recent raise, kept after lowering, to count strikes. */
  lastRaisedAt: number;
  /** The level it found and will restore, e.g. "medium". */
  previousLevel: string;
  /** Raises within a day of each other; sets the hold length. */
  strikes: number;
};

export const IDLE: ShieldState = { raisedAt: 0, lastRaisedAt: 0, previousLevel: "", strikes: 0 };

const HOUR = 60 * 60 * 1000;

export function holdMs(strikes: number): number {
  return Math.min(24 * HOUR, 2 * HOUR * 2 ** Math.max(0, strikes - 1));
}

export type Decision =
  | { action: "raise"; state: ShieldState; reason: string }
  | { action: "lower"; level: string; state: ShieldState; reason: string }
  | { action: "none"; state: ShieldState; reason: string };

/**
 * Pure: what to do, given the last five minutes' requests, the zone's
 * current security level and what the shield remembers.
 */
export function decide(
  state: ShieldState,
  currentLevel: string,
  requests: number,
  threshold: number,
  now: number,
): Decision {
  const holding = state.raisedAt > 0;

  if (holding && currentLevel !== "under_attack") {
    return {
      action: "none",
      state: { ...state, raisedAt: 0, previousLevel: "" },
      reason: `lowered by hand to ${currentLevel}; shield stands down`,
    };
  }

  if (requests > threshold) {
    if (holding) {
      return { action: "none", state, reason: `still flooding (${requests} > ${threshold}); holding` };
    }
    if (currentLevel === "under_attack") {
      return { action: "none", state, reason: "flooding, but Under Attack was set by hand; leaving it" };
    }
    const strikes =
      state.strikes > 0 && now - state.lastRaisedAt < 24 * HOUR ? state.strikes + 1 : 1;
    return {
      action: "raise",
      state: { raisedAt: now, lastRaisedAt: now, previousLevel: currentLevel, strikes },
      reason: `${requests} requests in 5 min > ${threshold}; raising (strike ${strikes}, hold ${holdMs(strikes) / HOUR}h)`,
    };
  }

  if (holding) {
    const until = state.raisedAt + holdMs(state.strikes);
    if (now < until) {
      return { action: "none", state, reason: `calm (${requests}); holding until ${new Date(until).toISOString()}` };
    }
    const level = state.previousLevel || "medium";
    return {
      action: "lower",
      level,
      state: { ...state, raisedAt: 0, previousLevel: "" },
      reason: `hold over and calm (${requests}); restoring ${level}`,
    };
  }

  return { action: "none", state, reason: `calm (${requests} <= ${threshold})` };
}

// ---------------------------------------------------------------------------
// Effects: Cloudflare API and the state row.

export type ShieldEnv = {
  /** Secret. Zone Settings: Edit on the zone + Account Analytics: Read. */
  SHIELD_API_TOKEN?: string;
  CF_ACCOUNT_ID?: string;
  CF_ZONE_ID?: string;
  SHIELD_REQUESTS_PER_5MIN?: string;
  /** The worker's own name, to count its requests. */
  SHIELD_SCRIPT_NAME?: string;
  /** Shared with the tag cache; the shield keeps one row in its own table. */
  NEXT_TAG_CACHE_D1?: D1Database;
};

const API = "https://api.cloudflare.com/client/v4";

const isPlaceholder = (value: string | undefined) => !value || value.startsWith("REPLACE_");

async function api<T>(env: ShieldEnv, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.SHIELD_API_TOKEN}`,
      "content-type": "application/json",
      ...(init.headers ?? {}),
    },
  });
  const body = (await response.json()) as { success?: boolean; errors?: unknown; data?: unknown; result?: unknown };
  if (!response.ok || body.success === false || (body as { errors?: unknown[] }).errors?.length) {
    throw new Error(`${path}: ${response.status} ${JSON.stringify(body.errors ?? body)}`);
  }
  return body as T;
}

/** Requests the Worker handled between 6 and 1 minutes ago (analytics lag). */
async function recentRequests(env: ShieldEnv, now: number): Promise<number> {
  const query = `query ($account: String!, $script: String!, $from: Time!, $to: Time!) {
    viewer { accounts(filter: { accountTag: $account }) {
      workersInvocationsAdaptive(limit: 10000, filter: { scriptName: $script, datetime_geq: $from, datetime_leq: $to }) {
        sum { requests }
      }
    } }
  }`;
  const result = await api<{
    data: { viewer: { accounts: { workersInvocationsAdaptive: { sum: { requests: number } }[] }[] } };
  }>(env, "/graphql", {
    method: "POST",
    body: JSON.stringify({
      query,
      variables: {
        account: env.CF_ACCOUNT_ID,
        script: env.SHIELD_SCRIPT_NAME ?? "kozy-living",
        from: new Date(now - 6 * 60_000).toISOString(),
        to: new Date(now - 60_000).toISOString(),
      },
    }),
  });
  return (result.data.viewer.accounts[0]?.workersInvocationsAdaptive ?? []).reduce(
    (sum, row) => sum + (row.sum?.requests ?? 0),
    0,
  );
}

async function securityLevel(env: ShieldEnv): Promise<string> {
  const result = await api<{ result: { value: string } }>(env, `/zones/${env.CF_ZONE_ID}/settings/security_level`);
  return result.result.value;
}

async function setSecurityLevel(env: ShieldEnv, value: string): Promise<void> {
  await api(env, `/zones/${env.CF_ZONE_ID}/settings/security_level`, {
    method: "PATCH",
    body: JSON.stringify({ value }),
  });
}

async function loadState(db: D1Database): Promise<ShieldState> {
  await db
    .prepare("CREATE TABLE IF NOT EXISTS kozy_shield (id INTEGER PRIMARY KEY CHECK (id = 1), state TEXT NOT NULL)")
    .run();
  const row = await db.prepare("SELECT state FROM kozy_shield WHERE id = 1").first<{ state: string }>();
  return row ? { ...IDLE, ...(JSON.parse(row.state) as Partial<ShieldState>) } : IDLE;
}

async function saveState(db: D1Database, state: ShieldState): Promise<void> {
  await db
    .prepare("INSERT INTO kozy_shield (id, state) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state")
    .bind(JSON.stringify(state))
    .run();
}

export async function runShield(env: ShieldEnv, now = Date.now()): Promise<void> {
  if (isPlaceholder(env.SHIELD_API_TOKEN) || isPlaceholder(env.CF_ACCOUNT_ID) || isPlaceholder(env.CF_ZONE_ID) || !env.NEXT_TAG_CACHE_D1) {
    console.log("shield: not configured (SHIELD_API_TOKEN, CF_ACCOUNT_ID, CF_ZONE_ID) - doing nothing");
    return;
  }

  const threshold = Number(env.SHIELD_REQUESTS_PER_5MIN) || 3000;

  try {
    const [state, level, requests] = await Promise.all([
      loadState(env.NEXT_TAG_CACHE_D1),
      securityLevel(env),
      recentRequests(env, now),
    ]);

    const decision = decide(state, level, requests, threshold, now);

    if (decision.action === "raise") await setSecurityLevel(env, "under_attack");
    if (decision.action === "lower") await setSecurityLevel(env, decision.level);

    // Saved only after the API call succeeded, so a failed raise is retried
    // next round rather than remembered as done.
    await saveState(env.NEXT_TAG_CACHE_D1, decision.state);

    const log = decision.action === "none" ? console.log : console.warn;
    log(`shield: ${decision.action} - ${decision.reason}`);
  } catch (error) {
    console.error(`shield: skipped this round - ${(error as Error).message}`);
  }
}

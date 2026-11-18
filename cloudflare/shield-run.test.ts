// node --test cloudflare/shield-run.test.ts
// runShield end to end: a fake Cloudflare API (fetch) and the state table on
// real SQLite (node:sqlite stands in for D1, so the SQL itself is exercised).
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { runShield, type ShieldEnv } from "./shield.ts";

function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const prepare = (sql: string) => {
    let args: unknown[] = [];
    const stmt = {
      bind: (...a: unknown[]) => ((args = a), stmt),
      run: async () => (db.prepare(sql).run(...(args as never[])), { success: true }),
      first: async () => db.prepare(sql).get(...(args as never[])) ?? null,
    };
    return stmt;
  };
  return { prepare } as unknown as D1Database;
}

function fakeCloudflare(start: { level: string; requests: number }) {
  const live = { ...start, patches: [] as string[], failNextPatch: false };
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const url = String(input);
    assert.match(String((init?.headers as Record<string, string>).authorization), /^Bearer tok$/);
    if (url.endsWith("/graphql")) {
      const vars = JSON.parse(String(init!.body)).variables;
      assert.equal(vars.account, "acc");
      assert.equal(vars.script, "kozy-living");
      return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: [{ sum: { requests: live.requests } }] }] } }, errors: null });
    }
    if (url.endsWith("/zones/zone/settings/security_level")) {
      if (init?.method === "PATCH") {
        if (live.failNextPatch) { live.failNextPatch = false; return Response.json({ success: false, errors: [{ code: 1, message: "boom" }] }, { status: 500 }); }
        live.level = JSON.parse(String(init.body)).value;
        live.patches.push(live.level);
      }
      return Response.json({ success: true, errors: [], result: { value: live.level } });
    }
    throw new Error("unexpected " + url);
  }) as typeof fetch;
  return live;
}

const env = (db: D1Database): ShieldEnv => ({
  SHIELD_API_TOKEN: "tok",
  CF_ACCOUNT_ID: "acc",
  CF_ZONE_ID: "zone",
  SHIELD_SCRIPT_NAME: "kozy-living",
  SHIELD_REQUESTS_PER_5MIN: "3000",
  NEXT_TAG_CACHE_D1: db,
});

const H = 60 * 60 * 1000;

test("a flood raises, holds, and is lowered back to the level it found", async () => {
  const cf = fakeCloudflare({ level: "medium", requests: 9000 });
  const db = fakeD1();
  let t = Date.UTC(2026, 10, 16, 12);

  await runShield(env(db), t);
  assert.deepEqual(cf.patches, ["under_attack"]);

  cf.requests = 0; // the challenge hides the flood
  for (let i = 0; i < 23; i++) { t += 5 * 60_000; await runShield(env(db), t); }
  assert.deepEqual(cf.patches, ["under_attack"], "held through the 2h window");

  t += 10 * 60_000;
  await runShield(env(db), t);
  assert.deepEqual(cf.patches, ["under_attack", "medium"]);

  t += 5 * 60_000;
  await runShield(env(db), t);
  assert.deepEqual(cf.patches, ["under_attack", "medium"], "nothing more once lowered");
});

test("a failed raise is retried next round, not remembered as done", async () => {
  const cf = fakeCloudflare({ level: "medium", requests: 9000 });
  const db = fakeD1();
  cf.failNextPatch = true;
  await runShield(env(db), Date.UTC(2026, 10, 16, 12));
  assert.deepEqual(cf.patches, []);
  await runShield(env(db), Date.UTC(2026, 10, 16, 12, 5));
  assert.deepEqual(cf.patches, ["under_attack"]);
});

test("placeholders from wrangler.jsonc mean 'not configured': no API calls", async () => {
  globalThis.fetch = (() => { throw new Error("must not call the API"); }) as typeof fetch;
  await runShield({ ...env(fakeD1()), CF_ZONE_ID: "REPLACE_WITH_ZONE_ID" });
  await runShield({ ...env(fakeD1()), SHIELD_API_TOKEN: undefined });
});

test("an API outage is a skipped round, never a thrown cron", async () => {
  globalThis.fetch = (async () => { throw new Error("network down"); }) as typeof fetch;
  await runShield(env(fakeD1()));
});

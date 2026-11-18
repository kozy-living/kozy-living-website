import { test } from "node:test";
import assert from "node:assert/strict";
import { configProblems, readConfig } from "./protection-config.mjs";
import { CUSTOM_RULES, RATE_LIMIT_RULES, diffRules } from "./cloudflare-shield.mjs";

test("deployment rejects placeholders and unprotected entry points", async () => {
  const config = await readConfig();
  config.d1_databases[0].database_id = "12345678-1234-1234-1234-123456789abc";
  assert.deepEqual(configProblems(config), []);
  config.vars.CF_ZONE_ID = "REPLACE_WITH_ZONE_ID";
  config.main = ".open-next/worker.js";
  config.workers_dev = true;
  assert.equal(configProblems(config).length, 3);
});

test("disabled, reordered and missing firewall rules fail verification", () => {
  assert.deepEqual(diffRules("custom", CUSTOM_RULES, CUSTOM_RULES), []);
  assert.ok(diffRules("custom", CUSTOM_RULES.slice(1), CUSTOM_RULES).length);
  const disabled = structuredClone(CUSTOM_RULES);
  disabled[1].enabled = false;
  assert.ok(diffRules("custom", disabled, CUSTOM_RULES).some((message) => message.includes("enabled")));
  assert.ok(diffRules("custom", [...CUSTOM_RULES].reverse(), CUSTOM_RULES).some((message) => message.includes("position")));
  assert.match(RATE_LIMIT_RULES[0].expression, /\/api\/search/);
});

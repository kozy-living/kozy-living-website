import { readFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

export async function readConfig() {
  const file = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const parsed = ts.parseConfigFileTextToJson(file, await readFile(file, "utf8"));
  if (parsed.error) throw new Error("wrangler.jsonc is invalid JSONC");
  return parsed.config;
}

export function configProblems(config) {
  const errors = [];
  for (const [key, value] of Object.entries({ account_id: config.account_id,
    CF_ACCOUNT_ID: config.vars?.CF_ACCOUNT_ID, CF_ZONE_ID: config.vars?.CF_ZONE_ID })) {
    if (!/^[a-f0-9]{32}$/.test(value ?? "")) errors.push(`${key} must be a real Cloudflare ID`);
  }
  if (config.account_id !== config.vars?.CF_ACCOUNT_ID) errors.push("Worker and shield account IDs must match");
  if (!/^[a-f0-9-]{36}$/.test(config.d1_databases?.[0]?.database_id ?? "")) errors.push("Create the D1 cache database and configure its database_id");
  if (config.main !== "cloudflare/worker.ts") errors.push("main must use the protected Worker entry point");
  if (config.workers_dev !== false || config.preview_urls !== false) errors.push("Public preview URLs must be disabled");
  if (config.version_metadata?.binding !== "VERSION_METADATA") errors.push("Cache separation needs the VERSION_METADATA binding");
  if (!(config.limits?.cpu_ms > 0 && config.limits.cpu_ms <= 1000)) errors.push("Set a per-request CPU limit of at most 1000 ms");
  const threshold = Number(config.vars?.SHIELD_REQUESTS_PER_5MIN);
  if (!Number.isInteger(threshold) || threshold < 1 || threshold > 300) errors.push("Shield threshold must be between 1 and 300 requests per five minutes; review before increasing");
  if (!config.triggers?.crons?.includes("*/5 * * * *")) errors.push("The shield needs its five-minute cron trigger");
  return errors;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const errors = configProblems(await readConfig());
    if (errors.length) throw new Error(errors.join("\n"));
    console.log("Protection configuration is complete.");
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

// OpenNext 1.20.17 sends quoted SQL through npm exec + cmd.exe. On this
// Windows installation its ALTER TABLE command hangs. Keep OpenNext's R2
// seeding and skew protection, but pass D1 SQL/CLI arguments without a shell.
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const wrangler = fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url));
const cli = new URL("../cli/commands/", import.meta.resolve("@opennextjs/cloudflare"));
const run = (args, extraEnv = {}) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [wrangler, ...args], {
    stdio: "inherit", env: { ...process.env, ...extraEnv, CI: "true" },
  });
  child.once("error", reject);
  child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Wrangler ${args[0]} failed (${code})`)));
});

try {
  const command = process.argv[2];
  if (command !== "preview" && command !== "deploy") throw new Error("Usage: node scripts/cloudflare-run.mjs preview|deploy [Wrangler arguments]");
  const { getNormalizedOptions, readWranglerConfig, retrieveCompiledConfig } = await import(new URL("utils/utils.js", cli));
  const { getEnvFromPlatformProxy } = await import(new URL("utils/helpers.js", cli));
  const { populateCache } = await import(new URL("populate-cache.js", cli));
  const { config } = await retrieveCompiledConfig();
  const buildOpts = getNormalizedOptions(config);
  const wranglerConfig = await readWranglerConfig({});
  const envVars = await getEnvFromPlatformProxy({}, buildOpts);
  const target = command === "deploy" ? "remote" : "local";
  // This flag affects ONLY seeding in this process. The deployed tag-cache
  // implementation and compiled application configuration stay enabled.
  await populateCache(buildOpts, { ...config, dangerous: { ...config.dangerous, disableTagCache: true } },
    wranglerConfig, { target, shouldUsePreviewId: false }, envVars);
  const d1 = ["d1", "execute", "NEXT_TAG_CACHE_D1", `--${target}`];
  await run([...d1, "--command", "CREATE TABLE IF NOT EXISTS revalidations (tag TEXT NOT NULL, revalidatedAt INTEGER NOT NULL, stale INTEGER, expire INTEGER DEFAULT NULL, UNIQUE(tag) ON CONFLICT REPLACE)"]);
  const { stdout } = await promisify(execFile)(process.execPath, [wrangler, ...d1, "--command", "PRAGMA table_info(revalidations)", "--json"], {
    env: { ...process.env, CI: "true" }, timeout: 30_000,
  });
  const columns = new Set(JSON.parse(stdout).flatMap((entry) => entry.results).map((column) => column.name));
  for (const column of ["stale", "expire"]) {
    if (!columns.has(column)) await run([...d1, "--command", `ALTER TABLE revalidations ADD COLUMN ${column} INTEGER`]);
  }
  if (command === "deploy") {
    const { getDeploymentMapping } = await import(new URL("skew-protection.js", cli));
    const mapping = await getDeploymentMapping(buildOpts, config, envVars);
    const { DEPLOYMENT_MAPPING_ENV_NAME } = await import(new URL("../templates/skew-protection.js", cli));
    await run(["deploy", ...process.argv.slice(3), ...(mapping ? ["--var", `${DEPLOYMENT_MAPPING_ENV_NAME}:${JSON.stringify(mapping)}`] : [])], { OPEN_NEXT_DEPLOY: "true" });
  } else {
    await run(["dev", "--local", ...process.argv.slice(3)]);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

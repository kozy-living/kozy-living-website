// Values travel over stdin to Wrangler; no secrets are logged or put in argv.
import { readFile } from "node:fs/promises";
import { parseEnv } from "node:util";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

try {
  const app = parseEnv(await readFile(new URL("../.env", import.meta.url), "utf8"));
  const protection = parseEnv(await readFile(new URL("../.env.protection.local", import.meta.url), "utf8"));
  if (!protection.SHIELD_API_TOKEN) throw new Error("Set SHIELD_API_TOKEN in .env.protection.local first");
  const secrets = { ...app, SHIELD_API_TOKEN: protection.SHIELD_API_TOKEN };
  delete secrets.CLOUDFLARE_API_TOKEN;
  const child = spawn(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)), "secret", "bulk"], {
    cwd: fileURLToPath(new URL("..", import.meta.url)), env: { ...process.env, CI: "true" }, stdio: ["pipe", "inherit", "inherit"],
  });
  child.stdin.on("error", () => {});
  child.stdin.end(JSON.stringify(secrets));
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

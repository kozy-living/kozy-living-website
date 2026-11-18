import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

try {
  const { stdout } = await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)), "secret", "list", "--format", "json",
  ], { env: { ...process.env, CI: "true" }, timeout: 30_000 });
  const names = new Set(JSON.parse(stdout).map((secret) => secret.name));
  const missing = ["SHIELD_API_TOKEN", "SHOPIFY_REVALIDATION_SECRET", "SHOPIFY_STORE_DOMAIN"].filter((name) => !names.has(name));
  if (missing.length) throw new Error(`Missing Worker secrets: ${missing.join(", ")}. Run npm run protection:secrets.`);
  console.log("Required Worker secrets are present (values not read).");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}

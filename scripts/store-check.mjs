// Verify the application behind the edge challenge in a real browser.
import { chromium } from "playwright";

const base = process.env.STORE_URL || "https://kozyliving.in";
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  for (const path of ["/", "/search"]) {
    const response = await page.goto(new URL(path, base).href, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (!response?.ok()) throw new Error(`${path}: HTTP ${response?.status() ?? "no response"}`);
    await page.locator("main").waitFor({ timeout: 20_000 });
    if (!/kozy/i.test(await page.locator("body").innerText())) throw new Error(`${path}: storefront content missing`);
    if (path === "/search") await page.locator('main a[href^="/product/"]').first().waitFor({ timeout: 20_000 });
    console.log(`${path}: storefront rendered`);
  }
  const sitemap = await context.request.get(new URL("/sitemap.xml", base).href);
  if (!sitemap.ok() || !(await sitemap.text()).includes("<urlset")) throw new Error("Sitemap unavailable or challenged");
  const health = await context.request.get(new URL("/api/protection-health", base).href);
  if (!health.ok()) throw new Error(`Protection probe unhealthy: HTTP ${health.status()}`);
  if (!(await health.json()).shield?.healthy) throw new Error("Automatic shield has not completed a successful check in 15 minutes");
  console.log("Sitemap and automatic shield are healthy.");
} catch (error) {
  console.error(`STORE CHECK FAILED: ${error.message}`);
  console.error("A security checkpoint can hide an origin outage. Verify the store in a browser; do not mark a challenge response as healthy.");
  process.exitCode = 1;
} finally {
  await browser.close();
}

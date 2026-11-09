// Regenerates docs/screenshot.png for the README: a headless Chrome logs in with a fresh one-time link,
// shares the built-in mock device, sends PING and captures the page. Needs a running backend + sandbox.
//   node scripts/screenshot.mjs [--dark]
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

const port = Number(process.env.PORT ?? 47831);
const token = (await readFile(".runtime/admin-token", "utf8")).trim();
const r = await fetch(`http://127.0.0.1:${port}/admin/session-link`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});
if (!r.ok) throw Error(`backend refused to mint a link (HTTP ${r.status})`);
const { url } = await r.json();

const browser = await chromium.launch({ channel: "chrome" });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1180 },
  deviceScaleFactor: 2,
  colorScheme: process.argv.includes("--dark") ? "dark" : "light",
});
try {
  await page.goto(url);
  await page.getByText("Browser bridge online").waitFor();
  await page.getByRole("button", { name: "Add mock", exact: true }).click();
  await page.getByRole("button", { name: "Open & share" }).click();
  await page.getByText("Shared", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Send input" }).click();
  await page.getByLabel("Serial monitor").getByText("PONG").first().waitFor();
  await page.waitForTimeout(1500); // let the terminals draw their prompts
  // Show the sandbox seeing the shared device.
  await page.locator(".xterm").first().click();
  await page.keyboard.type("clear; device list\n");
  await page.waitForTimeout(2500);
  await page.screenshot({ path: "docs/screenshot.png" });
  console.log("wrote docs/screenshot.png");
  // Leave nothing shared behind.
  await page.getByRole("button", { name: "Revoke access" }).click();
} finally {
  await browser.close();
}

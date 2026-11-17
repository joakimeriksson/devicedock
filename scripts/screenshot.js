// Regenerates docs/screenshot.png for the README: a headless Chrome logs in with a fresh one-time link,
// shares the built-in mock device, sends PING and captures the page. Needs a running backend + sandbox, and is run
// from the folder that holds its .runtime (PORT picks another backend).
//   deno run --allow-all scripts/screenshot.js [--dark]
import { click, launchChrome, openPage, waitForText } from "../tests/browser/browser.js";

const port = Number(Deno.env.get("PORT") ?? 47831);
const token = (await Deno.readTextFile(".runtime/admin-token")).trim();
const r = await fetch(`http://127.0.0.1:${port}/admin/session-link`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}` },
});
if (!r.ok) throw Error(`backend refused to mint a link (HTTP ${r.status})`);
const { url } = await r.json();

const browser = await launchChrome();
try {
  const { page } = await openPage(browser, url, { width: 1440, height: 1180, scale: 2, dark: Deno.args.includes("--dark") });
  await waitForText(page, ".status-text", "Browser bridge online", { exact: true });
  await click(page, "button", "Add mock");
  await click(page, "button", "Open & share");
  await waitForText(page, ".badge", "Shared", { exact: true });
  await click(page, "button", "Send input");
  await waitForText(page, ".monitor-log", "PONG");
  await new Promise((r) => setTimeout(r, 1500)); // let the terminals draw their prompts
  // Show the sandbox seeing the shared device.
  await (await page.$(".xterm"))?.click();
  await page.keyboard.type("clear; device list");
  await page.keyboard.press("Enter");
  await new Promise((r) => setTimeout(r, 2500));
  await Deno.writeFile("docs/screenshot.png", await page.screenshot());
  console.log("wrote docs/screenshot.png");
  // Leave nothing shared behind.
  await click(page, "button", "Revoke access");
} finally {
  await browser.close();
}

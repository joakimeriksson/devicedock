// Browser smoke test for the Rust backend: starts the binary in a scratch directory on a spare port (never touching
// a running DeviceDock), logs in with a minted one-time link, shares the built-in mock device and round-trips PING.
//   node tests/rust/browser-smoke.mjs [path/to/devicedock] [screenshot.png]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const bin = resolve(process.argv[2] ?? "server-rs/target/release/devicedock");
const shot = process.argv[3];
const port = 47964;
const dir = mkdtempSync(join(tmpdir(), "dd-smoke-"));
mkdirSync(join(dir, ".runtime"));
// No ./dist in the scratch directory, so the UI comes from the copy embedded in the binary.
const proc = spawn(bin, ["serve"], { cwd: dir, env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "pipe", "inherit"] });
await new Promise((ok, fail) => {
  proc.stdout.on("data", (d) => String(d).includes("listening") && ok());
  proc.on("exit", (c) => fail(Error(`backend exited ${c}`)));
});
const browser = await chromium.launch({ channel: "chrome" });
try {
  const token = readFileSync(join(dir, ".runtime/admin-token"), "utf8").trim();
  const r = await fetch(`http://127.0.0.1:${port}/admin/session-link`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  const { url } = await r.json();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  await page.getByText("Browser bridge online").waitFor({ timeout: 15000 });
  await page.getByRole("button", { name: "Add mock", exact: true }).click();
  await page.getByRole("button", { name: "Open & share" }).click();
  await page.getByText("Shared", { exact: true }).waitFor();
  await page.getByRole("button", { name: "Send input" }).click();
  await page.getByLabel("Serial monitor").getByText("PONG").first().waitFor();
  if (shot) await page.screenshot({ path: shot });
  await page.getByRole("button", { name: "Revoke access" }).click();
  if (errors.length) throw Error("page errors: " + errors.join("; "));
  console.log("browser smoke OK: login, device WebSocket, mock share, PING -> PONG");
} finally {
  await browser.close();
  proc.kill("SIGTERM");
}

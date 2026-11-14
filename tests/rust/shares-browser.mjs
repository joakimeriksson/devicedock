// Browser test for the Shared folders panel: starts the binary in a scratch directory on a spare port with a fake
// home folder and DEVICEDOCK_TEST=1 (no bridge, no tunnel; with the fake HOME the docker CLI usually cannot reach a
// Colima/Desktop context either, which the page reports as terminal errors), then browses, shares, changes and removes a folder.
// It never clicks "Restart sandbox", so a running DeviceDock sandbox is not touched.
//   node tests/rust/shares-browser.mjs [path/to/devicedock] [screenshot.png]
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "@playwright/test";

const bin = resolve(process.argv[2] ?? "server-rs/target/release/devicedock");
const shot = process.argv[3];
const port = 47965;
const dir = realpathSync(mkdtempSync(join(tmpdir(), "dd-shares-")));
const home = join(dir, "home");
for (const d of [".runtime", "home/work/proj", "home/work/other", "home/.ssh", "home/Library"]) mkdirSync(join(dir, d), { recursive: true });
const proc = spawn(bin, ["serve"], {
  cwd: dir,
  env: { ...process.env, PORT: String(port), HOME: home, DEVICEDOCK_TEST: "1" },
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((ok, fail) => {
  proc.stdout.on("data", (d) => String(d).includes("listening") && ok());
  proc.on("exit", (c) => fail(Error(`backend exited ${c}`)));
});
const stored = () => JSON.parse(readFileSync(join(dir, ".runtime/shares.json"), "utf8")).shares;
const expect = (ok, what) => {
  if (!ok) throw Error(what);
};
const browser = await chromium.launch({ channel: "chrome" });
try {
  const token = readFileSync(join(dir, ".runtime/admin-token"), "utf8").trim();
  const r = await fetch(`http://127.0.0.1:${port}/admin/session-link`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  const { url } = await r.json();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1300 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  const panel = page.locator("section.shares");
  await panel.getByText("Shared folders").waitFor({ timeout: 15000 });

  // Browse from the fake home: hidden folders and Library are not listed, home itself cannot be shared.
  await panel.getByRole("button", { name: "Add a folder…" }).click();
  await panel.locator(".share-crumb code", { hasText: "~" }).waitFor();
  const names = await panel.locator(".share-dirs button").allTextContents();
  expect(JSON.stringify(names) === JSON.stringify(["work"]), `home listing: ${names}`);
  expect(await panel.getByRole("button", { name: "Share ~", exact: true }).isDisabled(), "home is shareable");
  await panel.getByText("whole home folder").waitFor();

  // Into ~/work/proj and share it.
  await panel.locator(".share-dirs button", { hasText: "work" }).click();
  await panel.locator(".share-dirs button", { hasText: "proj" }).click();
  await panel.getByRole("button", { name: "Share ~/work/proj" }).click();
  await panel.locator(".share-list").getByText("~/work/proj").waitFor();
  await panel.getByText("/shares/proj").waitFor();
  expect(stored().length === 1 && stored()[0].path === join(home, "work/proj") && !stored()[0].readonly, "stored share");

  // Read-only toggle is stored.
  // (The checkbox follows the backend's answer, so click and wait for it rather than Playwright's check().)
  await panel.getByLabel("read-only").click();
  await page.waitForFunction(() => document.querySelector("section.shares .share-ro input")?.checked);
  expect(stored()[0].readonly === true, "read-only not stored");

  // A typed hidden folder is refused with the reason.
  await panel.getByRole("button", { name: "Add a folder…" }).click();
  await panel.getByLabel("Folder path to share").fill("~/.ssh");
  await panel.getByRole("button", { name: "Share", exact: true }).click();
  await panel.getByText("Hidden folders (.ssh) are not shared").waitFor();
  await panel.getByRole("button", { name: "Cancel" }).click();
  if (shot) await panel.screenshot({ path: shot });

  // Remove it again.
  await panel.getByRole("button", { name: "Stop sharing ~/work/proj" }).click();
  await panel.getByText("none", { exact: true }).waitFor();
  expect(stored().length === 0, "share not removed");
  if (errors.length) throw Error("page errors: " + errors.join("; "));
  console.log("shares browser test OK: browse, refuse home/hidden, share, read-only, remove");
} finally {
  await browser.close();
  proc.kill("SIGTERM");
}

import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const port = Number(process.env.PORT ?? 47831);
// Prefer a fresh one-time link minted by the running backend (works after the first link was used or the
// session expired, without a restart); fall back to the link written when the backend started.
async function freshLink() {
  try {
    const token = (await readFile(".runtime/admin-token", "utf8")).trim();
    const r = await fetch(`http://127.0.0.1:${port}/admin/session-link`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(4000),
    });
    if (r.ok) return (await r.json()).url;
    console.error(`Backend refused to mint a link (HTTP ${r.status}); using the startup link.`);
  } catch (e) {
    console.error(`Could not reach the backend to mint a link (${e.message}); using the startup link.`);
  }
}
const link = (await freshLink()) ?? (await readFile(".runtime/session-link", "utf8")).trim();
// WebSerial needs Chrome/Edge, and the one-time link is spent by whichever browser opens it first.
// Override with BROWSER_APP="Microsoft Edge" (macOS app name).
const app = process.env.BROWSER_APP ?? "Google Chrome";
spawn(
  process.platform === "darwin" ? "open" : "xdg-open",
  process.platform === "darwin" ? ["-a", app, link] : [link],
  { stdio: "ignore" },
);
console.log(`Opened a login link in ${process.platform === "darwin" ? app : "your browser"}.`);

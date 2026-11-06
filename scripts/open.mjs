import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const link = (await readFile(".runtime/session-link", "utf8")).trim();
// WebSerial needs Chrome/Edge, and the one-time link is spent by whichever browser opens it first.
// Override with BROWSER_APP="Microsoft Edge" (macOS app name).
const app = process.env.BROWSER_APP ?? "Google Chrome";
spawn(
  process.platform === "darwin" ? "open" : "xdg-open",
  process.platform === "darwin" ? ["-a", app, link] : [link],
  { stdio: "ignore" },
);
console.log(`Opened the session link in ${process.platform === "darwin" ? app : "your browser"}.`);

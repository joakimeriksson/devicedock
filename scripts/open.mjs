import { readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const link = (await readFile(".runtime/session-link", "utf8")).trim();
spawn(process.platform === "darwin" ? "open" : "xdg-open", [link], {
  stdio: "ignore",
});

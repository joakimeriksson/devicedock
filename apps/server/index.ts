import { mkdir, writeFile, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createApp } from "./app.ts";
const port = Number(process.env.PORT ?? 47831);
// The admin token authorises `./devicedock.sh open` to mint a fresh login link without a restart. It lives only on
// the Mac (mode 0600) and is never given to the container, unlike the bridge token.
await mkdir(".runtime", { recursive: true, mode: 0o700 });
let adminToken: string;
try {
  adminToken = (await readFile(".runtime/admin-token", "utf8")).trim();
  if (adminToken.length < 32) throw new Error("short");
} catch {
  adminToken = randomBytes(32).toString("hex");
  await writeFile(".runtime/admin-token", adminToken, { mode: 0o600 });
}
const runtime = createApp({ port, adminToken });

try {
  // Do not replace the active server's bootstrap link unless we own the port.
  await new Promise<void>((resolve, reject) => {
    runtime.server.once("error", reject);
    runtime.server.listen(port, "127.0.0.1", () => {
      runtime.server.removeListener("error", reject);
      resolve();
    });
  });
  await mkdir(".runtime", { recursive: true, mode: 0o700 });
  await writeFile(
    ".runtime/session-link",
    `${runtime.origin}/#token=${runtime.bootstrap}`,
    { mode: 0o600 },
  );
  console.log(
    `DeviceDock listening on ${runtime.origin}. Run npm run open to authenticate in your browser.`,
  );
} catch (error) {
  const code = (error as NodeJS.ErrnoException).code;
  console.error(
    code === "EADDRINUSE"
      ? `Port ${port} is already in use. If DeviceDock is already running, use npm run open. Otherwise stop the process using that port and run npm start again.`
      : `DeviceDock could not start: ${(error as Error).message}`,
  );
  await runtime.close();
  process.exit(1);
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    void runtime.close().then(() => process.exit());
  });

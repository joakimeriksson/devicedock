import { mkdir, writeFile } from "node:fs/promises";
import { createApp } from "./app.ts";
const port = Number(process.env.PORT ?? 47831);
const runtime = createApp({ port });

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

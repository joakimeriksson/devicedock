import { defineConfig } from "@playwright/test";

// The browser test runs its own backend on another port, in a scratch working directory with its own build of the
// page, so it never touches the .runtime or dist/ of a DeviceDock that is already running.
// DEVICEDOCK_TEST=1: no sandbox bridge, no network tunnel.
const port = 47941;
export default defineConfig({
  testDir: "tests/browser",
  use: { baseURL: `http://127.0.0.1:${port}`, channel: "chrome" },
  workers: 1,
  webServer: {
    command:
      "npx vite build -l warn --config apps/web/vite.config.ts --outDir ../../test-results/backend/dist --emptyOutDir && " +
      "cargo build -q --manifest-path server-rs/Cargo.toml && " +
      "cd test-results/backend && ../../server-rs/target/debug/devicedock serve",
    env: { PORT: String(port), DEVICEDOCK_TEST: "1" },
    url: `http://127.0.0.1:${port}`,
    reuseExistingServer: false,
    timeout: 300_000,
  },
});

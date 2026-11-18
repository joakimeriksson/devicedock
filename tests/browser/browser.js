// Helpers for the browser tests and scripts/screenshot.js: a backend of their own in a scratch working directory, and
// headless Chrome driven with Astral. Nothing here touches a DeviceDock that is already running.
import { launch } from "@astral/astral";

const root = new URL("../../", import.meta.url).pathname;

/**
 * Builds (unless DEVICEDOCK_BIN names a binary) and starts the backend in a new scratch directory with
 * DEVICEDOCK_TEST=1 (no sandbox bridge, no network tunnel), on `port`. The scratch directory has no apps/web, so the
 * page comes from the binary (a debug build reads it from the source tree, a release build has it embedded).
 * @param {{ port: number, env?: (dir: string) => Record<string, string>, setup?: (dir: string) => Promise<void> | void }} opts
 *   `env` adds to the environment (it gets the scratch directory); `setup` prepares the directory before the start.
 */
export async function startBackend({ port, env = () => ({}), setup }) {
  let bin = Deno.env.get("DEVICEDOCK_BIN");
  if (!bin) {
    const build = await new Deno.Command("cargo", {
      args: ["build", "-q", "--manifest-path", `${root}server-rs/Cargo.toml`],
      stdout: "inherit",
      stderr: "inherit",
    }).output();
    if (!build.success) throw Error("cargo build failed");
    bin = `${root}server-rs/target/debug/devicedock`;
  }
  bin = await Deno.realPath(bin); // the backend runs in the scratch directory
  const dir = await Deno.realPath(await Deno.makeTempDir({ prefix: "dd-browser-" }));
  await Deno.mkdir(`${dir}/.runtime`);
  await setup?.(dir);
  const proc = new Deno.Command(bin, {
    args: ["serve"],
    cwd: dir,
    // DOCKER_HOST points nowhere, so the page's terminals cannot reach the sandbox of a DeviceDock that is running on
    // this machine (they show "could not start" instead).
    env: { PORT: String(port), DEVICEDOCK_TEST: "1", DOCKER_HOST: "unix:///nonexistent/devicedock-test.sock", ...env(dir) },
    stdout: "piped",
    // The terminals' "could not start" errors are expected here; DEVICEDOCK_TEST_LOG=1 shows the backend's log.
    stderr: Deno.env.get("DEVICEDOCK_TEST_LOG") ? "inherit" : "null",
  }).spawn();
  // Wait for "listening", then keep draining stdout so the backend never blocks on a full pipe.
  const reader = proc.stdout.pipeThrough(new TextDecoderStream()).getReader();
  let seen = "";
  while (!seen.includes("listening")) {
    const { value, done } = await reader.read();
    if (done) throw Error(`backend exited before listening: ${seen}`);
    seen += value;
  }
  const drained = (async () => {
    while (!(await reader.read()).done);
  })();
  const origin = `http://127.0.0.1:${port}`;
  return {
    dir,
    origin,
    /** A fresh one-time login link, minted with the admin token. */
    async loginUrl() {
      const token = (await Deno.readTextFile(`${dir}/.runtime/admin-token`)).trim();
      const r = await fetch(`${origin}/admin/session-link`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) throw Error(`backend refused to mint a link (HTTP ${r.status})`);
      return (await r.json()).url;
    },
    async stop() {
      try {
        proc.kill("SIGTERM");
      } catch {}
      await proc.status;
      await drained.catch(() => {});
      await Deno.remove(dir, { recursive: true }).catch(() => {});
    },
  };
}

/** Chrome: CHROME_PATH, else an installed Chrome, else the one Astral downloads. */
export function launchChrome() {
  const candidates = [
    Deno.env.get("CHROME_PATH"),
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
  ];
  const path = candidates.find((p) => {
    try {
      return p && Deno.statSync(p).isFile;
    } catch {
      return false;
    }
  });
  // GitHub's Ubuntu runners do not let Chrome set up its own sandbox (as with Playwright, which turns it off too).
  const args = Deno.build.os === "linux" && Deno.env.get("CI") ? ["--no-sandbox"] : [];
  return launch({ ...(path ? { path } : {}), args });
}

/**
 * Opens a page at `url` with the given viewport and colour scheme, collecting uncaught page errors in `errors`.
 * @param {import("@astral/astral").Browser} browser
 * @param {{ width: number, height: number, scale?: number, dark?: boolean }} view
 */
export async function openPage(browser, url, view) {
  const page = await browser.newPage();
  const cdp = page.unsafelyGetCelestialBindings();
  await cdp.Emulation.setDeviceMetricsOverride({ width: view.width, height: view.height, deviceScaleFactor: view.scale ?? 1, mobile: false });
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: view.dark ? "dark" : "light" }]);
  const errors = [];
  page.addEventListener("pageerror", (e) => errors.push(String(e.detail?.message ?? e.detail)));
  await page.goto(url, { waitUntil: "load" });
  return { page, errors };
}

/** Polls `fn` in the page until it returns something truthy; returns that. */
export async function waitFor(page, fn, args = [], what = String(fn), timeout = 15000) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await page.evaluate(fn, { args });
    if (v) return v;
    if (Date.now() > end) throw Error(`timed out waiting for: ${what}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Elements are found the way a person would: by their visible text or aria-label, among those that are shown.
// `scope` narrows the search to a CSS selector. These run in the page.
function find(selector, name, exact, scope) {
  const shown = (el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length) && !el.closest("[hidden]");
  const label = (el) => (el.getAttribute("aria-label") ?? el.closest("label")?.textContent ?? el.textContent ?? "").trim();
  const base = scope ? document.querySelector(scope) : document;
  return [...(base?.querySelectorAll(selector) ?? [])].filter(
    (el) => shown(el) && (exact ? label(el) === name : label(el).includes(name)),
  );
}
const finder = `(${find})`;

/** How many shown elements match `selector` with this name. */
export function count(page, selector, name, { exact = true, scope } = {}) {
  return page.evaluate(`${finder}(${JSON.stringify(selector)}, ${JSON.stringify(name)}, ${exact}, ${JSON.stringify(scope)}).length`);
}

/** Waits until no shown element matches `selector` with this name. */
export function waitForNone(page, selector, name, { exact = true, scope } = {}) {
  const js = `${finder}(${JSON.stringify(selector)}, ${JSON.stringify(name)}, ${exact}, ${JSON.stringify(scope)}).length === 0`;
  return waitFor(page, js, [], `no ${selector} "${name}"`);
}

/** Waits for one shown element matching `selector` and `name`, then clicks it (a DOM click). */
export async function click(page, selector, name, { exact = true, scope } = {}) {
  const js = `(() => { const el = ${finder}(${JSON.stringify(selector)}, ${JSON.stringify(name)}, ${exact}, ${JSON.stringify(scope)})[0];
    if (!el || el.disabled) return false; el.click(); return true; })()`;
  await waitFor(page, js, [], `${selector} "${name}"`);
}

/** Types into a text field the way a user does: the value changes and an input event fires. */
export async function fill(page, selector, name, value, { scope } = {}) {
  const js = `(() => { const el = ${finder}(${JSON.stringify(selector)}, ${JSON.stringify(name)}, true, ${JSON.stringify(scope)})[0];
    if (!el) return false; el.focus(); el.value = ${JSON.stringify(value)};
    el.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`;
  await waitFor(page, js, [], `${selector} "${name}"`);
}

/** Waits until some shown element matching `selector` has text matching `text` (a string or RegExp source). */
export function waitForText(page, selector, text, { exact = false, scope } = {}) {
  const match = text instanceof RegExp ? `new RegExp(${JSON.stringify(text.source)}).test(t)` : exact ? `t === ${JSON.stringify(text)}` : `t.includes(${JSON.stringify(text)})`;
  const js = `${finder}(${JSON.stringify(selector)}, "", false, ${JSON.stringify(scope)}).some((el) => { const t = el.textContent.trim(); return ${match}; })`;
  return waitFor(page, js, [], `${selector} with text ${text}`);
}

// The page in headless Chrome against its own backend (port 47941, scratch directory, DEVICEDOCK_TEST=1): log in,
// share the browser mock, PING -> PONG, binary bytes, revoke, unplug and share again.
//   deno test --allow-all tests/browser/            (DEVICEDOCK_BIN=path/to/devicedock tests that binary instead)
import assert from "../assert.js";
import { click, count, fill, launchChrome, openPage, startBackend, waitForNone, waitForText } from "./browser.js";

Deno.test({
  name: "browser mock: expose, PING/PONG, binary, revoke, unplug, reconnect",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    const backend = await startBackend({ port: 47941 });
    const browser = await launchChrome();
    try {
      const { page, errors } = await openPage(browser, await backend.loginUrl(), { width: 1440, height: 1100 });
      await waitForText(page, ".status-text", "Browser bridge online", { exact: true });
      await click(page, "button", "Add mock");
      await waitForText(page, ".badge", "Private", { exact: true });
      await click(page, "button", "Open & share");
      await waitForText(page, ".badge", "Shared", { exact: true });
      await click(page, "button", "Send input");
      await waitForText(page, ".monitor-log", "PONG");
      await click(page, "input[type=checkbox]", "Hexadecimal");
      await fill(page, "textarea", "Serial input", "00 ff 80 01");
      await click(page, "button", "Send input");
      await waitForText(page, ".monitor-log", "00 ff 80 01");
      await click(page, "button", "Revoke access");
      await waitForNone(page, "button", "Send input");
      assert.equal(await count(page, "button", "Revoke access"), 0);
      await click(page, "button", "Open & share");
      await click(page, "button", "Simulate unplug");
      await waitForText(page, "[role=alert]", "Mock unplugged");
      await click(page, "button", "Open & share");
      await waitForText(page, ".device small", /generation 4/);
      assert.deepEqual(errors, [], "page errors");
    } finally {
      await browser.close();
      await backend.stop();
    }
  },
});

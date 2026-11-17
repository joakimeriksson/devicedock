// The Shared folders panel against its own backend (port 47943, scratch directory, DEVICEDOCK_TEST=1) with a fake
// home folder: browse, refuse the home folder and hidden folders, share, read-only, remove. It never clicks "Restart
// sandbox", so a running DeviceDock sandbox is not touched.
//   deno test --allow-all tests/browser/
import assert from "node:assert/strict";
import { click, count, fill, launchChrome, openPage, startBackend, waitFor, waitForText } from "./browser.js";

Deno.test({
  name: "shared folders: browse, refuse home and hidden folders, share, read-only, remove",
  sanitizeResources: false,
  sanitizeOps: false,
  async fn() {
    let home = "";
    const backend = await startBackend({
      port: 47943,
      env: (dir) => ({ HOME: (home = `${dir}/home`) }),
      setup: async (dir) => {
        for (const d of ["home/work/proj", "home/work/other", "home/.ssh", "home/Library"]) await Deno.mkdir(`${dir}/${d}`, { recursive: true });
      },
    });
    const stored = async () => JSON.parse(await Deno.readTextFile(`${backend.dir}/.runtime/shares.json`)).shares;
    const browser = await launchChrome();
    try {
      const { page, errors } = await openPage(browser, await backend.loginUrl(), { width: 1440, height: 1300 });
      // Shared folders live on the settings page.
      await click(page, "nav a", "Settings");
      const scope = "section.shares";
      await waitForText(page, `${scope} header`, "Shared folders");

      // Browse from the fake home: hidden folders and Library are not listed, home itself cannot be shared.
      await click(page, "button", "Add a folder…", { scope });
      await waitForText(page, ".share-crumb code", "~", { exact: true });
      const names = await page.evaluate(`[...document.querySelectorAll("section.shares .share-dirs button")].map((b) => b.textContent.trim())`);
      assert.deepEqual(names, ["work"], "home listing");
      assert.equal(await page.evaluate(`[...document.querySelectorAll("section.shares button")].find((b) => b.textContent.trim() === "Share ~").disabled`), true, "home is shareable");
      await waitForText(page, scope, "whole home folder");

      // Into ~/work/proj and share it.
      await click(page, ".share-dirs button", "work", { scope });
      await click(page, ".share-dirs button", "proj", { scope });
      await click(page, "button", "Share ~/work/proj", { scope });
      await waitForText(page, ".share-list", "~/work/proj");
      await waitForText(page, ".share-list code", "/shares/proj", { exact: true });
      let s = await stored();
      assert.ok(s.length === 1 && s[0].path === `${home}/work/proj` && !s[0].readonly, "stored share");

      // The read-only box follows the backend's answer, and the answer is stored.
      await click(page, "input[type=checkbox]", "read-only", { scope });
      await waitFor(page, `document.querySelector("section.shares .share-ro input")?.checked === true`);
      assert.equal((await stored())[0].readonly, true, "read-only not stored");

      // A typed hidden folder is refused with the reason.
      await click(page, "button", "Add a folder…", { scope });
      await fill(page, "input", "Folder path to share", "~/.ssh", { scope });
      await click(page, "button", "Share", { scope });
      await waitForText(page, scope, "Hidden folders (.ssh) are not shared");
      await click(page, "button", "Cancel", { scope });

      // Remove it again.
      await click(page, "button", "Stop sharing ~/work/proj", { scope });
      await waitForText(page, `${scope} header small`, "none", { exact: true });
      s = await stored();
      assert.equal(s.length, 0, "share not removed");
      assert.equal(await count(page, ".share-list li", "", { exact: false, scope }), 0);
      assert.deepEqual(errors, [], "page errors");
    } finally {
      await browser.close();
      await backend.stop();
    }
  },
});

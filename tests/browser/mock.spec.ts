import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
test("browser mock: expose, PING/PONG, binary, revoke, unplug, reconnect", async ({
  page,
}) => {
  await page.goto((await readFile(".runtime/session-link", "utf8")).trim());
  await expect(page.getByText("Browser bridge online")).toBeVisible();
  await page.getByRole("button", { name: "Add mock", exact: true }).click();
  await expect(page.getByText("Private", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Open & share" }).click();
  await expect(page.getByText("Shared", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Send input" }).click();
  await expect(page.getByLabel("Serial monitor")).toContainText("PONG");
  await page.getByRole("checkbox", { name: "Hexadecimal" }).check();
  await page.getByLabel("Serial input").fill("00 ff 80 01");
  await page.getByRole("button", { name: "Send input" }).click();
  await expect(page.getByLabel("Serial monitor")).toContainText("00 ff 80 01");
  await page.getByRole("button", { name: "Revoke access" }).click();
  await expect(page.getByRole("button", { name: "Send input" })).toHaveCount(0);
  await page.getByRole("button", { name: "Open & share" }).click();
  await page.getByRole("button", { name: "Simulate unplug" }).click();
  await expect(page.getByRole("alert")).toContainText("Mock unplugged");
  await page.getByRole("button", { name: "Open & share" }).click();
  await expect(page.getByText(/generation 4/)).toBeVisible();
});

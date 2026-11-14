import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkInput } from "../../apps/web/src/terminalInput.ts";

test("short input is sent as one piece", () => {
  assert.deepEqual(chunkInput("ls -la\r"), ["ls -la\r"]);
  assert.deepEqual(chunkInput(""), []);
});

test("a long paste is split under the backend limit and rejoins exactly", () => {
  const paste = "\x1b[200~" + "line of a pasted log 0123456789\n".repeat(2000) + "\x1b[201~";
  const pieces = chunkInput(paste);
  assert.ok(pieces.length > 1);
  for (const p of pieces) assert.ok(p.length <= 4096 && p.length <= 8192);
  assert.equal(pieces.join(""), paste);
});

test("surrogate pairs (emoji) are never split", () => {
  const paste = "a" + "😀".repeat(5000);
  const pieces = chunkInput(paste, 4096);
  assert.equal(pieces.join(""), paste);
  for (const p of pieces) {
    assert.ok(!/[\ud800-\udbff]$/.test(p), "piece ends in a lone high surrogate");
    assert.ok(!/^[\udc00-\udfff]/.test(p), "piece starts with a lone low surrogate");
  }
});

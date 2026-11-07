import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mergeManaged, LEGACY_SHA256, VERSION } from "../../sandbox/bridge-service/instructions.ts";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const has = (s: string, text: string) => s.includes(text);

test("a missing file gets just the managed section", () => {
  const out = mergeManaged(undefined, "# Hardware\nuse device list");
  assert.ok(out.startsWith(`<!-- devicedock:begin v${VERSION} -->`));
  assert.ok(out.trimEnd().endsWith("<!-- devicedock:end -->"));
  assert.ok(has(out, "use device list"));
});

test("the section is refreshed in place, and the user's text above and below is untouched", () => {
  const old = "# My project\nnotes\n\n<!-- devicedock:begin v1 -->\nOLD TEXT\n<!-- devicedock:end -->\n\n## My own rules\nbe nice\n";
  const out = mergeManaged(old, "NEW TEXT");
  assert.ok(has(out, "# My project\nnotes"));
  assert.ok(has(out, "## My own rules\nbe nice"));
  assert.ok(has(out, "NEW TEXT"));
  assert.ok(!has(out, "OLD TEXT"));
  assert.equal(out.match(/devicedock:begin/g)!.length, 1);
  assert.equal(mergeManaged(out, "NEW TEXT"), out, "refreshing again changes nothing");
});

test("an untouched old whole-file seed is replaced; an edited one is kept and our section appended", () => {
  const seed = "old seed text\n";
  assert.equal(mergeManaged(seed, "NEW", [sha(seed)]), mergeManaged(undefined, "NEW"));
  const edited = "old seed text\nplus the user's own line\n";
  const out = mergeManaged(edited, "NEW", [sha(seed)]);
  assert.ok(out.startsWith("old seed text\nplus the user's own line"));
  assert.ok(has(out, "NEW"));
  assert.ok(out.indexOf("plus the user's own line") < out.indexOf("devicedock:begin"));
});

test("a file with unrelated content gets the section appended, with a blank line between", () => {
  const out = mergeManaged("# Mine\nhello", "NEW");
  assert.ok(out.startsWith("# Mine\nhello\n\n<!-- devicedock:begin"));
});

test("the fingerprint of the first shipped seed is registered", () => {
  assert.ok(LEGACY_SHA256.every((h) => /^[0-9a-f]{64}$/.test(h)));
  assert.equal(LEGACY_SHA256.length, 1);
});
